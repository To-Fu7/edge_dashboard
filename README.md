# EPiWalk — CCTV Stream & Detection Platform

Satu repo untuk tiga komponen yang jalan berdampingan di satu host:

| Komponen | Folder | Peran | Dokumentasi |
|---|---|---|---|
| **Dashboard** | [`dashboard/`](dashboard/) | Next.js UI: daftar kamera, live stream, port forward (area **utama**) + seluruh pipeline deteksi (area **Detection**) | [dashboard/README.md](dashboard/README.md) |
| **Stream gateway** | [`stream-gateway/`](stream-gateway/) | Service Go: ambil RTSP tiap kamera **sekali**, sajikan ulang ke browser sebagai HLS / MSE / WebRTC | dijelaskan di [dashboard/README.md](dashboard/README.md#stream-gateway) |
| **Python counting** | [`python-counting/`](python-counting/) | Container per kamera (thin client CPU) + Triton Inference Server (GPU): person counting, APD, fire/smoke, face, intrusion | [python-counting/README.md](python-counting/README.md) |

Pendukung: [`python-counting/SYSTEM.md`](python-counting/SYSTEM.md)
(cara kerja pipeline per modul), [`python-counting/models/README.md`](python-counting/models/README.md)
(model repository Triton), [`nodered-flows/`](nodered-flows/) (contoh flow
Node-RED), [`docs/superpowers/specs/`](docs/superpowers/specs/) (dokumen desain).

---

## 1. Arsitektur

```
                       ┌──────────────────────── host ────────────────────────────┐
                       │                                                          │
 Kamera / NVR ──RTSP──►│ stream-gateway (Go)  :8555 http, :8189/udp WebRTC ──────►│──► browser (Stream page)
   (1 koneksi/kamera   │                                                          │
    per konsumen)      │ services-python-<code>  (1 container per kamera, CPU)    │
           └──RTSP────►│   reader thread → letterbox uint8 → gRPC ───┐            │
                       │   ByteTrack → counting / APD / face / ...   │            │
                       │   → PostgreSQL/Timescale, MQTT, MJPEG :809x │            │
                       │                                             ▼            │
                       │ triton-inference-server (GPU)  :8000/:8001/:8002         │
                       │   model repo python-counting/models (TensorRT .plan)     │
                       │   dynamic batching: frame dari banyak kamera digabung    │
                       │                                                          │
                       │ edge-dashboard (Next.js) :3001 → mengatur semua di atas  │
                       │   via docker.sock (compose per kamera, Triton, build)    │
                       └──────────────────────────────────────────────────────────┘
```

Dashboard punya **dua area** di sidebar:

- **Utama** — `Stream`, `Devices`, `Automation` (Node-RED). Kamera sebagai
  *source*: RTSP URL, live view lewat stream-gateway, port forward. Bisa
  dipakai tanpa pipeline deteksi sama sekali.
- **Detection** (dropdown) — `Dashboard` (`/detection`), `Devices`, `Face Enrollment`,
  `Build & Inference`, `Model Test`, `Settings`. Semua yang berhubungan dengan
  python-counting + Triton: konfigurasi deteksi per kamera, gambar line/zone,
  log & kontrol container, model, hardware mode, DB, MQTT.
- **Settings** (dropdown) — `General`, `Logs` (log semua container kamera),
  `Nginx` (port-forward proxy: forward, config, redeploy, log).

Halaman device dan settings dipakai bersama oleh kedua area; isinya
menyesuaikan path (`/devices/...` vs `/detection/devices/...`).

### Prinsip desain pipeline deteksi

- **GPU-first, satu Triton per host.** Semua model (YOLO person, APD,
  fire/smoke, face, ArcFace) di-load sekali di Triton. Container kamera tidak
  punya torch/CUDA (image < 1 GB, RAM ratusan MB).
- **Frame terbaru, bukan antrian.** Tiap kamera punya reader thread yang terus
  mengosongkan socket RTSP; loop proses selalu mengambil frame terbaru. Ini
  menghilangkan *tearing* akibat backpressure TCP (lihat
  [python-counting/README.md § Troubleshooting](python-counting/README.md#troubleshooting)).
- **Model end-to-end uint8.** Model produksi `yolo26*_e2e_u8`: NMS-free, aman
  untuk dynamic batching, dan input uint8 NHWC (4× lebih kecil dari FP32 di
  gRPC).
- **ONNX = artifact kanonik**, TensorRT `.plan` dibuild **di device** (engine
  tidak portable antar GPU/versi TRT).
- **Degraded mode.** Triton mati ≠ container crash; capture tetap jalan,
  reconnect backoff 1s→30s, tracker di-reset saat tersambung lagi.
- **Hourly aggregate.** Hasil disimpan satu row per (device, jam), 24 row
  dibuat di awal hari.

---

## 2. Setup

Panduan lengkap ada di folder **[`setup/`](setup/)**: pre-setup (driver,
Docker, GPU di container, NVMe), database, MQTT, image, model, Triton,
dashboard, tambah kamera, dan checklist verifikasi. Tiap langkah punya
bagian **Kalau error**.

Urutan singkat:

| # | Langkah |
|---|---|
| 0 | [Pre-setup](setup/00-pre-setup.md) |
| 1 | [Database](setup/01-database.md) |
| 2 | [MQTT](setup/02-mqtt.md) |
| 3 | [Build image](setup/03-images.md) |
| 4 | [Model](setup/04-models.md) |
| 5 | [Triton](setup/05-triton.md) |
| 6 | [Dashboard](setup/06-dashboard.md) |
| 7 | [Tambah kamera](setup/07-add-camera.md) |
| 8 | [Verifikasi](setup/08-verification.md) |

---

## 3. Operasional

- **Deploy:** commit + push dari laptop → `git pull` di server → restart/recreate
  container terkait. Perubahan `.env_<code>` butuh *recreate*
  (`docker compose up -d --no-deps <service>`), `docker restart` tidak membaca
  ulang `env_file`.
- **Monitoring per kamera:** `python3 tools/stream_health.py <container> --follow`
  (FPS, frame stale yang di-drop, error decode/tearing) dan
  `tools/resource_monitor.py` (CPU per container, GPU, antrian Triton).
- **Akses server:** key-based SSH. Jangan simpan password di file/commit
  (lihat `.claude/skills/ssh-prod-server/`).

Troubleshooting spesifik ada di README masing-masing komponen.
