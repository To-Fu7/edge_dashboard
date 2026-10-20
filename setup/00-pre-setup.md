# 0. Pre-setup

## Tujuan

Server siap menjalankan container yang memakai GPU, data Docker tersimpan di
SSD/NVMe, dan repo sudah ada di disk.

## Kebutuhan

| Komponen | Minimal | Produksi saat ini |
|---|---|---|
| OS | Ubuntu 22.04 / 24.04 x86_64 | Ubuntu |
| GPU | NVIDIA dengan dukungan TensorRT (Turing ke atas) | RTX 2000 Ada (70 W, 16 GB) untuk 14 kamera |
| Storage | **SSD/NVMe** untuk data aplikasi + Docker | NVMe di `/data` |
| RAM | 16 GB | — |
| Jaringan | Server bisa menjangkau RTSP kamera/NVR | — |

> **Jangan taruh data Docker dan `/opt/ai` di HDD.** Di produksi, HDD
> membuat journal ext4 macet beberapa detik dan **semua kamera tersendat
> bersamaan**. Setelah pindah ke NVMe masalahnya hilang.

### Port yang dipakai

| Port | Service | Perlu dibuka ke jaringan? |
|---|---|---|
| 3001/tcp | Dashboard | Ya (operator) |
| 8555/tcp, 8189/udp | Stream gateway (HLS/MSE, WebRTC) | Ya (browser) |
| 5500–5600/tcp | Port-forward RTSP (nginx) | Hanya kalau dipakai |
| 1880/tcp | Node-RED langsung (debug) | Tidak perlu; dashboard mem-proxy `/nodered` |
| 8000–8002/tcp | Triton HTTP/gRPC/metrics | Tidak perlu dari luar |
| 5435/tcp | PostgreSQL bawaan | Hanya kalau sistem lain membaca DB |
| 1884/tcp, 9001/tcp | MQTT bawaan (MQTT, websocket) | Ya, untuk konsumen MQTT di luar server |

## Langkah

### 1. Driver NVIDIA

```bash
sudo ubuntu-drivers list            # lihat driver yang tersedia
sudo ubuntu-drivers install         # atau: sudo apt install nvidia-driver-<versi>
sudo reboot
nvidia-smi                          # harus menampilkan GPU + versi driver
```

Image Triton `24.08` dibangun dengan CUDA 12.6. Pakai driver yang cukup baru
untuk CUDA 12.6 (cek tabel di release notes Triton untuk tag yang dipakai).

### 2. Docker Engine + Compose

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker                       # atau logout/login
docker version && docker compose version
```

### 3. NVIDIA Container Toolkit (GPU di dalam container)

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo mkdir -p /etc/cdi && sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml   # Docker 28+ (CDI)
sudo systemctl restart docker
```

### 4. Storage di NVMe

Contoh: NVMe di-mount ke `/data`.

```bash
# 4a. Mount permanen (pakai UUID, bukan /dev/nvme0n1p1)
sudo blkid /dev/nvme0n1p1
echo 'UUID=<uuid> /data ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mkdir -p /data && sudo mount -a && sudo findmnt --verify

# 4b. Data Docker ke NVMe
sudo systemctl stop docker docker.socket containerd
echo '{ "data-root": "/data/docker" }' | sudo tee /etc/docker/daemon.json
#   Kalau `docker info` menunjukkan containerd image store (driver "overlayfs"),
#   pindahkan juga root containerd: di /etc/containerd/config.toml set
#   root = "/data/containerd"
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/data\n' | sudo tee /etc/systemd/system/docker.service.d/10-data-mount.conf
sudo systemctl daemon-reload && sudo systemctl start containerd docker

# 4c. Folder aplikasi di NVMe
sudo mkdir -p /data/ai /opt/ai
echo '/data/ai /opt/ai none bind 0 0' | sudo tee -a /etc/fstab
sudo mount -a
sudo chown -R $USER: /data/ai
```

`RequiresMountsFor=/data` mencegah Docker menyala sebelum NVMe ter-mount.
Tanpa itu, container bisa jalan dengan folder kosong setelah reboot.

### 5. Clone repo

```bash
cd /opt/ai
git clone <url-repo> dashboard-python-counting
cd dashboard-python-counting
git checkout edge
```

Struktur folder **harus dipertahankan**: compose dashboard me-mount
`../python-counting` dan build `../stream-gateway`.

## Verifikasi

```bash
nvidia-smi                                                       # GPU terlihat di host
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi   # GPU terlihat di container
docker info --format '{{.DockerRootDir}}'                        # /data/docker
findmnt /data && findmnt /opt/ai                                 # keduanya ter-mount
ls /opt/ai/dashboard-python-counting                             # dashboard  python-counting  stream-gateway ...
```

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `nvidia-smi`: *NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver* | Driver belum termuat (belum reboot, atau Secure Boot memblokir modul) | Reboot. Kalau masih gagal, nonaktifkan Secure Boot di BIOS atau enroll MOK saat instal driver |
| `permission denied while trying to connect to the Docker daemon socket` | User belum di grup `docker` | `sudo usermod -aG docker $USER`, lalu logout/login |
| `could not select device driver "" with capabilities: [[gpu]]` | NVIDIA Container Toolkit belum terpasang/terkonfigurasi | Ulangi langkah 3, lalu `sudo systemctl restart docker` |
| `failed to discover GPU vendor from CDI: no known GPU vendor found` | Docker 28+ memakai CDI untuk `--gpus`, tapi spec CDI NVIDIA belum dibuat (atau toolkit belum terpasang walau `daemon.json` sudah menyebut runtime `nvidia`) | Pasang toolkit (langkah 3), lalu `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml && sudo systemctl restart docker` |
| Jetson: installer berhenti dengan *Docker has no 'nvidia' runtime* | Docker diinstal/di-upgrade dari docker.com (bukan versi JetPack), sehingga registrasi runtime NVIDIA hilang | `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`. Kalau `nvidia-ctk` tidak ada: `sudo apt-get install -y nvidia-container` dulu. Installer terbaru menawarkan perbaikan ini sendiri |
| `unknown or invalid runtime name: nvidia` | `nvidia-ctk runtime configure` belum dijalankan | `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` |
| `CUDA driver version is insufficient for CUDA runtime version` (saat test atau Triton) | Driver terlalu tua untuk image | Upgrade driver (langkah 1) |
| Docker tidak mau start setelah ganti `data-root` | Folder baru tidak ada, atau JSON `daemon.json` salah | `sudo mkdir -p /data/docker`, cek `sudo journalctl -u docker -n 50`, validasi JSON |
| Image/container "hilang" setelah pindah `data-root` | Data lama masih di `/var/lib/docker` | Normal. Pull/build ulang, atau salin isi lama sebelum start (`rsync -aHAX /var/lib/docker/ /data/docker/`) |
| Setelah reboot container jalan tapi datanya kosong | Docker start sebelum NVMe ter-mount | Pastikan drop-in `RequiresMountsFor=/data` ada (langkah 4b) |
| `mount -a` error / server tidak boot setelah edit fstab | Baris fstab salah | Cek `sudo findmnt --verify` **sebelum** reboot. Kalau sudah terlanjur, boot recovery mode dan perbaiki `/etc/fstab` |
| `git clone` minta password terus | Belum ada akses ke repo | Pakai SSH key (`ssh-keygen`, tambahkan public key ke Git host) |
