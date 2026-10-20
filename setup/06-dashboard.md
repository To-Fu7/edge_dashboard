# 6. Dashboard

## Tujuan

Container dari `dashboard/docker-compose.yml` jalan, dan dashboard sudah
terhubung ke Triton, PostgreSQL, dan MQTT.

| Container | Port | Peran |
|---|---|---|
| `edge-dashboard` | 3001 | UI + API, mengatur container lain lewat Docker |
| `stream-gateway` | 8555/tcp, 8189/udp | Live view kamera di browser |
| `edge-portfwd-nginx` | 5500–5600/tcp | Port-forward RTSP |
| `edge-nodered` | — (tidak dipublish) | Automation: daftar flow, editor per flow, community nodes (khusus admin) |
| `env_services_timescaledb` | 5435 | PostgreSQL bawaan (Opsi A di [01](01-database.md)) |
| `env_services_mqtt` | 1884, 9001 | MQTT bawaan (Opsi A di [02](02-mqtt.md)) |

## Langkah

### 1. Isi `.env`

```bash
cd /opt/ai/dashboard-python-counting/dashboard
cp .env.example .env               # kalau belum dibuat di langkah 1
```

| Variabel | Isi |
|---|---|
| `HOST_PYTHON_COUNTING_DIR` | **Path absolut di host** ke folder `python-counting`, mis. `/opt/ai/dashboard-python-counting/python-counting`. Dipakai saat dashboard membuat container kamera dan menjalankan builder lewat Docker host |
| `EDGE_DB_*`, `EDGE_DEVICE_DB_*` | Koneksi database `edge` dan password kedua role, dari [01](01-database.md) |
| `POSTGRES_PASSWORD` | Superuser PostgreSQL bawaan (Opsi A di [01](01-database.md)) |
| `EDGE_AUTH_SECRET` | Opsional. Kosong = secret acak dibuat dan disimpan di volume dashboard |

### 2. Build dan jalankan

```bash
docker compose up -d --build
docker compose ps                  # semua container "running"
curl -s localhost:3001/api/health  # "ok":true setelah migrasi selesai
```

Kalau DB / MQTT memakai Opsi B (sudah ada di luar compose ini), jalankan tanpa
service bawaan:

```bash
docker compose up -d --build dashboard stream-gateway edge-portfwd-nginx nodered
```

Build pertama makan beberapa menit (Next.js + Go). Saat start, dashboard
membuat semua tabel di database `edge` dan dua akun awal.

### 3. Masuk

Buka `http://<ip-server>:3001`.

| Akun awal | Role | Bisa |
|---|---|---|
| `admin` / `admin` | Admin | Semua |
| `user` / `user` | Viewer | Live CCTV (Stream) dan Detection Dashboard saja |

Kelola akun di **Settings → Users** (tambah, ganti role, ganti password, hapus).

### 4. Atur settings global

**Detection → Settings**:

| Bagian | Isi |
|---|---|
| Hardware Mode | **server** (GPU NVIDIA di x86), **jetson**, atau **cpu**. Menyimpan ini menulis `python-counting/.env` untuk Triton |
| Triton | Image tag `24.08`, default model `yolo26s_640_e2e_u8`, Face Embedding Model `arcface_112` (kalau pakai wajah) |
| MQTT | Bawaan: broker `env_services_mqtt`, port `1883`. Opsi B: alamat broker kamu. Username/password kalau dipakai, template topic |
| Detection Defaults | Confidence, JPEG quality, FPS limit, frame skip, interval MQTT, tag, dst. |

Semua nilai di sini **diwarisi semua kamera** dan **langsung berlaku** ke
kamera yang sedang jalan (dalam hitungan detik), kecuali kamera yang
meng-override nilai itu di halamannya sendiri. Riwayat perubahan settings
disimpan di database.

Lalu **Settings → General**: nama dashboard.

## Verifikasi

| Cek | Cara | Hasil yang benar |
|---|---|---|
| Dashboard | Buka `http://<ip-server>:3001` | Masuk ke halaman Stream |
| Triton | Detection → Dashboard | Triton online, model terdaftar, kartu GPU menampilkan watt & VRAM |
| Mount builder | Detection → Build & Inference | Tidak ada peringatan `HOST_PYTHON_COUNTING_DIR` |
| Nginx | Settings → Nginx | `edge-portfwd-nginx` Running |
| Node-RED | Klik Automation | Editor Node-RED tampil di dalam halaman |
| Stream gateway | `curl -s -o /dev/null -w '%{http_code}\n' localhost:8555/` | Ada respons HTTP (bukan connection refused) |
| Login | Masuk sebagai `user` | Sidebar hanya berisi Stream dan Detection → Dashboard |

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Conflict. The container name "/env_services_timescaledb"` (atau `env_services_mqtt`) `is already in use` | DB/MQTT sudah jalan dari stack lain | Jalankan tanpa service bawaan: `docker compose up -d --build dashboard stream-gateway edge-portfwd-nginx nodered` |
| Build engine/export dari dashboard gagal "file not found" untuk script yang ada | `HOST_PYTHON_COUNTING_DIR` kosong/salah | Perbaiki `.env`, lalu `docker compose up -d --force-recreate dashboard` |
| Peringatan: *can't see python-counting/tools/build_engine.sh* | Folder repo tidak lengkap atau mount `../python-counting` gagal | Jalankan compose dari folder `dashboard/` di repo yang utuh |
| `Bind for 0.0.0.0:3001 failed: port is already allocated` | Port dipakai service lain | Ganti `"3001:3000"` di compose ke port lain |
| `edge-portfwd-nginx` gagal start: *address already in use* | Ada service lain di port 5500–5600 | Geser rentang port di compose **dan** `LISTEN_PORT_MIN/MAX` di `lib/portforward.ts` |
| Halaman Automation: *Node-RED unreachable* / editor 502 | Container `edge-nodered` belum jalan atau belum healthy | `docker compose ps nodered`, `docker compose logs nodered`, lalu `docker compose up -d nodered` |
| Panel debug Node-RED *disconnected* | Container restart saat tab terbuka, atau WebSocket tidak ter-proxy | Hard refresh (Ctrl+Shift+R). Pastikan log dashboard berisi `proxying /nodered -> http://edge-nodered:1880` |
| Detection Dashboard: Triton offline | Triton belum jalan, atau tidak satu network | Start Triton ([05](05-triton.md)); `docker network inspect envisions` harus memuat dashboard dan `triton-inference-server` |
| Kartu GPU menampilkan N/A | Metrics Triton (`:8002`) tidak terjangkau | Sama seperti di atas; metrics hanya ada saat Triton jalan |
| Halaman apa pun: *Login unavailable: Database ... is not reachable* (503) | Dashboard tidak bisa konek ke database `edge` | Cek `EDGE_DB_*` di `.env` dan `curl localhost:3001/api/health`; lihat [01 → Kalau error](01-database.md#kalau-error) |
| Login `admin`/`admin` ditolak, tidak ada admin lain yang bisa masuk | Password admin sudah diganti | `docker exec -it edge-dashboard node db/reset-password.js admin <password-baru>` (membuat/menjadikan admin dan mengakhiri sesinya) |
| *Too many failed attempts. Try again in 60 s* | 5 kali salah password dari IP yang sama | Tunggu 1 menit |
| Face Enrollment: *No Face Embedding Model configured* | Field ArcFace kosong | Detection → Settings → Triton → Face Embedding Model = `arcface_112` |
| "Expose CCTV URL" / live view 502 | `stream-gateway` belum jalan | `docker compose up -d --build stream-gateway` |
| Live view jalan di LAN tapi WebRTC gagal dari jaringan lain | Port UDP 8189 diblok | Buka `8189/udp` di firewall |
| `permission denied` ke `/var/run/docker.sock` di log dashboard | Socket tidak ter-mount atau permission host | Pastikan volume `/var/run/docker.sock` ada di compose; jangan jalankan Docker rootless |
| `next build` gagal saat `docker compose build` | Dependency/kode bermasalah | `docker compose build dashboard --progress=plain` untuk melihat error lengkap |
