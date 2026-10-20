# 1. Database (PostgreSQL)

## Tujuan

PostgreSQL berjalan, bisa dijangkau dari dashboard dan container kamera, dan
semua tabel EPiWalk sudah dibuat.

TimescaleDB **tidak wajib**: `init_db.py` hanya memakai fitur PostgreSQL
biasa. Image bawaan memakai TimescaleDB supaya sama dengan produksi.

Ada dua pilihan:

| Opsi | Kapan dipakai | Host dari container | Host dari luar server |
|---|---|---|---|
| **A. Bawaan** (service `timescaledb` di `dashboard/docker-compose.yml`) | Server baru, belum ada PostgreSQL | `env_services_timescaledb:5432` | `<ip-server>:5435` |
| **B. Sudah ada** (container/server PostgreSQL lain) | Server yang sudah punya DB, mis. produksi | `host.docker.internal:<port>` atau IP DB | sesuai DB |

> **Jangan jalankan Opsi A di server yang sudah punya container bernama
> `env_services_timescaledb`.** Nama container akan bentrok (lihat tabel
> error).

## Langkah

### Opsi A — PostgreSQL bawaan

```bash
cd /opt/ai/dashboard-python-counting/dashboard
cp .env.example .env               # kalau belum
nano .env                          # isi POSTGRES_PASSWORD=<password-db>
docker compose up -d timescaledb
```

`POSTGRES_PASSWORD` hanya dipakai saat volume `timescaledb_volume` dibuat
pertama kali. Mengubahnya belakangan **tidak** mengubah password database yang
sudah ada.

Buat tabel:

```bash
cd /opt/ai/dashboard-python-counting/python-counting
docker run --rm --network envisions -v "$(pwd):/app" -w /app \
  -e PG_HOST=env_services_timescaledb -e PG_PORT=5432 -e PG_DB=postgres \
  -e PG_USER=postgres -e PG_PASS='<password-db>' \
  python:3.11-slim sh -c "pip install -q psycopg2-binary python-dotenv && python init_db.py"
```

Nilai untuk dashboard nanti (langkah 6): host `env_services_timescaledb`,
port `5432`.

### Opsi B — PostgreSQL yang sudah ada

Catat host, port, user, dan password. Kalau DB-nya container di server yang
sama dengan port yang dipublish ke host (produksi: `5435`), container
menjangkaunya lewat `host.docker.internal`:

```bash
cd /opt/ai/dashboard-python-counting/python-counting
docker run --rm -v "$(pwd):/app" -w /app --add-host host.docker.internal:host-gateway \
  -e PG_HOST=host.docker.internal -e PG_PORT=5435 -e PG_DB=postgres \
  -e PG_USER=postgres -e PG_PASS='<password-db>' \
  python:3.11-slim sh -c "pip install -q psycopg2-binary python-dotenv && python init_db.py"
```

`init_db.py` **idempotent**: aman dijalankan ulang kapan saja, misalnya setelah
update kode yang menambah tabel atau kolom.

## Verifikasi

```bash
docker exec env_services_timescaledb psql -U postgres -c '\dt'
```

Harus muncul 7 tabel: `person_inout`, `inout_resample`, `apd_hourly`,
`firesmoke_hourly`, `face_hourly`, `intrusion_hourly`, `known_faces`.
Log `init_db.py` diakhiri dengan `Schema is up to date (...)`.

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Conflict. The container name "/env_services_timescaledb" is already in use` | Sudah ada PostgreSQL dengan nama itu (dari stack lain) | Pakai Opsi B. Jalankan service dashboard tanpa `timescaledb`: `docker compose up -d dashboard stream-gateway edge-portfwd-nginx nodered` |
| `docker logs env_services_timescaledb`: `exec /docker-entrypoint.sh: exec format error`, container restart terus | Image untuk arsitektur CPU lain (mis. `timescaledb-ha` yang hanya amd64, dijalankan di Jetson/ARM) | Pakai image multi-arch `timescale/timescaledb:latest-pg14` (default compose sekarang), lalu `docker compose pull timescaledb && docker compose up -d --force-recreate timescaledb`. Kalau volume lama sudah berisi data dari image `-ha`, dump dulu (`pg_dumpall`) sebelum ganti image |
| `refers to undefined volume timescaledb_volume` | Volume belum dideklarasikan di bagian `volumes:` compose | Pastikan `timescaledb_volume:` ada di bagian `volumes:` paling bawah |
| `The "POSTGRES_PASSWORD" variable is not set` lalu container DB gagal init | `.env` belum berisi `POSTGRES_PASSWORD` | Isi di `dashboard/.env`, lalu `docker compose up -d timescaledb` |
| `password authentication failed for user "postgres"` | Password salah, atau volume sudah berisi DB lama dengan password lain | Pakai password lama. Untuk mulai dari nol: `docker compose down` lalu `docker volume rm dashboard_timescaledb_volume` (**menghapus semua data**) |
| `could not translate host name "env_services_timescaledb"` | Container yang menjalankan perintah tidak di network `envisions` | Tambahkan `--network envisions` |
| `could not translate host name "host.docker.internal"` | Flag `--add-host` lupa (Opsi B) | Tambahkan `--add-host host.docker.internal:host-gateway` |
| `Connection refused` | Container DB belum jalan atau port salah | `docker ps`, `docker logs env_services_timescaledb` |
| `Connection timed out` dari container ke `host.docker.internal` (Opsi B) | Firewall (UFW) memblokir trafik dari jaringan Docker ke port host | `sudo ufw allow from 172.16.0.0/12 to any port 5435 proto tcp`, atau pindahkan DB ke network `envisions` |
| `Bind for 0.0.0.0:5435 failed: port is already allocated` | Port 5435 dipakai service lain | Ganti port host di compose. Container lain tetap memakai port `5432` lewat nama container |
| Container DB restart terus | Volume rusak atau disk penuh | `docker logs env_services_timescaledb`, cek `df -h /data` |
