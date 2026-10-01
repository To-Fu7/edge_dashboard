# Dashboard (Next.js)

Web UI untuk seluruh sistem: kamera sebagai sumber stream (area **utama**) dan
pipeline deteksi python-counting + Triton (area **Detection**). Dashboard
mengelola container lewat `/var/run/docker.sock`: menulis `.env_<CODE>`,
menambah service ke `../python-counting/docker-compose.yml`, start/stop
container, Triton, dan build model.

Arsitektur keseluruhan: [../README.md](../README.md). Pipeline deteksi:
[../python-counting/README.md](../python-counting/README.md).

> Next.js 16 (Turbopack) — API dan konvensinya berbeda dari versi lama. Lihat
> `node_modules/next/dist/docs/` sebelum mengubah kode (lihat `AGENTS.md`).

---

## 1. Dua area

| Area | Sidebar | Route | Isi |
|---|---|---|---|
| **Utama** | Stream | `/stream` | Grid live view lewat stream-gateway (HLS/MSE/WebRTC) |
| | Devices | `/devices`, `/devices/[code]` | Kamera: nama, kode, RTSP URL, tab **Stream** (expose via gateway, port forward) |
| | Logs | `/logs` | Log container |
| | Settings | `/settings` | Nama dashboard, Stream Gateway |
| **Detection** | Dashboard | `/detection` | Status Triton, kartu GPU (util, **power W/limit (%)**, VRAM), ringkasan device |
| | Devices | `/detection/devices`, `/detection/devices/[code]` | Konfigurasi deteksi: model, counting, APD/fire-smoke/face/intrusion, MQTT topic; tab **Lines** (gambar line/zone) dan **Logs**; kontrol container |
| | Face Enrollment | `/faces` | Upload foto → augmentasi → embed via Triton → `known_faces` |
| | Build & Inference | `/inference` | Model repository, export ONNX, build engine, status Triton |
| | Model Test | `/model-test` | Jalankan model pada video uji dan lihat hasilnya |
| | Settings | `/detection/settings` | Hardware mode, Triton (image tag, default model, embed model), PostgreSQL, MQTT, detection defaults |

`/` redirect ke `/stream`. Halaman `devices` dan `settings` dipakai bersama
oleh kedua area. Route `/detection/...` hanya me-re-export halaman yang sama,
lalu `useDetectionView()` ([lib/view-mode.ts](lib/view-mode.ts)) menentukan
section mana yang tampil dan ke mana link device mengarah. Header halaman
device punya link silang "Detection settings" ↔ "Stream settings".

---

## 2. Setup (Docker, disarankan)

Struktur folder harus dipertahankan: compose me-mount `../python-counting` dan
build `../stream-gateway`.

```bash
cd dashboard
cp .env.example .env
#   HOST_PYTHON_COUNTING_DIR=/opt/ai/<repo>/python-counting   ← path ABSOLUT di HOST
docker compose up -d --build
```

| Service | Port host | Peran |
|---|---|---|
| `dashboard` (`edge-dashboard`) | **3001** → 3000 | UI + API. Volume `dashboard-data` → `/app/data` (`settings.json`, foto wajah) |
| `stream-gateway` | 8555/tcp, 8189/udp | RTSP → HLS/MSE/WebRTC (lihat §3) |
| `edge-portfwd-nginx` | 5500–5600/tcp | L4 TCP proxy untuk port forward RTSP; config dibuat ulang dashboard |

Semua service terhubung ke network `envisions` (bersama Triton dan container
kamera).

**`HOST_PYTHON_COUNTING_DIR` wajib benar.** Dashboard menjalankan
`triton-model-builder`/`yolo-export` sebagai container sibling lewat
docker.sock. Bind mount mereka di-resolve oleh daemon di host. Kalau path
salah, Docker diam-diam me-mount folder kosong dan build gagal dengan error
"file not found".

Setelah start: buka `http://<host>:3001` → Detection → Settings (Triton,
PostgreSQL, MQTT, default model `yolo26s_640_e2e_u8`) → Detection → Devices →
Add Camera.

### Development tanpa Docker

```bash
npm install
npm run dev          # http://localhost:3000
npx tsc --noEmit     # type-check
npm run lint
```

Untuk dev lokal, set `PYTHON_COUNTING_DIR`, `HOST_PYTHON_COUNTING_DIR`,
`TRITON_HTTP_URL=http://localhost:8000`, dan `TRITON_METRICS_URL=http://localhost:8002`.
Turbopack menolak `node_modules` berupa symlink ke luar project.

---

## 3. Stream gateway

[`../stream-gateway`](../stream-gateway) (Go) membuka RTSP tiap kamera
**sekali** dan menyajikannya ke banyak penonton browser sebagai HLS,
MSE-over-websocket, dan WebRTC/WHEP (satu port UDP 8189 untuk semua sesi).
Beban ke NVR tetap satu koneksi per kamera, berapa pun penontonnya.

Gateway tidak membaca file config. Dashboard adalah sumber kebenaran dan
mendaftarkan/menghapus kamera lewat `PUT/DELETE /api/v1/cameras/{code}` setiap
device disimpan. Browser menulis ulang host URL yang dikembalikan
(`toReachableStreamUrl` di `lib/utils.ts`), jadi `PUBLIC_BASE_URL` tidak perlu
diisi.

**Catatan MJPEG annotated:** preview annotated (box deteksi) dari container
kamera di-proxy lewat `/api/stream/[code]/annotated` sebagai MJPEG. Browser
dengan HTTP/1.1 hanya membuka **6 koneksi per host:port**, jadi tile MJPEG ke-7
dan seterusnya akan hitam. Untuk banyak tile pakai stream-gateway (HLS/WebRTC),
atau sajikan dashboard lewat HTTPS/HTTP2.

---

## 4. Port forward

Tab Stream di device: isi `PORTFWD_*`. Dashboard membuat ulang seluruh
`nginx/portfwd-nginx.conf` dari semua device, lalu reload `edge-portfwd-nginx`.
Rentang 5500–5600 sudah dipublish, jadi menambah forward tidak perlu recreate
container. Kalau ada container lain yang memakai port di rentang itu, geser
rentangnya di compose **dan** `LISTEN_PORT_MIN/MAX` di `lib/portforward.ts`.

---

## 5. Face enrollment

Upload satu foto wajah + nama. Server membuat ±16 varian (flip, rotasi ±12°,
crop, low-res, brightness/contrast/gamma, desaturasi, blur, JPEG 25, oklusi
masker/mata), meng-embed tiap varian via Triton, dan menyimpan satu row
`known_faces` per varian. Matching di kamera memakai similarity terbaik
dari semua varian.

Syarat: Detection → Settings → "Face Embedding Model (ArcFace)" terisi
(mis. `arcface_112`) dan **sama** dengan `FACE_EMBED_MODEL` di kamera. Kamera
menyerap perubahan roster dalam ≤ `FACE_CACHE_REFRESH_MINUTES` (default 10).

---

## 6. Kartu GPU

`/api/system` mencoba `nvidia-smi` dulu. Image dashboard berbasis musl
(alpine), sehingga `nvidia-smi` glibc dari host tidak bisa jalan di dalamnya.
Fallback-nya membaca metrik Prometheus Triton (`:8002`):
`nv_gpu_utilization`, `nv_gpu_memory_used_bytes`/`total`, `nv_gpu_power_usage`,
dan `nv_gpu_power_limit` ([lib/triton.ts](lib/triton.ts) `getGpuMetrics()`).
Bar power merah saat ≥ 90% limit, yang berarti GPU sudah penuh.

---

## 7. Automation (Node-RED) — nonaktif

Integrasi Node-RED (editor di-embed di `/automation` lewat reverse proxy
`server.js`, HTTP + WebSocket) sedang **dimatikan**. Untuk mengaktifkannya
lagi:

1. Set `NODERED_ENABLED = true` di `server.js`.
2. Uncomment service `nodered` dan volume `nodered-data` di `docker-compose.yml`.
3. Uncomment `NODERED_URL` di service dashboard.
4. Uncomment item Automation di `components/Sidebar.tsx`.

Node-RED berjalan tanpa login (`adminAuth` kosong). Flow bisa menjalankan
kode di server, jadi tambahkan `adminAuth` di `nodered/settings.js` sebelum
dashboard diekspos ke jaringan yang tidak tepercaya. Contoh flow ada di
[`../nodered-flows/`](../nodered-flows/).

---

## 8. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Build engine/export gagal "file not found" padahal file ada | `HOST_PYTHON_COUNTING_DIR` salah/kosong. Isi path absolut host, lalu `docker compose up -d` |
| Tile stream ke-7+ hitam | Batas 6 koneksi HTTP/1.1 per host untuk MJPEG (§3) |
| Kartu GPU N/A | Triton metrics (`:8002`) tidak terjangkau dari dashboard. Cek `TRITON_METRICS_URL` dan network `envisions` |
| `OCI runtime create failed ... nvidia-smi` | nvidia-smi di-mount dua kali (WSL). Biarkan baris mount nvidia-smi ter-comment |
| "Expose CCTV URL" 502 | Container `stream-gateway` belum dibuild/jalan: `docker compose up -d --build stream-gateway` |
| `edge-portfwd-nginx` gagal start "address already in use" | Port di 5500–5600 sudah dipakai container lain (§4) |
| Enrollment error "No Face Embedding Model configured" | Isi Detection → Settings → Triton → Face Embedding Model |
| `next build` EACCES di `.next` | `.next` milik root (pernah dibuild di container). `sudo chown -R $USER .next` atau hapus |
| Skema DB | Dibuat oleh `python-counting/init_db.py`, bukan dari dashboard |
