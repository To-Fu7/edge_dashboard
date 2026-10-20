# 5. Triton Inference Server

## Tujuan

Triton jalan di GPU, semua model di `models/` berstatus `READY`, dan model
person benar-benar memberi deteksi untuk setiap frame dalam satu batch.

## Langkah

```bash
cd /opt/ai/dashboard-python-counting/python-counting
docker compose up -d triton
docker logs -f triton-inference-server        # tunggu baris "Started GRPCInferenceService"
```

`docker-compose.yml` di folder ini menjalankan Triton dengan
`--strict-model-config=false --exit-on-error=false`: satu model gagal tidak
membuat Triton mati, dan dynamic batching menyala otomatis untuk model yang
mendukungnya.

Setelah dashboard terpasang (langkah 6), Triton juga bisa di-start/stop dari
**Detection → Build & Inference**. Dashboard menulis ulang service `triton`
sesuai **Hardware Mode**, jadi set mode yang benar dulu (lihat tabel error).

## Verifikasi

```bash
# 1. Server siap (harus 200)
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/v2/health/ready

# 2. Semua model READY
curl -s -X POST localhost:8000/v2/repository/index | python3 -m json.tool

# 3. Model person memberi deteksi untuk SEMUA frame dalam satu batch
#    (siapkan 3 gambar dari kamera di python-counting/frames/).
#    Tiap baris harus "same": jumlah deteksi sendiri-sendiri = dalam batch.
docker run --rm --network envisions -v "$(pwd):/app" -w /app \
  python-counting-services-python-1:latest \
  python tools/batch_check.py --model yolo26s_640_e2e_u8 \
  frames/a.jpg frames/b.jpg frames/c.jpg

# 4. GPU terpakai oleh Triton
nvidia-smi                                   # proses tritonserver muncul
```

Cara cepat mengambil frame uji dari kamera:

```bash
mkdir -p frames
for f in a b c; do
  docker run --rm -v "$(pwd)/frames:/out" python-counting-services-python-1:latest \
    python -c "import cv2;c=cv2.VideoCapture('<rtsp-url>');ok,f=c.read();cv2.imwrite('/out/$f.jpg',f)"
done
```

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| Health check bukan 200 / connection refused | Triton belum selesai load atau crash | `docker logs triton-inference-server`; load semua model bisa makan 1–2 menit |
| Model `UNAVAILABLE`: *serialization ... version* / *engine plan file is not compatible* | Engine dibuild di GPU atau versi TensorRT lain | Build ulang: `docker compose --profile build run --rm -e FORCE_BUILD=1 triton-model-builder` |
| `model does not support batching` (ArcFace) | `max_batch_size` > 0 untuk model dengan batch tetap | Set `max_batch_size: 0` di `models/arcface_112/config.pbtxt` |
| `CUDA out of memory` saat load | Terlalu banyak model di `models/` | Pindahkan model yang tidak dipakai ke luar `models/`, restart Triton |
| `no matching manifest for linux/amd64` untuk image `-py3-igpu` | Hardware Mode di dashboard masih **jetson** (default) di server x86 | Detection → Settings → Hardware Mode = **server**, simpan, start Triton lagi |
| `unknown or invalid runtime name: nvidia` | NVIDIA Container Toolkit belum dikonfigurasi | [00-pre-setup.md](00-pre-setup.md) langkah 3 |
| `batch_check.py` menampilkan `DIFFERENT` (mis. `in batch of 3: 0 dets`) | Model diexport dengan `nms=True` | Export ulang ([04-models.md](04-models.md)) |
| `batch_check.py`: `failed to connect` | Container tidak di network `envisions` atau Triton mati | Pakai `--network envisions`; cek `docker network inspect envisions` memuat `triton-inference-server` |
| `Bind for 0.0.0.0:8000 failed` | Port 8000–8002 dipakai service lain | Hentikan service itu, atau ubah port host di compose (port di dalam network tetap 8001 untuk kamera) |
| `network envisions was found but has incorrect label` | Network `envisions` pernah dibuat manual (`docker network create`) | Hentikan container yang memakainya, `docker network rm envisions`, lalu `docker compose up -d` lagi agar compose yang membuatnya |
