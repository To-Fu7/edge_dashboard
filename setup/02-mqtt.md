# 2. MQTT broker

## Tujuan

Broker MQTT menerima pesan dari container kamera, dan konsumen (Node-RED,
aplikasi lain) bisa subscribe.

| Opsi | Kapan dipakai | Host dari container | Host dari luar server |
|---|---|---|---|
| **A. Bawaan** (service `mqtt` di `dashboard/docker-compose.yml`) | Belum ada broker | `env_services_mqtt:1883` | `<ip-server>:1884` (MQTT), `:9001` (websocket) |
| **B. Sudah ada** | Broker lain, mis. produksi `10.11.0.34:1883` | IP/host broker | sama |

Port host bawaan adalah **1884**, bukan 1883, supaya tidak bentrok dengan
broker lain di server yang sama. Container di network `envisions` tetap
memakai port `1883`.

## Langkah

### Opsi A — Mosquitto bawaan

Config ada di `dashboard/mosquitto/config/mosquitto.conf` (listener 1883,
websocket 9001, tanpa login).

```bash
cd /opt/ai/dashboard-python-counting/dashboard
docker compose up -d mqtt
```

Nilai untuk dashboard nanti (langkah 6): broker `env_services_mqtt`, port
`1883`.

Untuk memakai login: buat file password, lalu ubah config:

```bash
docker exec -it env_services_mqtt mosquitto_passwd -c /mosquitto/config/passwd <user>
# di mosquitto.conf: ganti "allow_anonymous true" dengan
#   allow_anonymous false
#   password_file /mosquitto/config/passwd
docker compose restart mqtt
```

Entrypoint image mengubah owner folder `dashboard/mosquitto/` ke user
mosquitto. Kalau ingin mengedit `mosquitto.conf` dari host, pakai `sudo`.

### Opsi B — Broker yang sudah ada

Catat alamat, port, username, dan password, lalu lakukan verifikasi dari
server ini.

## Verifikasi

Opsi A, buka dua terminal:

```bash
# terminal 1: dengarkan semua topic
docker exec -it env_services_mqtt mosquitto_sub -h localhost -t '#' -v

# terminal 2: kirim pesan uji
docker exec env_services_mqtt mosquitto_pub -h localhost -t test/epiwalk -m halo
```

Terminal 1 harus menampilkan `test/epiwalk halo`.

Uji dari jaringan container (seperti container kamera) atau ke broker lain:

```bash
docker run --rm --network envisions eclipse-mosquitto:2.0 \
  mosquitto_pub -h env_services_mqtt -p 1883 -t test/epiwalk -m halo
docker run --rm eclipse-mosquitto:2.0 mosquitto_pub -h <ip-broker> -p <port> -t test/epiwalk -m halo
```

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| Container `env_services_mqtt` restart terus, log `Error: Unable to open config file` | `dashboard/mosquitto/config/mosquitto.conf` tidak ada | `git pull` (file ada di repo), atau buat ulang sesuai isi di repo, lalu `docker compose up -d mqtt` |
| Client dari luar tidak bisa konek, dari dalam container bisa | Config tanpa `listener 1883` (Mosquitto 2 default hanya lokal) | Pastikan `listener 1883` ada di config, `docker compose restart mqtt` |
| Client dari luar konek ke port 1883 gagal | Port host bawaan 1884 | Pakai `<ip-server>:1884` dari luar server |
| `Connection Refused: not authorised` | Broker butuh login | Isi username/password yang benar di Detection → Settings → MQTT |
| `Error: Connection refused` | Broker tidak jalan atau port salah | `docker ps`, `docker logs env_services_mqtt` |
| Timeout ke broker di mesin lain | Firewall / routing | `nc -vz <ip-broker> <port>`; buka port di firewall broker |
| `Bind for 0.0.0.0:1884 failed` / `:9001 failed` | Port host dipakai service lain | Ganti port host di compose |
| Container kamera log `MQTT client not initialized` | `MQTT_BROKER` kosong/salah di `.env_<CODE>` | Edit `python-counting/.env_<CODE>`, lalu Restart kamera dari dashboard. Isi juga Detection → Settings → MQTT untuk kamera berikutnya |
