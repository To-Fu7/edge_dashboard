# 6. Dashboard

## Tujuan

Container dari `dashboard/docker-compose.yml` jalan, dan dashboard sudah
terhubung ke Triton, PostgreSQL, dan MQTT.

| Container | Port | Peran |
|---|---|---|
| `edge-dashboard` | 3001 | UI + API, mengatur container lain lewat Docker |
| `stream-gateway` | 8555/tcp, 8189/udp | Live view kamera di browser |
| `edge-portfwd-nginx` | 5500–5600/tcp | Port-forward RTSP |
| `nodered` | 1880 | Automation (di-embed di `/automation`) |
| `env_services_timescaledb` | 5435 | PostgreSQL bawaan (Opsi A di [01](01-database.md)) |
| `env_services_mqtt` | 1884, 9001 | MQTT bawaan (Opsi A di [02](02-mqtt.md)) |

## Langkah

### 1. Isi `.env`

```bash
cd /opt/ai/dashboard-python-counting/dashboard
cp .env.example .env               # kalau belum dibuat di langkah 1
```

`POSTGRES_PASSWORD` sudah diisi di [01](01-database.md) kalau memakai DB
bawaan. Isi juga `HOST_PYTHON_COUNTING_DIR` dengan **path absolut di host** ke folder
`python-counting`:

```
HOST_PYTHON_COUNTING_DIR=/opt/ai/dashboard-python-counting/python-counting
```

Dashboard memakai path ini saat menjalankan builder/export sebagai container
lewat Docker host.

### 2. Build dan jalankan

```bash
docker compose up -d --build
docker compose ps                  # semua container "running"
```

Kalau DB / MQTT memakai Opsi B (sudah ada di luar compose ini), jalankan tanpa
service bawaan:

```bash
docker compose up -d --build dashboard stream-gateway edge-portfwd-nginx nodered
```

Build pertama makan beberapa menit (Next.js + Go).

### 3. Atur settings global

Buka `http://<ip-server>:3001`, lalu **Detection → Settings**:

| Bagian | Isi |
|---|---|
| Hardware Mode | **server** (GPU NVIDIA di x86). Default-nya *jetson* |
| Triton | Image tag `24.08`, default model `yolo26s_640_e2e_u8`, Face Embedding Model `arcface_112` (kalau pakai wajah) |
| PostgreSQL | Bawaan: host `env_services_timescaledb`, port `5432`. Opsi B: host/port DB kamu (mis. `host.docker.internal` / `5435`). DB `postgres`, user `postgres`, password dari langkah 1 |
| MQTT | Bawaan: broker `env_services_mqtt`, port `1883`. Opsi B: alamat broker kamu. Username/password kalau dipakai, template topic |
| Detection Defaults | Biarkan default. **Debug Mode harus `false`**, kalau tidak, data tidak ditulis ke DB/MQTT |

> **Isi ini sebelum menambah kamera.** Nilai PostgreSQL, MQTT, dan Debug
> Mode disalin ke `.env_<CODE>` kamera **saat kamera dibuat**. Mengubahnya
> belakangan tidak mengubah kamera yang sudah ada (lihat
> [07 → Kalau error](07-add-camera.md#kalau-error)).

Lalu **Settings → General**: nama dashboard. Settings disimpan di volume
`dashboard-data` (`/app/data/settings.json`).

## Verifikasi

| Cek | Cara | Hasil yang benar |
|---|---|---|
| Dashboard | Buka `http://<ip-server>:3001` | Masuk ke halaman Stream |
| Triton | Detection → Dashboard | Triton online, model terdaftar, kartu GPU menampilkan watt & VRAM |
| Mount builder | Detection → Build & Inference | Tidak ada peringatan `HOST_PYTHON_COUNTING_DIR` |
| Nginx | Settings → Nginx | `edge-portfwd-nginx` Running |
| Node-RED | Klik Automation | Editor Node-RED tampil di dalam halaman |
| Stream gateway | `curl -s -o /dev/null -w '%{http_code}\n' localhost:8555/` | Ada respons HTTP (bukan connection refused) |

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Conflict. The container name "/env_services_timescaledb"` (atau `env_services_mqtt`) `is already in use` | DB/MQTT sudah jalan dari stack lain | Jalankan tanpa service bawaan: `docker compose up -d --build dashboard stream-gateway edge-portfwd-nginx nodered` |
| Build engine/export dari dashboard gagal "file not found" untuk script yang ada | `HOST_PYTHON_COUNTING_DIR` kosong/salah | Perbaiki `.env`, lalu `docker compose up -d --force-recreate dashboard` |
| Peringatan: *can't see python-counting/tools/build_engine.sh* | Folder repo tidak lengkap atau mount `../python-counting` gagal | Jalankan compose dari folder `dashboard/` di repo yang utuh |
| `Bind for 0.0.0.0:3001 failed: port is already allocated` | Port dipakai service lain | Ganti `"3001:3000"` di compose ke port lain |
| `edge-portfwd-nginx` gagal start: *address already in use* | Ada service lain di port 5500–5600 | Geser rentang port di compose **dan** `LISTEN_PORT_MIN/MAX` di `lib/portforward.ts` |
| Halaman Automation: *Automation service (Node-RED) is unreachable* (502) | Container `nodered` belum jalan | `docker compose ps nodered`, `docker compose logs nodered`, lalu `docker compose up -d nodered` |
| Editor Node-RED tampil tapi tema default / panel debug *disconnected* | Container restart saat tab terbuka, atau WebSocket tidak ter-proxy | Hard refresh (Ctrl+Shift+R). Pastikan log dashboard berisi `proxying /nodered -> http://nodered:1880` |
| Detection Dashboard: Triton offline | Triton belum jalan, atau tidak satu network | Start Triton ([05](05-triton.md)); `docker network inspect envisions` harus memuat dashboard dan `triton-inference-server` |
| Kartu GPU menampilkan N/A | Metrics Triton (`:8002`) tidak terjangkau | Sama seperti di atas; metrics hanya ada saat Triton jalan |
| Face Enrollment: `getaddrinfo ENOTFOUND host.docker.internal` | Container dashboard lama tanpa `extra_hosts` | `git pull`, lalu `docker compose up -d --force-recreate dashboard` |
| Face Enrollment: *No Face Embedding Model configured* | Field ArcFace kosong | Detection → Settings → Triton → Face Embedding Model = `arcface_112` |
| "Expose CCTV URL" / live view 502 | `stream-gateway` belum jalan | `docker compose up -d --build stream-gateway` |
| Live view jalan di LAN tapi WebRTC gagal dari jaringan lain | Port UDP 8189 diblok | Buka `8189/udp` di firewall |
| `permission denied` ke `/var/run/docker.sock` di log dashboard | Socket tidak ter-mount atau permission host | Pastikan volume `/var/run/docker.sock` ada di compose; jangan jalankan Docker rootless |
| `next build` gagal saat `docker compose build` | Dependency/kode bermasalah | `docker compose build dashboard --progress=plain` untuk melihat error lengkap |
