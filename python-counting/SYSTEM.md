# Cara Kerja Sistem python-counting

Dokumen ini menjelaskan **bagaimana sistem bekerja dari dalam**: alur data,
tugas tiap modul, state yang disimpan, dan aturan yang tidak boleh dilanggar.
Ditulis untuk manusia yang baru pegang kode ini **dan** untuk AI asisten yang
diminta mengubahnya.

- Cara setup, model, env lengkap, tools, troubleshooting → [README.md](README.md)
- Model repository Triton → [models/README.md](models/README.md)

---

## 1. Gambaran besar dalam 30 detik

Satu **container per kamera** menjalankan `main.py`. Container ini *tidak*
punya GPU. Ia hanya:

1. membaca video dari kamera (RTSP),
2. mengirim tiap frame ke **Triton** (server GPU bersama semua kamera) untuk
   dideteksi,
3. melacak orang antar frame (ByteTrack),
4. memutuskan apakah ada kejadian (orang masuk/keluar, pelanggaran APD, api,
   wajah, penyusup),
5. mencatat kejadian ke **PostgreSQL** dan mengirimnya ke **MQTT**.

```
            ┌──────────────── container kamera (CPU) ────────────────┐
 Kamera ──► │ capture ─► preprocess ─► [gRPC] ─► decode ─► tracker   │
            │                            │                  │        │
            │                            ▼                  ▼        │
            │                      Triton (GPU)     counting / detection
            │                                               │        │
            │                       PostgreSQL ◄── db_worker ┤        │
            │                       MQTT       ◄── mqtt_out ─┤        │
            │                       Dashboard  ◄── mjpeg / bbox json  │
            └────────────────────────────────────────────────────────┘
```

Konfigurasi kamera disimpan di **PostgreSQL** (database `edge`, tabel
`devices`) dan diatur dari dashboard. Saat container start, `bootstrap.py`
mengambil config itu dan memasukkannya ke environment, jadi kode pipeline tetap
membaca `os.getenv` seperti biasa. Perubahan berikutnya datang lewat
`NOTIFY` dan diterapkan oleh `config_watch.py` tanpa perlu restart manual.

---

## 2. Perjalanan satu frame

Urutan ini persis mengikuti loop di `main.py` → `main()`.

| # | Langkah | Modul | Penjelasan singkat |
|---|---|---|---|
| 1 | Ambil frame | `capture.py` | Reader thread terus membaca kamera. Loop selalu dapat **frame terbaru**; frame lama dibuang. |
| 2 | Lewati frame | `main.py` | `FRAME_SKIP` (default 2) = proses 1 dari tiap N frame. `FPS_LIMIT` membatasi kecepatan. |
| 3 | Resize | `main.py` | Ke `SCREEN_RESOLUTION` (mis. 800×600), atau tidak di-resize kalau `auto`. **Semua koordinat line/zone memakai ruang ini.** |
| 4 | Crop | `main.py` | Potong ke `CROP_AREA`. Hanya area ini yang dikirim ke model. |
| 5 | Preprocess | `inference/preprocessing.py` | Letterbox (resize + padding abu-abu) ke ukuran input model, jadi tensor uint8 atau float. |
| 6 | Inference | `inference/triton_client.py` | Kirim tensor ke Triton lewat gRPC, terima deteksi. |
| 7 | Decode | `inference/postprocessing.py` | Output model → daftar box `[x1,y1,x2,y2,conf,cls]` di koordinat frame crop. |
| 8 | Tracking | `tracking/` | ByteTrack memberi **track_id** yang konsisten untuk orang yang sama antar frame. |
| 9 | Counting | `counting.py` | Cek apakah track melewati garis / masuk zona → `person_in` / `person_out` naik. |
| 10 | Deteksi tambahan | `detection/*.py` | APD, fire/smoke, face, intrusion (kalau di-enable). |
| 11 | Output | `outputs/*.py` | DB (async), MQTT (async), MJPEG (kalau ada penonton), file bbox. |
| 12 | Rotasi waktu | `lifecycle.py` | Ganti jam → simpan hitungan per jam. Tengah malam → reset harian. |

Koordinat box selalu dikembalikan ke **frame penuh** (ditambah offset
`CROP_X1/CROP_Y1`) sebelum dipakai counting/detection.

---

## 3. Peta modul

### 3.0 Start, konfigurasi & status (container yang dikelola dashboard)

| File | Tugas | Yang perlu diketahui |
|---|---|---|
| `bootstrap.py` | **Entrypoint container.** Baca `effective_env` + `config_version` untuk `EDGE_DEVICE_ID`, isi `os.environ`, lalu jalankan `main.main()`. | Harus jalan **sebelum** `counting_config` di-import. Config terakhir disimpan di `.config-cache/<id>.json`; kalau DB mati saat start, cache dipakai. Tanpa `EDGE_DEVICE_ID` (dev lokal) ia langsung menjalankan `main` dengan env yang ada. |
| `edge_db.py` | Koneksi ke database `edge` dengan role `edge_device`. | Role ini hanya bisa membaca kolom config miliknya dan menulis hasil + `device_status`. |
| `config_watch.py` | Thread yang `LISTEN edge_config`. Saat versi config kamera ini naik: kalau semua key yang berubah ada di `HOT_KEYS`, nilainya langsung dipasang ke `cfg`; kalau tidak, `state.restart_requested` diisi. | Main loop melihat flag itu, flush antrian DB + MQTT, lalu `sys.exit(0)`; Docker (`restart: unless-stopped`) menyalakannya lagi dengan config baru. Ada poll tiap 60 detik untuk notifikasi yang terlewat. |
| `outputs/heartbeat.py` | Tulis status ke `device_status` tiap 10 detik: `running` / `degraded` (Triton mati) / `error` (kamera gagal) / `starting` / `stopping`, FPS, orang per frame, IN/OUT hari ini, versi config, error terakhir. | Dashboard menampilkannya di Dashboard dan menandai kamera yang tidak melapor > 45 detik. |

Dikelompokkan berdasarkan peran. Tiap modul punya satu tugas.

### 3.1 Inti

| File | Tugas | Yang perlu diketahui |
|---|---|---|
| `main.py` | **Orkestrator.** Inisialisasi semua komponen lalu menjalankan loop frame. | Satu-satunya tempat yang memanggil semua modul lain. Kalau loop error, ia tunggu 5 detik lalu buka ulang kamera. Tidak pernah exit karena Triton mati. |
| `counting_config.py` | **Semua konfigurasi.** Membaca env sekali saat import, jadi konstanta (`cfg.X`). | Line/zone di-parse di sini. Timezone tetap `Asia/Jakarta`. Kalau fitur di-enable tapi zona/garisnya kosong, fitur itu otomatis dimatikan dengan warning. |
| `app_state.py` | **State yang berubah saat runtime** (counter, status track, dsb.). | Selalu diakses sebagai `state.person_in`, **jangan** `from app_state import person_in` (itu menyalin nilai, perubahan tidak terlihat modul lain). |
| `lifecycle.py` | **Siklus waktu**: restore hitungan saat start, ganti jam, reset tengah malam, buat 24 row per jam tiap hari. | Dipanggil dari loop `main.py` tiap frame (pengecekan murah). |

### 3.2 Input video

| File | Tugas |
|---|---|
| `capture.py` | `LatestFrameCapture`: thread terpisah yang terus decode kamera dan menyimpan **hanya frame terakhir**. Dipakai untuk sumber live (`rtsp://`, `http://`, ...). File video (`FALLBACK_VIDEO`) dibaca biasa dengan `cv2.VideoCapture`, tanpa thread. |

**Kenapa perlu thread?** Kalau loop lebih lambat dari kamera, data menumpuk di
socket. TCP lalu menahan kamera, dan kamera/NVR membuang data di tengah frame.
Hasilnya gambar pecah (*tearing*). Reader thread menyedot data secepat kamera
mengirim, lalu membuang frame lama **setelah** utuh ter-decode. Jumlah frame
yang dibuang terlihat di log `Processing FPS: X (dropped N stale frames ...)`.

### 3.3 Inference (bicara dengan Triton)

| File | Tugas |
|---|---|
| `inference/triton_client.py` | `TritonYoloClient`: koneksi gRPC ke satu model YOLO. Saat connect, ia **membaca metadata model dari Triton** (nama input, ukuran, tipe uint8/float, format output). Jadi client menyesuaikan diri dengan model, tanpa hardcode. Frame dikirim lewat **system shared memory** (lihat bawah). |
| `inference/triton_embed_client.py` | `TritonEmbedClient`: sama, untuk ArcFace (wajah → vektor 512 angka). |
| `inference/preprocessing.py` | `letterbox()` + `preprocess()`: ubah frame jadi tensor sesuai input model. |
| `inference/postprocessing.py` | Ubah output model jadi box. Dua format didukung otomatis: **end-to-end** (`[N,300,6]`, YOLO26, sudah tanpa duplikat) dan **raw** (YOLOv8/11, perlu NMS di numpy). `unletterbox()` mengembalikan koordinat ke frame asli. |
| `inference/model_metadata.py` | Ambil nama kelas (mis. `0 → "NO-Hardhat"`) dari `models/<model>/metadata.json`. |

Kalau Triton gagal, client melempar `TritonUnavailableError`. `main.py`
menangkapnya dan masuk **degraded mode** (lihat §5).

Satu frame bisa dikirim ke beberapa model (person, APD, fire, face). Kalau
ukuran input dan tipenya sama, tensor hasil preprocess dipakai ulang lewat
`pre_cache` sehingga letterbox cukup dihitung sekali. Karena itu semua model
sebaiknya bertipe input uint8 (`make_uint8_input.py`): satu preprocess untuk
semua model, dan data per frame 4× lebih kecil daripada float.

**Shared memory.** Container kamera dan Triton sama-sama me-mount `/dev/shm`
milik host. Saat connect, client membuat region sendiri
(`/dev/shm/edge_<device id>_<model>_in` dan `_out`) lalu mendaftarkannya ke
Triton. Tiap frame, tensor ditulis ke region itu dan request gRPC hanya
menyebut namanya, jadi frame tidak perlu di-serialize ke protobuf di kedua
sisi. Di Jetson ini memangkas CPU kamera dari ~49% ke ~28% satu core dan Triton
dari ~20% ke ~15%. Kalau Triton tidak bisa membuka region (mis. `/dev/shm`
tidak di-share) atau `TRITON_SHM=off`, client otomatis kembali mengirim tensor
di dalam request; log connect menulis `transport=shared memory` atau
`transport=grpc payload`. Bandingkan keduanya dengan `tools/shm_check.py`.

### 3.4 Tracking

| File | Tugas |
|---|---|
| `tracking/byte_tracker.py` | ByteTrack: mencocokkan box frame ini dengan track frame sebelumnya, jadi orang yang sama tetap punya `track_id` yang sama. |
| `tracking/kalman_filter.py` | Memprediksi posisi berikutnya tiap track, supaya pencocokan tahan terhadap gerakan dan box yang sedikit meleset. |
| `tracking/matching.py`, `ops.py`, `basetrack.py` | Pendukung (hitung IoU, assignment). |
| `tracking/config.py` | Parameter tracker (sama dengan default ultralytics) dan wadah `Detections`. |

Folder ini disalin dari Ultralytics tanpa torch dan **sebaiknya tidak diubah**.
Hasilnya sudah diuji identik dengan `model.track()` ultralytics
(`tests/test_parity.py`).

Ada **tracker terpisah** untuk person, APD, dan face. Fire/smoke tidak pakai
tracker. Intrusion memakai track person.

### 3.5 Logika counting

`counting.py` → `process_track(track_id, box, frame)` dipanggil untuk tiap
orang di tiap frame.

**Mode `line_crossing`** (gerbang dua garis):

- Garis berpasangan: `lineA`+`lineB` = gerbang 1, `lineC`+`lineD` = gerbang 2,
  dst. Kalau hanya `lineA` yang diisi, garis kedua dibuat otomatis dengan
  geser `LINE_OFFSET_AMOUNT` piksel.
- Tiap orang punya dua titik pemicu (atas/bawah atau kiri/kanan box, diatur
  `POINT_AXIS`).
- Logikanya seperti pintu dua tahap:
  - lewat garis B dulu → "siap masuk"; lalu lewat garis A → **IN +1**
  - lewat garis A dulu → "siap keluar"; lalu lewat garis B → **OUT +1**
- `SWAP_IN_OUT=true` membalik arah. `MERGE_GATES=true` menganggap semua
  gerbang satu (orang cukup lewat satu pasang garis mana saja).

**Mode `zone`** (polygon `zoneA`, `zoneB`, ...):

- Titik tengah box masuk ke polygon dari luar → **IN +1** (event `zone_entry`).
- Tidak ada hitungan OUT di mode ini.

Setiap IN/OUT langsung: update `person_inout` (async), kirim MQTT dengan foto
crop, dan naikkan counter interval & per jam.

### 3.6 Deteksi tambahan (`detection/`)

Semua modul ini **opsional** (default mati), mengikuti pola yang sama: *terima
deteksi → cek apakah sudah pernah dilaporkan → kalau belum, naikkan tabel per
jam + kirim MQTT*.

| Modul | Model | Kapan satu event terjadi | Pencegah spam |
|---|---|---|---|
| `apd.py` | Model APD sendiri + tracker sendiri | Track terdeteksi memakai label pelanggaran (mis. `NO-Hardhat`) | Satu event per (track, label) seumur track |
| `firesmoke.py` | Model fire/smoke, tanpa tracker | Ada deteksi `fire` atau `smoke` | Cooldown per label (`FIRE_SMOKE_COOLDOWN_MINUTES`). Inference di-sample 1×/detik kalau tidak ada penonton |
| `face.py` | Model face + tracker sendiri + ArcFace | Track wajah sudah dikumpulkan beberapa kali, foto terbaik dicocokkan ke database wajah | Satu verdict per track |
| `intrusion.py` | Tidak ada model; memakai track person | Orang di zona terlarang / melintasi garis terlarang **dan** sedang dalam jam aktif | Satu event per track |

**Face lebih rinci:** wajah terlalu kecil (`FACE_MIN_SIZE`) atau terlalu besar
(`FACE_MAX_SIZE`) dilewati. Untuk tiap track, `FACE_CAPTURE_FRAMES` potongan
wajah dikumpulkan dan diberi skor (ukuran, ketajaman, confidence,
pencahayaan); hanya yang terbaik di-embed. Vektornya dibandingkan dengan
cache `known_faces` (`outputs/face_db.py`). Kalau mirip ≥
`FACE_MATCH_THRESHOLD`, verdict = nama orangnya; kalau tidak, verdict =
`intruder`.

**Restriction zone:** APD dan face bisa dibatasi ke area tertentu
(`apdZone*`, `faceZone*`). Deteksi di luar area langsung dilewati.

### 3.7 Output (`outputs/`)

| File | Tugas | Catatan |
|---|---|---|
| `db_worker.py` | Koneksi PostgreSQL + **antrian tulis async**. `db_queue_write()` cuma memasukkan query ke antrian; thread worker yang menjalankannya. | Loop frame tidak pernah menunggu database. Baca (`db_fetch`) tetap sinkron dan dipakai hanya saat start/ganti jam. |
| `hourly_aggregate_db.py` | `increment_hourly()` menaikkan satu key JSONB di tabel `*_hourly`. `pregenerate_day()` membuat 24 row kosong. | Label dikirim sebagai parameter (aman dari SQL injection). |
| `mqtt_out.py` | Kirim event (dengan foto JPEG base64) dan data interval tiap `MQTT_INTERVAL_MINUTES` (default 5). | Encode JPEG + publish dikerjakan **worker thread**. Saat kirim interval, ia juga menulis hitungan jam berjalan ke `inout_resample`. |
| `mjpeg_server.py` | HTTP server MJPEG di `STREAM_PORT` untuk preview dengan box. | Frame hanya digambar & di-encode kalau ada penonton (`viewer_count() > 0`). |
| `bbox_writer.py` | Tulis `bbox_<CODE>.json` (box orang terakhir) maksimal 2×/detik untuk overlay dashboard. | Ditulis via file sementara + rename, jadi dashboard tidak pernah membaca file setengah jadi. |
| `face_db.py` | Cache `known_faces` di memori + pencocokan cosine. Refresh tiap `FACE_CACHE_REFRESH_MINUTES`. | |
| `image_utils.py` | `crop_image()` untuk foto event, `crop_face()` untuk wajah (diperbesar + margin). | |

---

## 4. Data yang dihasilkan

### Tabel PostgreSQL (database `edge`, dibuat migrasi dashboard)

| Tabel | Isi | Kapan ditulis |
|---|---|---|
| `person_inout` | Satu row per device per hari: `total_in`, `total_out` | Tiap IN/OUT (async). Row baru dibuat tengah malam |
| `inout_resample` | Satu row per device per jam: `interval_in`, `interval_out`. `hour_start` disimpan **UTC** | 24 row dibuat di awal hari; diisi tiap kirim interval MQTT dan saat ganti jam |
| `apd_hourly`, `firesmoke_hourly`, `face_hourly`, `intrusion_hourly` | Satu row per device per jam, counter di kolom `data` (JSONB), mis. `{"fire": 2, "smoke": 5}` | Tiap event. 24 row dibuat di awal hari kalau fiturnya aktif |
| `known_faces` | Database wajah (diisi dashboard, dibaca kamera) | Saat enrollment |
| `devices` | Config kamera (dibaca kamera, ditulis dashboard) | Saat kamera / Settings disimpan |
| `device_status` | Heartbeat kamera | Tiap 10 detik |

### Topic MQTT

`MQTT_TOPIC` (event in/out), `MQTT_INTERVAL_TOPIC` (rekap 5 menit), dan topic
per deteksi `.../apd`, `.../firesmoke`, `.../face`, `.../intrusion`. Detail
payload: [README.md §4](README.md#4-mqtt).

### Saat container restart

`lifecycle.initialize_counts()` membaca row `person_inout` hari ini dan
melanjutkan hitungan dari situ. Hitungan **tidak** kembali ke nol karena
restart.

---

## 5. Kalau ada yang gagal

| Yang gagal | Perilaku |
|---|---|
| **Triton mati / model belum load** | Container tetap hidup. Preview menampilkan "INFERENCE UNAVAILABLE". Coba lagi dengan jeda 1s → 2s → ... → 30s. Saat tersambung lagi, **tracker di-reset** supaya posisi lama tidak memicu hitungan palsu. |
| Model tambahan (APD/face/fire) gagal | Hanya fitur itu yang berhenti, dicoba lagi tiap 30 detik. Counting tetap jalan. |
| Kamera putus / frame gagal dibaca | Loop dalam dilempar error → tunggu 5 detik → buka ulang kamera. State counting per-track dibersihkan; total harian tetap. |
| Database lambat/mati | Tulis masuk antrian; worker mencoba sampai 3× (reconnect di antaranya), kalau tetap gagal query itu dibuang dengan log error. Loop frame tidak tertahan. |
| MQTT gagal kirim interval | Counter interval dikembalikan, jadi angkanya ikut di pengiriman berikutnya. |
| Database mati saat container start | `bootstrap.py` memakai config terakhir dari `.config-cache/`; kalau belum pernah ada, mencoba lagi (jeda naik sampai 30 detik). |
| Koneksi `LISTEN` putus | `config_watch` menyambung ulang dan langsung mengecek versi terbaru; poll 60 detik sebagai cadangan. |

---

## 6. Aturan penting (jangan dilanggar)

0. **Config hanya dari environment yang disiapkan `bootstrap.py`.** Jangan
   membaca file config lain atau menulis ke tabel `devices` dari kamera; role
   `edge_device` memang tidak diizinkan.

1. **Container kamera tidak boleh butuh GPU/torch.** Semua model jalan di
   Triton. Jangan tambah `torch`/`ultralytics` ke `requirements.txt`.
2. **Jangan export model dengan `nms=True`.** NMS bawaan ultralytics hanya
   mengisi gambar pertama dalam batch, sementara Triton menggabungkan frame
   banyak kamera jadi satu batch. Akibatnya sebagian kamera dapat hasil
   kosong. Cek model baru dengan `tools/batch_check.py`.
3. **Koordinat line/zone terikat ke `SCREEN_RESOLUTION`.** Ganti resolusi =
   gambar ulang garis.
4. **Akses state lewat `state.xxx`**, bukan import nilainya.
5. **Jangan tulis DB/MQTT secara sinkron di loop frame.** Pakai
   `db_queue_write()` dan fungsi `send_*` di `mqtt_out` yang sudah async.
6. **Jangan ubah `tracking/`** kecuali sengaja; ada test parity.
7. **Tracker di-reset bersama state turunannya** (`reset_tracking_state`,
   `reset_apd_state`, `reset_face_state` di `main.py`). Kalau menambah state per-track, tambahkan juga ke fungsi reset
   itu, karena tracker yang di-reset memakai ulang id.
8. **Set per-track dibatasi ukurannya** (`*_ALERTED_TRACKS_MAX` di `main.py`).
   State baru per-track juga harus dibatasi supaya memori tidak bocor.

---

## 7. Mau mengubah X? Mulai dari sini

| Ingin... | File yang disentuh |
|---|---|
| Menambah env/konfigurasi | `counting_config.py`; default-nya di `dashboard/lib/device-config.ts` (`DEVICE_DEFAULTS`, atau `globalEnv` kalau diwarisi dari Settings); field di form `dashboard/app/devices/[code]/page.tsx`. Kalau nilainya dibaca `cfg.X` saat dipakai dan aman diubah live, tambahkan ke `HOT_KEYS` di `config_watch.py` |
| Mengubah aturan IN/OUT | `counting.py` (`process_track`) |
| Menambah jenis deteksi baru | Buat `detection/<nama>.py` meniru `apd.py`, tambah tabel di migrasi baru `dashboard/db/migrations/00N_*.sql` (plus GRANT untuk `edge_device`) + `lifecycle.pregenerate_hourly_tables`, topic di `counting_config.py`, panggil dari loop `main.py`, tambah test di `tests/` |
| Mengganti/menambah model | `tools/export_model.py` → `tools/make_uint8_input.py` → `tools/build_engine.sh`; client otomatis membaca format barunya |
| Mengubah isi pesan MQTT | `outputs/mqtt_out.py` |
| Mengubah skema DB | File migrasi baru `dashboard/db/migrations/00N_<nama>.sql` (jangan ubah file yang sudah ada); dashboard menerapkannya saat start |
| Mengubah tampilan preview MJPEG | `draw_static_overlays` / `draw_track` di `main.py` |
| Debug FPS / tearing | `tools/stream_health.py`, `tools/resource_monitor.py`, log `Processing FPS` |

### Menjalankan tanpa infrastruktur

```bash
FALLBACK_VIDEO=1.mp4 DEBUG_MODE=true python main.py
```

`DEBUG_MODE=true` membuat DB/MQTT tidak benar-benar ditulis (hanya log),
jadi aman dicoba di laptop. Triton tetap dibutuhkan untuk inference. Test:
`for t in tests/test_*.py; do python "$t"; done`.

---

## 8. Istilah

| Istilah | Arti |
|---|---|
| **Triton** | NVIDIA Triton Inference Server. Satu server GPU yang menjalankan semua model untuk semua kamera. |
| **gRPC** | Protokol yang dipakai container kamera untuk mengirim frame ke Triton. |
| **Dynamic batching** | Triton menunggu sebentar (1 ms) untuk menggabungkan frame dari beberapa kamera jadi satu kali proses GPU. |
| **TensorRT / `.plan`** | Versi model yang dioptimasi untuk GPU tertentu. Dibuat di server itu sendiri dari ONNX. |
| **ONNX** | Format model yang portable; disimpan di git sebagai sumber. |
| **e2e (end-to-end)** | Model yang outputnya sudah bersih (tanpa box duplikat), tidak perlu NMS. |
| **u8 / uint8 NHWC** | Model menerima gambar mentah 0–255. Datanya 4× lebih kecil dari float, jadi pengiriman lebih cepat. |
| **Letterbox** | Resize gambar dengan mempertahankan rasio, sisa area diisi padding. |
| **NMS** | Membuang box yang tumpang tindih untuk objek yang sama. |
| **Track / track_id** | Identitas satu objek yang diikuti antar frame. |
| **Degraded mode** | Kondisi Triton tidak tersedia; kamera tetap hidup tanpa deteksi. |
| **Tearing** | Gambar pecah/bergaris karena data video hilang di tengah frame. |
| **Hourly aggregate** | Satu row per jam berisi jumlah kejadian, bukan satu row per kejadian. |
