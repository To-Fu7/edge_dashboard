# 4. Model

## Tujuan

Folder `python-counting/models/` berisi model yang siap dipakai Triton:
ONNX dengan input uint8, dan engine TensorRT (`model.plan`) yang dibuild di
GPU server ini.

## Alur

```
yolo26s.pt ──export_model.py──► model-sources/yolo26s_640_e2e/      (ONNX, input float)
           ──make_uint8_input.py──► models/yolo26s_640_e2e_u8/      (ONNX, input uint8)
           ──build_engine.sh──► models/yolo26s_640_e2e_u8/1/model.plan  (TensorRT)
           ──batch_check.py──► pastikan semua frame dalam satu batch dapat deteksi
```

Model yang dipakai produksi:

| Model | Untuk |
|---|---|
| `yolo26s_640_e2e_u8` | Default semua kamera |
| `yolo26s_1280_e2e_u8` | Kamera yang orangnya kecil / berdempetan (mis. gate). Biaya GPU ±4× |

> **Triton me-load SEMUA folder di `models/` ke VRAM.** Simpan hasil
> antara dan model yang tidak dipakai di luar `models/` (contoh di bawah:
> `../model-sources/`).

## Langkah

Semua perintah dari folder `python-counting/`.

### 1. Siapkan bobot

Taruh `yolo26s.pt` (atau bobot lain) di `python-counting/`. Bobot resmi
YOLO26 bisa diunduh dari halaman release Ultralytics.

### 2. Export ke ONNX

```bash
cd /opt/ai/dashboard-python-counting/python-counting
mkdir -p ../model-sources
docker run --rm -v "$(pwd)/..:/work" yolo-export \
  --weights /work/python-counting/yolo26s.pt --imgsz 640 \
  --name yolo26s_640_e2e --out-dir /work/model-sources
```

Untuk versi 1280 ganti `--imgsz 1280 --name yolo26s_1280_e2e`.

### 3. Tambah input uint8

```bash
docker run --rm -v "$(pwd)/..:/work" --entrypoint python yolo-export \
  /work/python-counting/tools/make_uint8_input.py \
  --src /work/model-sources/yolo26s_640_e2e \
  --dst /work/python-counting/models/yolo26s_640_e2e_u8
```

### 4. Build engine TensorRT

```bash
docker compose --profile build run --rm triton-model-builder
```

Builder membaca `imgsz` dan `input_layout` dari `metadata.json` tiap model,
lalu menulis `model.plan` dan `config.pbtxt`. Engine **hanya berlaku untuk GPU
dan versi TensorRT tempat ia dibuild**. Pindah GPU atau ganti tag Triton =
build ulang dengan `FORCE_BUILD=1`:

```bash
docker compose --profile build run --rm -e FORCE_BUILD=1 triton-model-builder
```

Mode CPU (tanpa GPU): lewati langkah ini; Triton memakai onnxruntime.

### 5. Atur batching

Buka `models/yolo26s_640_e2e_u8/config.pbtxt`, pastikan:

```
max_batch_size: 8
dynamic_batching {
  max_queue_delay_microseconds: 1000
}
```

Builder menulis delay 5000 µs; produksi memakai 1000 µs (latensi lebih
rendah, batch tetap terisi dari banyak kamera).

### 6. Model deteksi tambahan (opsional)

Hanya kalau APD, api/asap, atau wajah akan dipakai. Langkahnya sama dengan
langkah 2 lalu 4, tanpa langkah 3:

```bash
# APD
curl -sL -o apd_best.pt "https://raw.githubusercontent.com/VoxDroid/Construction-Site-Safety-PPE-Detection/main/Model-Training/Outputs/runs/detect/yolov8s_ppe_css_200_epochs/weights/best.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/apd_best.pt --imgsz 640 --name apd_640 --out-dir /work/models

# Api / asap
curl -sL -o firesmoke_best.pt "https://raw.githubusercontent.com/luminous0219/fire-and-smoke-detection-yolov8/main/weights/best.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/firesmoke_best.pt --imgsz 640 --name fire_smoke_640 --out-dir /work/models

# Deteksi wajah
curl -sL -o yolov8n-face.pt "https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov8n-face.pt"
docker run --rm -v "$(pwd):/work" yolo-export --weights /work/yolov8n-face.pt --imgsz 640 --name face_640 --out-dir /work/models

# Pengenal wajah (ArcFace) — ONNX langsung, tanpa export
curl -sL -o buffalo_l.zip "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
unzip -o buffalo_l.zip w600k_r50.onnx
mkdir -p models/arcface_112/1 && mv w600k_r50.onnx models/arcface_112/1/model.onnx
# models/arcface_112/config.pbtxt sudah ada di repo (max_batch_size: 0)

docker compose --profile build run --rm triton-model-builder
```

Perhatikan lisensi: model api/asap AGPL-3.0, deteksi wajah GPL-3.0, ArcFace
untuk riset/non-komersial.

## Verifikasi

```bash
ls models/*/1/
# tiap model: model.onnx dan model.plan (kecuali mode CPU)
grep -H "platform\|max_batch_size" models/*/config.pbtxt
# model yang sudah dibuild: platform "tensorrt_plan"
```

Cek batch dilakukan setelah Triton jalan, di [05-triton.md](05-triton.md#verifikasi).

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| Export: `FileNotFoundError` untuk `.pt` | Path di dalam container salah | Path harus diawali `/work/...` sesuai folder yang di-mount dengan `-v` |
| Export lambat / `Killed` | RAM habis saat export | Tutup proses lain; export di mesin lain lalu salin folder hasilnya |
| `make_uint8_input.py`: `FileNotFoundError ... metadata.json` | `--src` bukan folder hasil export | Arahkan ke folder yang berisi `1/model.onnx` dan `metadata.json` |
| Builder: `set: pipefail: invalid option` | `build_engine.sh` ter-checkout dengan line ending CRLF (Windows) | `sed -i 's/\r$//' tools/build_engine.sh`, atau `git config core.autocrlf false` lalu checkout ulang |
| Builder: `trtexec: command not found` | Image builder bukan image Triton | Jalankan lewat `docker compose --profile build run` (bukan `docker run` image lain) |
| Builder gagal `out of memory` | VRAM habis karena Triton sedang jalan | `docker compose stop triton`, build, lalu start lagi |
| Builder melewati model ("up to date") padahal mau rebuild | `model.plan` lebih baru dari `model.onnx` | Pakai `-e FORCE_BUILD=1` |
| Builder di dashboard gagal "file not found" untuk file yang ada | `HOST_PYTHON_COUNTING_DIR` salah | Lihat [06-dashboard.md](06-dashboard.md#kalau-error) |
| Pernah export dengan `nms=True` | Sebagian frame dalam batch kosong (box berkedip di semua kamera) | Export ulang dengan `export_model.py` dari repo ini (sudah selalu `nms=False`) |
