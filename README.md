# Edge — CCTV Stream & Detection Platform

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
                       ┌──────────────────────── host ─────────────────────────────┐
 Kamera / NVR ──RTSP──►│ stream-gateway (Go) :8555, :8189/udp ───────────────────►│──► browser (Stream)
                       │                                                           │
           └──RTSP────►│ device-<code>  (1 container per kamera, CPU)              │
                       │   bootstrap: ambil config dari DB → pipeline deteksi      │
                       │   reader thread → uint8 → gRPC ──────────┐                │
                       │   ByteTrack → counting / APD / face / …  │                │
                       │   → hasil + heartbeat ke DB, event ke MQTT│                │
                       │   LISTEN edge_config: perubahan config    ▼                │
                       │   langsung diterapkan     triton-inference-server (GPU)   │
                       │                                                           │
                       │ PostgreSQL, database `edge`                               │
                       │   kamera + config + riwayat, settings, user, hasil        │
                       │                                                           │
                       │ edge-dashboard (Next.js) :3001  — login admin / viewer    │
                       │   simpan config ke DB, NOTIFY kamera, buat/start          │
                       │   container kamera lewat Docker API, Triton, build model  │
                       └───────────────────────────────────────────────────────────┘
```

- **Satu sumber konfigurasi: database `edge`.** Setiap kamera disimpan sebagai
  baris di tabel `devices` (UUID, kode, nama, nilai yang dia override). Settings
  global, akun dashboard, riwayat perubahan, port forward, dan hasil hitungan
  ada di database yang sama. Tidak ada file `.env` per kamera.
- **Pewarisan.** Kamera mewarisi semua nilai Settings (MQTT, model, confidence,
  FPS limit, JPEG quality, tag, …) kecuali yang ia override sendiri.
- **Realtime.** Menyimpan kamera atau Settings menaikkan versi config dan
  mengirim `NOTIFY`; container kamera menerapkan perubahan ringan tanpa restart,
  dan me-restart dirinya sendiri untuk perubahan berat (RTSP, model, garis).
- **Container kamera dibuat dashboard** lewat Docker API dengan nama
  `device-<code>`; hanya Triton yang ada di `python-counting/docker-compose.yml`
  (statis, nilai per mesin di `python-counting/.env`). Jadi `git pull` tidak
  pernah bentrok dengan state runtime.
- **Login.** `admin` bisa semua; `user` (viewer) hanya live CCTV dan
  Detection Dashboard.

Sidebar dashboard:

- **Utama** — `Stream`, `Devices`, `Automation` (Node-RED, admin). Kamera sebagai
  *source*: RTSP URL, live view lewat stream-gateway.
- **Detection** (dropdown) — `Dashboard` (status semua kamera dari heartbeat),
  `Devices`, `Face Enrollment`, `Build & Inference`, `Model Test`, `Settings`.
- **Settings** (dropdown) — `General`, `Logs`, `Nginx` (port forward), `Users`.

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

Cara tercepat: **`./setup/install.sh`** (Linux x86_64 / Jetson) atau
`setup\install.ps1` (Windows → WSL2). Installer mendeteksi platform, menjalankan
semua langkah, dan bisa dilanjutkan dari langkah yang gagal.

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

- **Deploy kode:** commit + push → `git pull` di server. Kode Python di-mount ke
  container kamera, jadi cukup Restart kamera; dashboard di-rebuild dengan
  `docker compose up -d --build dashboard` (migrasi skema jalan otomatis).
- **Ubah konfigurasi:** selalu lewat dashboard (atau tabel `devices` /
  `settings`); berlaku langsung ke kamera yang jalan. Riwayat dan rollback ada
  di tab History halaman kamera.
- **Pindah / tambah PC:** Devices → Export di PC lama, Import di PC baru.
- **Monitoring:** Detection → Dashboard (status, FPS, IN/OUT, error terakhir per
  kamera), `python3 tools/stream_health.py <container> --follow` (FPS, frame
  stale, error decode), `tools/resource_monitor.py` (CPU, GPU, antrian Triton).
- **Lupa password admin:** `docker exec -it edge-dashboard node db/reset-password.js admin <password>`.
- **Akses server:** key-based SSH. Jangan simpan password di file/commit
  (lihat `.claude/skills/ssh-prod-server/`).

Troubleshooting spesifik ada di README masing-masing komponen.
