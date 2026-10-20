# 3. Build image

## Tujuan

Dua image siap dipakai:

| Image | Dipakai untuk | Ukuran kira-kira |
|---|---|---|
| `edge-device:latest` | Semua container kamera (thin client, tanpa GPU) | < 1 GB |
| `yolo-export` | Mengubah bobot `.pt` jadi ONNX (langkah 4). Satu-satunya image yang berisi torch | ±10 GB |

Image Triton (`nvcr.io/nvidia/tritonserver:24.08-py3`) di-pull otomatis di
langkah 4–5.

## Langkah

```bash
cd /opt/ai/dashboard-python-counting/python-counting

# 1. Image kamera — nama ini dipakai dashboard saat membuat container kamera
docker build -t edge-device:latest .

# 2. Image export model
docker build -f tools/Dockerfile.export -t yolo-export tools/

# 3. (opsional) pull image Triton sekarang supaya langkah 4–5 lebih cepat
docker pull nvcr.io/nvidia/tritonserver:24.08-py3
```

## Verifikasi

```bash
docker images | grep -E 'edge-device|yolo-export|tritonserver'

# image kamera bisa import semua modul
docker run --rm edge-device:latest \
  python -c "import cv2, tritonclient.grpc, psycopg2, paho.mqtt; print('ok')"
```

## Update kode tanpa rebuild

Container kamera (`device-<code>`) me-mount folder `python-counting/` ke `/app`.
Jadi setelah `git pull`, cukup restart kameranya: tombol **Restart** di dashboard,
atau `docker restart device-<code>`.

Rebuild image hanya perlu kalau `requirements.txt` atau `dockerfile` berubah.

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `pip install` gagal / timeout saat build | Tidak ada akses internet atau DNS dari Docker | Cek `docker run --rm python:3.11-slim pip download numpy`; set DNS di `/etc/docker/daemon.json` (`"dns": ["8.8.8.8"]`) lalu restart Docker |
| `no space left on device` | Disk Docker penuh (image export ±10 GB, Triton ±15 GB) | `df -h /data`, `docker system prune` (hapus image/container yang tidak dipakai) |
| `failed to solve: ... not found` untuk file yang ada | Build dijalankan dari folder yang salah | Jalankan dari `python-counting/`; untuk export, context-nya `tools/` |
| Start kamera gagal: *Camera image edge-device:latest is not built* | Image kamera belum dibuild di server ini | Jalankan langkah 1, atau Detection → Build & Inference → Build camera image |
| `ModuleNotFoundError` di container kamera | Image lama sebelum dependency baru ditambahkan | Rebuild image (langkah 1), lalu hapus container lama (`docker rm -f device-<code>`) dan klik **Start** di dashboard — container dibuat ulang dari image baru |
