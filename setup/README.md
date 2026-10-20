# Setup EPiWalk

Panduan memasang EPiWalk dari mesin kosong sampai kamera pertama menghitung
orang. Kerjakan **berurutan**; tiap langkah bergantung pada langkah
sebelumnya.

| # | File | Hasil akhir langkah | Perkiraan waktu |
|---|---|---|---|
| 0 | [00-pre-setup.md](00-pre-setup.md) | Driver NVIDIA, Docker, GPU di container, storage NVMe, repo ter-clone | 30–60 menit |
| 1 | [01-database.md](01-database.md) | PostgreSQL jalan (bawaan di compose dashboard, atau yang sudah ada), semua tabel dibuat | 10 menit |
| 2 | [02-mqtt.md](02-mqtt.md) | MQTT broker menerima pesan (bawaan atau yang sudah ada) | 5 menit |
| 3 | [03-images.md](03-images.md) | Image kamera + image export model ter-build | 10–20 menit |
| 4 | [04-models.md](04-models.md) | Model ONNX uint8 di `models/`, engine TensorRT dibuild | 20–40 menit |
| 5 | [05-triton.md](05-triton.md) | Triton jalan, semua model `READY`, batching benar | 10 menit |
| 6 | [06-dashboard.md](06-dashboard.md) | Dashboard, stream gateway, nginx port-forward, Node-RED jalan | 10 menit |
| 7 | [07-add-camera.md](07-add-camera.md) | Kamera pertama terdaftar, garis digambar, container deteksi jalan | 10 menit / kamera |
| 8 | [08-verification.md](08-verification.md) | Checklist end-to-end: FPS, DB, MQTT, stream | 10 menit |

Catatan platform lain: [windows-wsl2.md](windows-wsl2.md).

## Gambaran yang akan dipasang

```
                         ┌────────────────────── server ───────────────────────┐
Kamera/NVR ──RTSP──────► │ stream-gateway :8555 ──────────────► browser        │
           ──RTSP──────► │ services-python-<code> (1 per kamera, CPU)          │
                         │      │ gRPC                                         │
                         │      ▼                                              │
                         │ triton-inference-server (GPU) :8000-8002            │
                         │                                                     │
                         │ edge-dashboard :3001   edge-portfwd-nginx :5500-5600│
                         │ nodered :1880          (langkah 6)                  │
                         │                                                     │
                         │ PostgreSQL :5435 (langkah 1)   MQTT :1884 (langkah 2)│
                         └─────────────────────────────────────────────────────┘
```

## Cara membaca tiap file

Setiap file punya bagian yang sama:

1. **Tujuan**: apa yang selesai setelah langkah ini.
2. **Langkah**: perintah yang dijalankan, berurutan.
3. **Verifikasi**: cara memastikan langkah berhasil. Jangan lanjut kalau ini
   belum lolos.
4. **Kalau error**: tabel gejala → penyebab → solusi.

Placeholder ditulis dalam `<kurung-sudut>`: ganti dengan nilai milik kamu.
Contoh nilai default di dokumen ini mengikuti server produksi (folder
`/opt/ai`, Postgres di port `5435`).

## Kalau sudah pernah setup

| Ingin... | Lihat |
|---|---|
| Menambah kamera baru | [07-add-camera.md](07-add-camera.md) |
| Mengganti / menambah model | [04-models.md](04-models.md) lalu [05-triton.md](05-triton.md) |
| Pindah ke GPU / server lain | Ulangi [00](00-pre-setup.md), lalu build ulang engine ([04 §4](04-models.md#4-build-engine-tensorrt)) |
| Update kode dari git | `git pull`, lalu restart container yang terkait ([03 §Update kode](03-images.md#update-kode-tanpa-rebuild)) |
| Masalah saat sistem sudah berjalan | Troubleshooting di [python-counting/README.md](../python-counting/README.md#troubleshooting) dan [dashboard/README.md](../dashboard/README.md#8-troubleshooting) |
