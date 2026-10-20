# 7. Tambah kamera

## Tujuan

Kamera terdaftar, bisa ditonton live, garis hitung sudah digambar, dan
container deteksinya jalan dengan FPS normal.

## Langkah

### 1. Siapkan RTSP URL

Format Hikvision/NVR:

```
rtsp://<user>:<password>@<ip-nvr>:554/Streaming/Channels/<channel>01   # main stream
rtsp://<user>:<password>@<ip-nvr>:554/Streaming/Channels/<channel>02   # sub stream
```

Main stream memberi resolusi lebih tinggi (lebih baik untuk orang kecil), sub
stream lebih ringan. Uji dulu dari server:

```bash
docker run --rm python-counting-services-python-1:latest python -c \
  "import cv2;c=cv2.VideoCapture('<rtsp-url>');ok,f=c.read();print(ok, None if f is None else f.shape)"
# True (1080, 1920, 3)  ← resolusi asli kamera
```

### 2. Tambah dari dashboard

**Detection → Devices → Add Camera**:

| Field | Isi |
|---|---|
| Name | Nama yang mudah dikenali, mis. `CCTV B2 Selatan` |
| Code | Unik, tanpa spasi, mis. `CCTV_EPW_B2S`. Dipakai sebagai nama file config dan container |
| RTSP URL | Dari langkah 1 |
| Device ID | Kosongkan (dibuat otomatis). Isi hanya kalau memindahkan kamera lama dan ingin datanya tersambung |

Dashboard lalu menulis `python-counting/.env_<CODE>`, menambah service
`services-python-<code>` ke `python-counting/docker-compose.yml`, dan
mendaftarkan kamera ke stream gateway.

### 3. Atur deteksi

Buka kamera di **Detection → Devices → (kamera)**:

1. **Basic**:
   - Resolusi kerja (`SCREEN_RESOLUTION`), mis. `800×600`. **Tentukan ini
     sebelum menggambar garis**; koordinat garis terikat ke resolusi ini.
   - Model: `yolo26s_640_e2e_u8`, atau `yolo26s_1280_e2e_u8` untuk kamera
     yang orangnya kecil.
   - Mode: `line_crossing` (gerbang) atau `zone`.
   - Modul tambahan (APD, api/asap, wajah, intrusion) kalau diperlukan.
2. **Lines**: gambar garis atau zona di atas snapshot kamera. Untuk gerbang,
   pasangan garis A/B: orang harus melewati keduanya agar terhitung. Kalau
   arah IN/OUT terbalik, aktifkan `SWAP_IN_OUT`.
3. **Save Settings**, lalu **Start** (kamera baru) atau **Restart** (kamera yang sudah jalan). Save saja hanya menulis config; Restart membuat ulang container supaya config baru terbaca.

### 4. (opsional) Live view & port forward

Buka kamera di **Devices** (area utama) → tab **Stream** → **Expose CCTV URL**
untuk live view lewat stream gateway.

Kalau RTSP kamera perlu diakses langsung dari luar server: **Settings → Nginx
→ Add forward** → pilih kamera → listen port (5500–5600) → simpan. Client lalu
memakai `rtsp://<user>:<password>@<ip-server>:<listen-port>/<path RTSP asli>`.

## Verifikasi

```bash
cd /opt/ai/dashboard-python-counting/python-counting
docker logs -f services-python-<code>
```

Urutan log yang benar:

```
Successfully connected to PostgreSQL database
Video source opened successfully: rtsp://...
[Triton] Connected triton:8001 model=yolo26s_640_e2e_u8 ... e2e=True
Processing FPS: 24.6 (dropped 3 stale frames, persons/frame det=1.20 trk=1.10)
Person 12 IN through gate 0 - Total IN: 1
```

Atau di dashboard: **Settings → Logs**, pilih kamera. Pantau FPS per menit:

```bash
python3 tools/stream_health.py services-python-<code> --follow
```

## Kalau error

| Gejala (log) | Penyebab | Solusi |
|---|---|---|
| `RTSP connection failed: rtsp://...` berulang tiap 5 detik | URL salah, kredensial salah, atau kamera tidak terjangkau | Uji ulang langkah 1. Cek user/password, IP, nomor channel, dan `nc -vz <ip-nvr> 554` |
| `RTSP_URL is not set` | Field RTSP kosong | Isi RTSP di halaman device, simpan, start ulang |
| `No valid line pairs found in environment` lalu container restart terus | Mode `line_crossing` tapi tidak ada `lineA` di `.env_<CODE>` (biasanya karena diedit manual) | Gambar garis di tab Lines, Save, Restart |
| `DETECTION_MODE=zone but no zone polygons defined` | Mode `zone` tapi zona belum digambar | Gambar zona, simpan |
| `Fatal: Error on Connecting DB at Start Up` lalu container berhenti | Nilai `PG_*` di `.env_<CODE>` salah, atau DB tidak terjangkau dari container | Lihat [01-database.md](01-database.md#kalau-error) (firewall!). Kalau nilainya salah: edit `PG_*` di `python-counting/.env_<CODE>` (halaman device tidak menampilkan field ini, dan mengubah Settings global tidak mengubah kamera yang sudah ada), lalu klik **Restart** |
| `Model 'yolo26s_640_e2e_u8' is not loaded on Triton` | Nama model salah atau model gagal load | `curl -s -X POST localhost:8000/v2/repository/index`; pilih model yang `READY` |
| `INFERENCE UNAVAILABLE (Triton down)` | Triton mati | Container tidak crash, akan tersambung sendiri. Start Triton ([05](05-triton.md)) |
| Container jalan tapi tidak ada data di DB / MQTT | `DEBUG_MODE=true` di `.env_<CODE>` | Set `DEBUG_MODE='false'` di `python-counting/.env_<CODE>`, lalu **Restart**. Matikan juga Debug Mode di Detection → Settings supaya kamera baru tidak ikut |
| MQTT tidak terkirim padahal broker sehat | `MQTT_*` di `.env_<CODE>` kosong/salah (kamera dibuat sebelum Settings MQTT diisi) | Edit `MQTT_BROKER/PORT/USERNAME/PASSWORD` di `python-counting/.env_<CODE>`, lalu **Restart** |
| Perubahan setting tidak berefek | Save hanya menulis `.env_<CODE>`; `docker restart` juga tidak membaca ulang `env_file` | Klik **Restart** di halaman device (membuat ulang container), atau `docker compose up -d --force-recreate --no-deps services-python-<code>` |
| FPS < 15 | GPU penuh, model 1280 di terlalu banyak kamera, atau `FRAME_SKIP` | Cek watt di kartu GPU (≥ 90% = penuh). Pakai 640 untuk kamera yang tidak perlu 1280 |
| Gambar pecah (tearing), log `error while decoding MB` | Jaringan/kamera, atau backpressure | `stream_health.py`: kalau `dropped` kecil tapi error decode tinggi, masalahnya di jaringan/NVR (bitrate, kabel) |
| Hitungan IN/OUT terbalik | Urutan garis A/B | Aktifkan `SWAP_IN_OUT` |
| Garis tidak pas setelah ganti resolusi | Koordinat terikat ke `SCREEN_RESOLUTION` lama | Gambar ulang garis |
| Forward: *Listen port 55xx is already used by "..."* | Port sudah dipakai forward lain | Pakai port lain (form mengisi port kosong pertama secara otomatis) |
| Forward tersimpan tapi client tidak bisa konek ke `<ip-server>:55xx` | Nginx belum reload, firewall, atau kamera tidak terjangkau dari server | Settings → Nginx: cek badge *Config in sync* dan log container; buka port di firewall; `nc -vz <ip-kamera> 554` dari server |
| Add Camera: *Device with this code already exists* | Kode sudah dipakai | Pakai kode lain, atau hapus device lama dulu |
