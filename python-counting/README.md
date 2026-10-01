# Python Counting — Detection Pipeline (Triton edition)

Satu container per kamera (thin client CPU-only) + satu **NVIDIA Triton
Inference Server** per host. Deteksi yang didukung: person counting
(line-crossing / zone), APD/PPE, fire & smoke, face recognition
(insider/intruder), dan intrusion (zona + jam).

Container kamera dibuat, dikonfigurasi, dan dinyalakan oleh dashboard (area
**Detection**, lihat [../dashboard/README.md](../dashboard/README.md)). File ini
menjelaskan cara kerja pipeline, setup model, env, tools, dan troubleshooting.

- Model repository Triton: [models/README.md](models/README.md)
- Windows/WSL2: [docs/windows-wsl2.md](docs/windows-wsl2.md)

---

## 1. Alur per frame

```
RTSP ─► LatestFrameCapture (reader thread, capture.py)
          │  terus decode di kecepatan kamera; frame lama dibuang SETELAH
          │  ter-decode utuh → loop selalu dapat frame terbaru, tanpa tearing
          ▼
        resize SCREEN_RESOLUTION / auto ─► CROP_AREA
          ▼
        letterbox ─► tensor uint8 NHWC (atau FP32 NCHW utk model lama)
          ▼
        gRPC infer ─► Triton (dynamic batching menggabungkan frame banyak kamera)
          ▼
        decode output e2e [N,300,6]  (fallback: raw head + NMS numpy)
          ▼
        ByteTrack lokal (tracking/, vendored dari ultralytics, tanpa torch)
          │  box "coasting" 2 frame supaya box tidak berkedip saat 1 frame miss
          ▼
        ├─ counting state machine (counting.py) ─► person_inout, inout_resample, MQTT
        ├─ APD (detection/apd.py)              ─► apd_hourly, MQTT
        ├─ fire/smoke (detection/firesmoke.py) ─► firesmoke_hourly, MQTT
        ├─ face (detection/face.py)            ─► face_hourly, MQTT
        ├─ intrusion (detection/intrusion.py)  ─► intrusion_hourly, MQTT
        └─ MJPEG annotated :STREAM_PORT, bbox json (outputs/)
```

Tulis DB lewat worker async, publish gambar MQTT lewat worker thread (encode
JPEG tidak menahan loop).

### Struktur folder

| Path | Isi |
|---|---|
| `main.py` | Orchestrator: capture loop, wiring detektor, degraded mode, log FPS |
| `capture.py` | `LatestFrameCapture` — reader thread untuk sumber live (rtsp/http) |
| `counting_config.py` | Parsing semua env |
| `counting.py` | State machine line-crossing / zone |
| `lifecycle.py` | Restore count, reset tengah malam, rotasi jam, pregenerasi tabel hourly |
| `detection/` | `apd.py`, `firesmoke.py`, `face.py`, `intrusion.py` |
| `inference/` | `triton_client.py` (YOLO), `triton_embed_client.py` (ArcFace), `preprocessing.py`, `postprocessing.py` |
| `tracking/` | ByteTrack (numpy/lapx) |
| `outputs/` | DB worker, `hourly_aggregate_db.py`, `face_db.py`, `mqtt_out.py`, MJPEG, `bbox_writer.py` |
| `models/` | Triton model repository (ONNX di git, `.plan` dibuild on-device) |
| `tools/` | Export/build model + monitoring/recording (lihat §6) |
| `tests/` | Test plain-script (lihat §7) |
| `init_db.py` | Membuat semua tabel (idempotent) |
| `env_example` | Contoh `.env_<CODE>` |
| `docker-compose.yml` | `triton` + `triton-model-builder`; service kamera ditambahkan dashboard |

---

## 2. Setup

### 2.1 Database

```bash
PG_HOST=<host> PG_PORT=5435 PG_DB=postgres PG_USER=postgres PG_PASS=<pass> python init_db.py
```

| Tabel | Isi |
|---|---|
| `person_inout` | Total harian per device |
| `inout_resample` | Per jam (`interval_in/out`), **`hour_start` disimpan UTC**, 24 row/hari dipregenerate |
| `apd_hourly` / `firesmoke_hourly` / `face_hourly` / `intrusion_hourly` | Satu row per (device, jam), counter di `data JSONB`, mis. `{"NO-Hardhat": 10, "unique_persons": 8}` |
| `known_faces` | Roster wajah: `person_name`, `embedding REAL[512]`, `variant_type` (satu orang = banyak varian augmentasi) |

Increment memakai `jsonb_set(... +1)` dengan label sebagai bound parameter.
Tabel hourly deteksi tambahan hanya dipregenerate kalau fiturnya enabled.

### 2.2 Model (person counting)

Model produksi: **`yolo26s_640_e2e_u8`** (default dashboard) dan
**`yolo26s_1280_e2e_u8`** untuk kamera yang butuh resolusi tinggi (mis. gate
dengan orang kecil/berdempetan). Nama: `<weights>_<imgsz>_e2e_u8`.

```bash
cd python-counting

# 1. Image export (satu-satunya image ber-torch)
docker build -f tools/Dockerfile.export -t yolo-export tools/

# 2. Export ONNX end-to-end (NMS-free, aman untuk batching).
#    Taruh di luar models/ dulu — Triton me-load SEMUA folder di models/.
mkdir -p ../model-sources
docker run --rm -v "$(pwd)/..:/work" yolo-export \
  --weights /work/python-counting/yolo26s.pt --imgsz 640 \
  --name yolo26s_640_e2e --out-dir /work/model-sources

# 3. Tambah input uint8 NHWC (Cast→/255→Transpose di dalam graph)
docker run --rm -v "$(pwd)/..:/work" --entrypoint python yolo-export \
  /work/python-counting/tools/make_uint8_input.py \
  --src /work/model-sources/yolo26s_640_e2e --dst /work/python-counting/models/yolo26s_640_e2e_u8

# 4. Build TensorRT engine di device ini (baca imgsz + input_layout dari metadata.json)
docker compose --profile build run --rm triton-model-builder
docker compose restart triton
curl -s -X POST localhost:8000/v2/repository/index      # semua model READY

# 5. WAJIB: cek batch — semua frame dalam satu batch harus dapat deteksi
docker run --rm --network envisions -v "$(pwd):/app" -w /app \
  python-counting-services-python-1:latest \
  python tools/batch_check.py --model yolo26s_640_e2e_u8 frames/a.jpg frames/b.jpg frames/c.jpg
```

Setelah build, cek `models/<model>/config.pbtxt`:

```
max_batch_size: 8
dynamic_batching { max_queue_delay_microseconds: 1000 }
```

`build_engine.sh` menulis delay 5000 µs; di server produksi diturunkan ke
1000 µs (latency lebih rendah, batch tetap terisi dari 14 kamera). Restart
Triton setelah edit config.

> **Jangan** export dengan `nms=True` ultralytics: NMS-nya hanya mengisi
> deteksi untuk gambar pertama di batch. Dengan dynamic batching, kamera lain
> di batch yang sama mendapat hasil kosong (≈ separuh frame tanpa deteksi).
> `export_model.py` sudah selalu `nms=False` dan mendeteksi e2e dari shape output.

Model lama/eksperimen simpan di luar `models/` (di server: `/data/model-sources/old/`)
supaya tidak memakan VRAM. Bandingkan dua model dengan `tools/compare_models.py`.

### 2.3 Model deteksi tambahan

Langkahnya sama (export → build → restart). Bobot yang dipakai produksi:

```bash
# APD (VoxDroid Construction-Site-Safety, MIT)
curl -sL -o apd_best.pt "https://raw.githubusercontent.com/VoxDroid/Construction-Site-Safety-PPE-Detection/main/Model-Training/Outputs/runs/detect/yolov8s_ppe_css_200_epochs/weights/best.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/apd_best.pt --imgsz 640 --name apd_640 --out-dir /work/models

# Fire/smoke (luminous0219, AGPL-3.0)
curl -sL -o firesmoke_best.pt "https://raw.githubusercontent.com/luminous0219/fire-and-smoke-detection-yolov8/main/weights/best.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/firesmoke_best.pt --imgsz 640 --name fire_smoke_640 --out-dir /work/models

# Face detector (akanametov/yolo-face, GPL-3.0)
curl -sL -o yolov8n-face.pt "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/yolov8n-face.pt --imgsz 640 --name face_640 --out-dir /work/models

# ArcFace embedder (InsightFace buffalo_l, riset/non-komersial) — ONNX langsung
curl -sL -o buffalo_l.zip "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
unzip -o buffalo_l.zip w600k_r50.onnx
mkdir -p models/arcface_112/1 && mv w600k_r50.onnx models/arcface_112/1/model.onnx
printf 'platform: "onnxruntime_onnx"\nmax_batch_size: 0\n' > models/arcface_112/config.pbtxt
# max_batch_size WAJIB 0: batch dim ONNX-nya fixed [1,3,112,112]

docker compose --profile build run --rm triton-model-builder && docker compose restart triton
```

(PowerShell: ganti `"$(pwd)"` jadi `"${PWD}"`, `curl -o` jadi `Invoke-WebRequest -OutFile`.)

APD/fire-smoke/face memakai model YOLOv8 dengan output raw; client menjalankan
NMS numpy dan request-nya tidak di-batch dengan model person.

### 2.4 Image kamera & Triton

```bash
docker compose up -d triton
docker build -t python-counting-services-python-1:latest .
```

Service kamera (`services-python-<code>`) ditambahkan dashboard ke
`docker-compose.yml`, dengan `env_file: .env_<CODE>`, network `envisions`, dan
folder ini di-bind-mount ke `/app`. Artinya **update kode Python cukup
`git pull` + restart container**, rebuild image hanya kalau `requirements.txt`
atau `dockerfile` berubah. Ganti `.env_<CODE>` butuh recreate:

```bash
docker compose up -d --no-deps services-python-cctv-epw-s27
```

---

## 3. Detection types

### 3.1 Person counting (selalu aktif)

`DETECTION_MODE=line_crossing` (garis `lineA..`) atau `zone` (polygon
`zoneA..`), digambar di dashboard → Detection → Devices → tab Lines. Output:
`person_inout`, `inout_resample`, MQTT event per orang + interval 5 menit.

Kalibrasi garis manual di resolusi asli: `python tools/calibrate_lines.py
--source <rtsp|mp4> --target-res 800x600`.

### 3.2 APD / PPE

Tracker sendiri; satu track_id memicu maksimal satu event per label
pelanggaran. Output `apd_hourly` (+`unique_persons`), MQTT `MQTT_APD_TOPIC`
dengan crop. Env: `APD_ENABLED`, `APD_MODEL`, `APD_CONFIDENCE`, `APD_TAG`.

### 3.3 Fire & smoke

Tanpa tracker; cooldown per label (`FIRE_SMOKE_COOLDOWN_MINUTES`, default 5).
Saat tidak ada penonton MJPEG, inference di-sample 1 fps. Output
`firesmoke_hourly`, MQTT `MQTT_FIRESMOKE_TOPIC` (full frame). Env:
`FIRE_SMOKE_ENABLED`, `FIRE_SMOKE_MODEL`, `FIRE_SMOKE_CONFIDENCE`, `FIRE_TAG`,
`SMOKE_TAG`, `FIRE_SMOKE_COOLDOWN_MINUTES`.

### 3.4 Face recognition (insider / intruder)

```
frame ─► YOLOv8-face ─► ByteTrack ─► gate ukuran (FACE_MIN_SIZE..FACE_MAX_SIZE)
      ─► buffer FACE_CAPTURE_FRAMES sighting/track, pilih best-shot
         (ukuran, ketajaman Laplacian, confidence, pencahayaan)
      ─► crop + margin FACE_CROP_MARGIN, upscale ≥ FACE_CROP_MIN_SIZE
      ─► ArcFace 512-d ─► cosine vs cache known_faces (refresh FACE_CACHE_REFRESH_MINUTES)
      ─► ≥ FACE_MATCH_THRESHOLD → nama (INSIDER_TAG), selain itu "intruder" (INTRUDER_TAG)
      ─► face_hourly + MQTT_FACE_TOPIC
```

Satu track = satu verdict. Enrollment dilakukan di dashboard (Face
Enrollment), dan model embed di Settings **harus sama** dengan
`FACE_EMBED_MODEL` kamera.

Env: `FACE_ENABLED`, `FACE_MODEL`, `FACE_EMBED_MODEL`, `FACE_CONFIDENCE` (0.5),
`FACE_MATCH_THRESHOLD` (0.5), `FACE_CACHE_REFRESH_MINUTES` (10),
`FACE_CAPTURE_FRAMES` (5), `FACE_MIN_SIZE` (40 px), `FACE_MAX_SIZE` (0 = tanpa
batas), `FACE_CROP_MARGIN` (0.25), `FACE_CROP_MIN_SIZE` (112), `INSIDER_TAG`,
`INTRUDER_TAG`.

Tuning untuk sudut sulit, urut dari termurah: `CROP_AREA` lebih sempit →
`SCREEN_RESOLUTION=auto` → model face `imgsz` 1280 → model face lebih besar
(s/m/l).

### 3.5 Intrusion

Tanpa model sendiri: memakai track person utama. Event saat orang berada di
zona (`INTRUSION_DETECTION_MODE=zone`, `intrusionZoneA..`) atau melintasi garis
(`line_crossing`, `intrusionLineA..`) dalam rentang jam
`intrusionTimeA='22:00-06:00'`, dst. (kosong = selalu aktif). Satu event per
track. Output `intrusion_hourly`, `MQTT_INTRUSION_TOPIC`. Env tambahan:
`INTRUSION_ENABLED`, `INTRUSION_TAG`.

### 3.6 Restriction zone APD / Face

`apdZoneA..` / `faceZoneA..` membatasi area deteksi APD/Face. Kalau tidak
digambar: ikut `zoneA..` bila `DETECTION_MODE=zone`, atau tanpa batas bila
`line_crossing`. Deteksi di luar zona di-skip sebelum ArcFace dipanggil.

---

## 4. MQTT

| Env | Default | Payload |
|---|---|---|
| `MQTT_TOPIC` | template settings, mis. `/person_in/{code}` | event in/out + crop |
| `MQTT_INTERVAL_TOPIC` | `/resampling_person/{code}` | interval 5 menit |
| `MQTT_APD_TOPIC` | `{MQTT_TOPIC}/apd` | APD + crop pelanggar |
| `MQTT_FIRESMOKE_TOPIC` | `{MQTT_TOPIC}/firesmoke` | fire/smoke + full frame |
| `MQTT_FACE_TOPIC` | `{MQTT_TOPIC}/face` | verdict + crop wajah |
| `MQTT_INTRUSION_TOPIC` | `{MQTT_TOPIC}/intrusion` | intrusion + crop |

Payload event: `device_id/code/name`, `timestamp`, `event`, `type`, `tag`
(`info`/`alarm`), `label`, `confidence`, `track_id`, `image` (JPEG base64).

---

## 5. Env per kamera (`.env_<CODE>`)

Ditulis ulang dashboard setiap device disimpan. Contoh lengkap: [`env_example`](env_example).

| Kelompok | Variabel |
|---|---|
| Identitas | `DEVICE_ID`, `DEVICE_NAME`, `DEVICE_CODE` |
| DB | `PG_HOST/PORT/DB/USER/PASS` |
| MQTT | `MQTT_BROKER/PORT/USERNAME/PASSWORD` + topic §4 |
| Stream | `RTSP_URL`, `SCREEN_RESOLUTION` (`[W, H]` atau `auto` = resolusi asli), `CROP_AREA`, `ANNOTATED_STREAM`, `STREAM_PORT`, `STREAM_JPEG_QUALITY`, `JPEG_QUALITY` |
| Inference | `TRITON_MODEL` (mis. `yolo26s_640_e2e_u8`), `YOLO_CONFIDENCE` (0.3), `YOLO_IOU` (hanya model raw). `TRITON_URL` di-inject compose (`triton:8001`) |
| Counting | `DETECTION_MODE`, `lineA..` / `zoneA..`, `POINT_AXIS`, `SWAP_IN_OUT`, `MERGE_GATES` |
| Tambahan | `APD_*`, `FIRE_SMOKE_*`, `FACE_*`, `INTRUSION_*`, `apdZone*`, `faceZone*`, `intrusionZone*/Line*/Time*` |
| Dev | `DEBUG_MODE` (DB/MQTT jadi no-op), `FALLBACK_VIDEO` (baca file video, bukan RTSP) |
| Deprecated (diabaikan) | `YOLO_MODEL` (dipetakan ke `TRITON_MODEL`), `YOLO_IMGSZ`, `ENABLE_NVDEC`, `YOLO_DEVICE` |

`SCREEN_RESOLUTION` menentukan koordinat line/zone. Kalau diganti, gambar
ulang garisnya.

Stabilitas box: ByteTrack hanya memakai deteksi skor rendah di tahap kedua
bila `YOLO_CONFIDENCE` < `track_high_thresh` (0.25, `tracking/config.py`). Kalau box sering
berkedip di keramaian, coba `YOLO_CONFIDENCE=0.1`. Ini belum dipakai di
produksi.

---

## 6. Tools

| Tool | Jalan di | Fungsi |
|---|---|---|
| `tools/export_model.py` (+`Dockerfile.export`) | image `yolo-export` | `.pt` → ONNX + `metadata.json`, selalu `nms=False` |
| `tools/make_uint8_input.py` | image `yolo-export` | Tambah input uint8 NHWC ke ONNX |
| `tools/build_engine.sh` | `triton-model-builder` | ONNX → TensorRT `.plan`, tulis `config.pbtxt` (`FORCE_BUILD=1` untuk rebuild, `TRT_BACKEND=onnx` untuk mode CPU) |
| `tools/batch_check.py` | image kamera, network `envisions` | Pastikan model memberi deteksi untuk **semua** gambar dalam satu batch |
| `tools/compare_models.py` | image kamera | Bandingkan deteksi dua model di frame yang sama (`--show-extra`) |
| `tools/stream_health.py` | host (stdlib) | Per menit dari log container: FPS, stale frame yang di-drop, error decode (tearing). `--since 3h` / `--follow` |
| `tools/resource_monitor.py` | host (stdlib) | CPU container, GPU util/power/throttle, antrian & latency Triton per model |
| `tools/record_all_cameras.py` | host / image kamera | Rekam semua (atau `--devices`) kamera ke `recordings/` di resolusi asli (mp4v) |
| `tools/record_camera_test.py` | image kamera | Rekam satu kamera + MJPEG preview |
| `tools/calibrate_lines.py` | lokal (GUI OpenCV) | Gambar garis di resolusi asli, skala ke resolusi target |

Replay rekaman: set `FALLBACK_VIDEO=/app/recordings/<file>.mp4` di container uji
(mengalahkan `RTSP_URL`). Sumber file dibaca apa adanya, tanpa reader thread.

---

## 7. Development & testing

```bash
pip install -r requirements.txt
FALLBACK_VIDEO=1.mp4 DEBUG_MODE=true python main.py
```

Test berupa script biasa (exit 0 = lulus):

```bash
for t in tests/test_*.py; do python "$t" || echo "FAIL $t"; done
```

| Test | Isi |
|---|---|
| `test_capture` | Reader thread: frame terbaru, drop count, release |
| `test_preprocess` | Letterbox + path uint8/FP32 |
| `test_auto_resolution` | `SCREEN_RESOLUTION=auto` |
| `test_detection_events` | Dedup APD, cooldown fire/smoke, routing topic |
| `test_hourly_aggregate` | Bentuk SQL increment/pregenerate |
| `test_face_detection` | Dedup, best-shot, cosine match |
| `test_intrusion` | Zona/garis + rentang jam |
| `test_zone_restriction` | Resolusi zona APD/Face |
| `test_image_utils` | Crop util |
| `test_parity` | Letterbox/NMS/ByteTrack vs ultralytics (**butuh torch**, dev only) |
| `test_e2e_smoke`, `test_firesmoke_e2e_smoke` | Loop `main.py` penuh di `1.mp4` dengan YOLO lokal via torch, tanpa Triton (**butuh torch**, dev only) |

Di image produksi semua lulus kecuali dua smoke test e2e (image tidak berisi
torch).

---

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| **Tearing / gambar pecah**, `error while decoding MB` di log | Loop lebih lambat dari kamera → data menumpuk di socket → TCP backpressure → kamera/NVR membuang data di tengah frame. Sudah ditangani `LatestFrameCapture`. Kalau masih ada: cek `stream_health.py`. Kalau error decode muncul padahal `dropped` kecil, masalahnya di jaringan/kamera (bitrate, Wi-Fi, NVR overload). `CAP_PROP_BUFFERSIZE` tidak berpengaruh di backend FFmpeg. |
| Semua kamera FPS drop bersamaan beberapa detik | Disk lambat. Di HDD, journal ext4 (jbd2) memblok `open()/rename()` file bbox semua kamera. Pindahkan `/opt/ai` + data Docker/containerd ke SSD/NVMe. |
| ±separuh frame tanpa deteksi, box berkedip di semua kamera | Model export `nms=True` + dynamic batching (hanya index 0 yang terisi). Pakai model `*_e2e_u8`, cek `batch_check.py`. |
| Mengira batching mati padahal aktif | Dengan `--strict-model-config=false`, Triton otomatis menyalakan dynamic batching. Satu-satunya cara mematikan: `max_batch_size: 1`. |
| Menambah `instance_group count` tidak menaikkan FPS | Antrian berasal dari delay batching + GPU yang memang serial. Turunkan `max_queue_delay_microseconds` atau pakai model lebih ringan. |
| FPS rendah setelah naik ke 1280 | Biaya ~4× per frame. Cek watt GPU (kartu GPU di Detection → Dashboard). RTX 2000 Ada dibatasi 70 W, jadi ≥ 90% berarti GPU sudah penuh. |
| Model jalan di CPU, GPU idle | `config.pbtxt` masih `onnxruntime`. Jalankan model-builder lalu restart Triton. |
| `.env` diubah tapi tidak berefek | `docker restart` tidak membaca ulang `env_file`. Pakai `docker compose up -d --no-deps <service>`. |
| `INFERENCE UNAVAILABLE` | Triton down. Container tidak crash, backoff 1s→30s. Cek `curl :8000/v2/health/ready`. |
| `set: pipefail` invalid di build | `build_engine.sh` ter-checkout CRLF. Ubah ke LF. |
| Wajah ter-enroll tapi tetap "intruder" | Tunggu refresh cache (≤10 menit), cek `FACE_MATCH_THRESHOLD`, dan pastikan model embed enrollment == `FACE_EMBED_MODEL`. |
| `docker logs --since` meleset beberapa jam | Timestamp tanpa `Z` dianggap waktu lokal. Pakai `2026-09-28T04:00:00Z`. |
