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

- **Utama** — `Stream`, `Devices`, `Logs`, `Settings`. Kamera sebagai *source*:
  RTSP URL, live view lewat stream-gateway, port forward. Bisa dipakai tanpa
  pipeline deteksi sama sekali.
- **Detection** — `Dashboard` (`/detection`), `Devices`, `Face Enrollment`,
  `Build & Inference`, `Model Test`, `Settings`. Semua yang berhubungan dengan
  python-counting + Triton: konfigurasi deteksi per kamera, gambar line/zone,
  log & kontrol container, model, hardware mode, DB, MQTT.

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

## 2. Prasyarat

| Komponen | Keterangan |
|---|---|
| Linux + Docker Engine + Compose v2 | Semua service jalan sebagai container di network bersama `envisions` |
| GPU NVIDIA + driver + `nvidia-container-toolkit` | Untuk Triton (`runtime: nvidia`). Mode CPU memakai onnxruntime |
| PostgreSQL / TimescaleDB | Di produksi: container `env_services_timescaledb`, host port **5435** |
| MQTT broker | Port 1883 |
| **Penyimpanan SSD/NVMe** untuk `/opt/ai` + data Docker | HDD terbukti bikin semua kamera stall (journal ext4). Lihat troubleshooting |
| Node.js 20+ | Hanya untuk development dashboard di luar Docker |

Windows/WSL2: [python-counting/docs/windows-wsl2.md](python-counting/docs/windows-wsl2.md).

---

## 3. Setup dari nol (urutan)

```bash
git clone <repo> && cd v3-dashboard

# 1. Database (sekali, idempotent)
cd python-counting
PG_HOST=<host> PG_PORT=5435 PG_DB=postgres PG_USER=postgres PG_PASS=<pass> python init_db.py

# 2. Model: export ONNX → tambah input uint8 → build TensorRT → cek batch
#    (perintah lengkap: python-counting/README.md § Setup model)

# 3. Triton
docker compose up -d triton
curl -s localhost:8000/v2/health/ready -o /dev/null -w '%{http_code}\n'   # 200

# 4. Image kamera (dipakai semua container kamera; kode di-bind-mount ke /app,
#    jadi update kode cukup git pull + restart container, tanpa rebuild)
docker build -t python-counting-services-python-1:latest .

# 5. Dashboard + stream-gateway
cd ../dashboard
cp .env.example .env        # isi HOST_PYTHON_COUNTING_DIR (path ABSOLUT di host)
docker compose up -d --build
# → http://<host>:3001

# 6. Di dashboard: Detection → Settings (Triton, PostgreSQL, MQTT, default model)
#    lalu Devices → Add Camera. Dashboard menulis .env_<CODE>, menambah service
#    ke python-counting/docker-compose.yml, dan menyalakan container-nya.
```

---

## 4. Operasional

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
