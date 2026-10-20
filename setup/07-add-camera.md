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
docker run --rm edge-device:latest python -c \
  "import cv2;c=cv2.VideoCapture('<rtsp-url>');ok,f=c.read();print(ok, None if f is None else f.shape)"
# True (1080, 1920, 3)  ← resolusi asli kamera
```

### 2. Tambah dari dashboard

**Devices → Add Camera**:

| Field | Isi |
|---|---|
| Name | Nama yang mudah dikenali, mis. `CCTV B2 Selatan` |
| Code | Unik, tanpa spasi, mis. `CCTV_EPW_B2S`. Dipakai untuk nama container (`device-cctv-epw-b2s`) dan topic MQTT. Bisa diganti nanti |
| RTSP URL | Dari langkah 1 |
| Device ID | Kosongkan (UUID dibuat otomatis). Isi hanya kalau memindahkan kamera lama dan ingin hasil hitungannya tersambung |

Dashboard menyimpan kamera di database `edge`, membuat container
`device-<code>` lewat Docker (belum dijalankan), dan mendaftarkan kamera ke
stream gateway. Kamera mewarisi semua nilai dari Settings (MQTT, model,
confidence, FPS limit, dst.).

Banyak kamera sekaligus, atau pindah dari PC lain: **Export** di PC lama →
**Import** di PC baru (halaman Devices). Kode yang sudah ada dilewati.

### 3. Atur deteksi

Buka kamera di **Devices → (kamera)**:

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
3. **Save Settings**, lalu **Start** untuk kamera baru.

Perubahan berikutnya **langsung berlaku tanpa Restart**: setelah Save, kamera
yang sedang jalan menerima konfigurasi baru dalam hitungan detik. Nilai
ringan (tag, topic MQTT, JPEG quality, FPS limit, frame skip, cooldown,
threshold wajah, nama) diterapkan di tempat; yang lain (RTSP, model, garis,
resolusi, broker MQTT) membuat container restart sendiri ±5 detik. Hitungan
hari ini tidak hilang.

Setiap field yang diwarisi dari Settings bertanda **global**; kalau diubah di
kamera ini jadi **custom** dengan tombol **reset**. Tab **History** menyimpan
setiap versi konfigurasi, dan bisa dikembalikan ke versi sebelumnya.

### 4. (opsional) Live view & port forward

Buka kamera di **Devices** (area utama) → tab **Stream** → **Expose CCTV URL**
untuk live view lewat stream gateway.

Kalau RTSP kamera perlu diakses langsung dari luar server: **Settings → Nginx
→ Add forward** → pilih kamera → listen port (5500–5600) → simpan. Client lalu
memakai `rtsp://<user>:<password>@<ip-server>:<listen-port>/<path RTSP asli>`.

## Verifikasi

Di **Dashboard**, kartu kamera harus berstatus **Running** dengan
FPS dan hitungan IN/OUT. Lewat log:

```bash
docker logs -f device-<code>
```

Urutan log yang benar:

```
[bootstrap] loaded config v1 for CCTV_EPW_B2S from the database
[config] watching for changes (v1)
Successfully connected to PostgreSQL database
Video source opened successfully: rtsp://...
[Triton] Connected triton:8001 model=yolo26s_640_e2e_u8 ... e2e=True
Processing FPS: 24.6 (dropped 3 stale frames, persons/frame det=1.20 trk=1.10)
Person 12 IN through gate 0 - Total IN: 1
```

Atau di dashboard: **Settings → Logs**, pilih kamera. Pantau FPS per menit:

```bash
python3 tools/stream_health.py device-<code> --follow
```

## Kalau error

| Gejala (log) | Penyebab | Solusi |
|---|---|---|
| `RTSP connection failed: rtsp://...` berulang tiap 5 detik | URL salah, kredensial salah, atau kamera tidak terjangkau | Uji ulang langkah 1. Cek user/password, IP, nomor channel, dan `nc -vz <ip-nvr> 554` |
| `RTSP_URL is not set` | Field RTSP kosong | Isi RTSP di halaman device, simpan, start ulang |
| `No valid line pairs found in environment` lalu container restart terus | Mode `line_crossing` tapi belum ada garis | Gambar garis di tab Lines, Save |
| `DETECTION_MODE=zone but no zone polygons defined` | Mode `zone` tapi zona belum digambar | Gambar zona, Save |
| `[bootstrap] database unavailable and no cached config yet ... retrying` | Container tidak bisa login ke database `edge` sebagai `edge_device` | Cek `EDGE_DB_HOST` / `EDGE_DEVICE_DB_PASSWORD` di `dashboard/.env` ([01 → Kalau error](01-database.md#kalau-error)). Setelah diperbaiki: `docker compose up -d dashboard`, lalu hapus container kamera (`docker rm -f device-<code>`) dan Start lagi agar kredensial baru terpasang |
| `[bootstrap] database unavailable ...; using cached config` | DB sedang tidak terjangkau, kamera jalan dengan config terakhir | Normal untuk gangguan sesaat. Hasil hitungan tetap antre di container dan ditulis saat DB kembali |
| `[bootstrap] device ... does not exist in the database` | Kamera sudah dihapus tapi container lama masih ada | `docker rm -f device-<code>` (dashboard juga membersihkannya saat restart) |
| `Model 'yolo26s_640_e2e_u8' is not loaded on Triton` | Nama model salah atau model gagal load | `curl -s -X POST localhost:8000/v2/repository/index`; pilih model yang `READY` |
| Kartu kamera **Degraded**, log `INFERENCE UNAVAILABLE (Triton down)` | Triton mati | Container tidak crash, akan tersambung sendiri. Start Triton ([05](05-triton.md)) |
| Kartu kamera **No signal** | Container berhenti melapor lebih dari 45 detik (hang, crash loop) | `docker logs --tail 50 device-<code>`; Restart dari dashboard |
| Kartu menampilkan *applying vN…* lama sekali | Kamera belum menerima konfigurasi baru (DB terputus, atau sedang restart karena perubahan berat) | Tunggu ±1 menit (ada pengecekan berkala); kalau tetap, Restart |
| Tidak ada data di MQTT padahal broker sehat | Broker/kredensial di Settings → MQTT salah | Perbaiki di Settings → MQTT; semua kamera menerapkannya otomatis (restart singkat) |
| FPS < 15 | GPU penuh, model 1280 di terlalu banyak kamera, atau `FRAME_SKIP` | Cek watt di kartu GPU (≥ 90% = penuh). Pakai 640 untuk kamera yang tidak perlu 1280 |
| Gambar pecah (tearing), log `error while decoding MB` | Jaringan/kamera, atau backpressure | `stream_health.py`: kalau `dropped` kecil tapi error decode tinggi, masalahnya di jaringan/NVR (bitrate, kabel) |
| Hitungan IN/OUT terbalik | Urutan garis A/B | Aktifkan `SWAP_IN_OUT` |
| Garis tidak pas setelah ganti resolusi | Koordinat terikat ke `SCREEN_RESOLUTION` lama | Gambar ulang garis |
| Forward: *Listen port 55xx is already used by "..."* | Port sudah dipakai forward lain | Pakai port lain (form mengisi port kosong pertama secara otomatis) |
| Forward tersimpan tapi client tidak bisa konek ke `<ip-server>:55xx` | Nginx belum reload, firewall, atau kamera tidak terjangkau dari server | Settings → Nginx: cek badge *Config in sync* dan log container; buka port di firewall; `nc -vz <ip-kamera> 554` dari server |
| Add Camera: *Device with this code already exists* | Kode sudah dipakai | Pakai kode lain, atau hapus device lama dulu |
