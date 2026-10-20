# 1. Database (PostgreSQL)

## Tujuan

PostgreSQL berjalan, dan database **`edge`** beserta dua role aplikasinya
sudah dibuat. Semua data Edge ada di database ini: kamera dan konfigurasinya,
settings, user dashboard, hasil hitungan, serta wajah ter-enroll.

| Role | Dipakai oleh | Hak |
|---|---|---|
| `edge_owner` | dashboard | Pemilik database `edge` dan semua tabel; menjalankan migrasi skema |
| `edge_device` | container kamera | Membaca konfigurasinya sendiri, menulis hasil hitungan & status. Tidak bisa membaca user/settings atau mengubah konfigurasi |

**Tabel dibuat otomatis oleh dashboard** saat start (migrasi di
`dashboard/db/migrations/`). Langkah ini hanya membuat database dan role.

TimescaleDB **tidak wajib**: skema hanya memakai fitur PostgreSQL biasa.
Image bawaan memakai TimescaleDB supaya sama dengan produksi.

> **Pakai installer?** `setup/install.sh` mengerjakan semua langkah di bawah
> (termasuk membuat password role) dan menulisnya ke `dashboard/.env`.

Ada dua pilihan server:

| Opsi | Kapan dipakai | Host dari container | Host dari luar server |
|---|---|---|---|
| **A. Bawaan** (service `timescaledb` di `dashboard/docker-compose.yml`) | Server baru, belum ada PostgreSQL | `env_services_timescaledb:5432` | `<ip-server>:5435` |
| **B. Sudah ada** (container/server PostgreSQL lain) | Server yang sudah punya PostgreSQL | nama container (kalau di network `envisions`) atau `host.docker.internal:<port>` | sesuai DB |

> **Jangan jalankan Opsi A di server yang sudah punya container bernama
> `env_services_timescaledb`.** Nama container akan bentrok (lihat tabel error).

## Langkah

### 1. Server PostgreSQL

**Opsi A — bawaan:**

```bash
cd /opt/ai/dashboard-python-counting/dashboard
cp .env.example .env               # kalau belum
nano .env                          # isi POSTGRES_PASSWORD=<password-superuser>
docker compose up -d timescaledb
```

`POSTGRES_PASSWORD` adalah password superuser `postgres`. Password ini hanya
dipakai saat volume `timescaledb_volume` dibuat pertama kali; mengubahnya
belakangan **tidak** mengubah password database yang sudah ada.

**Opsi B — sudah ada:** siapkan host, port, dan kredensial superuser.

### 2. Database `edge` + role

Buat dua password (mis. `openssl rand -hex 12`), lalu jalankan sebagai superuser.
Script ini aman diulang; password role diperbarui setiap kali dijalankan.

```bash
OWNER_PW=<password-edge_owner>
DEVICE_PW=<password-edge_device>

# Opsi A
docker exec -i env_services_timescaledb psql -U postgres -v ON_ERROR_STOP=1 \
  -v owner_pw="$OWNER_PW" -v device_pw="$DEVICE_PW" <<'SQL'
SELECT format('CREATE ROLE edge_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_owner') \gexec
SELECT format('CREATE ROLE edge_device LOGIN PASSWORD %L', :'device_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_device') \gexec
SELECT format('ALTER ROLE edge_owner LOGIN PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE edge_device LOGIN PASSWORD %L', :'device_pw') \gexec
SELECT 'CREATE DATABASE edge OWNER edge_owner' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'edge') \gexec
REVOKE CONNECT ON DATABASE edge FROM PUBLIC;
GRANT CONNECT ON DATABASE edge TO edge_owner, edge_device;
\c edge
ALTER SCHEMA public OWNER TO edge_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
```

Untuk Opsi B, ganti baris pertama dengan
`docker run --rm -i --network envisions -e PGPASSWORD=<superuser-pw> postgres:16-alpine psql -h <host> -p <port> -U <superuser> -v ON_ERROR_STOP=1 -v owner_pw=... -v device_pw=... <<'SQL'`.

### 3. Tulis koneksi ke `dashboard/.env`

```
EDGE_DB_HOST=env_services_timescaledb     # Opsi B: host yang dijangkau dari container
EDGE_DB_PORT=5432
EDGE_DB_NAME=edge
EDGE_DB_USER=edge_owner
EDGE_DB_PASSWORD=<password-edge_owner>
EDGE_DEVICE_DB_USER=edge_device
EDGE_DEVICE_DB_PASSWORD=<password-edge_device>
```

Dashboard memakai `edge_owner`; ke container kamera ia hanya meneruskan
kredensial `edge_device`.

## Verifikasi

```bash
docker exec env_services_timescaledb psql -U postgres -c '\l edge' -c '\du edge_*'
```

Setelah dashboard jalan ([06](06-dashboard.md)), tabelnya sudah dibuat:

```bash
docker exec env_services_timescaledb psql -U postgres -d edge -c '\dt'
curl -s localhost:3001/api/health        # "schema":"001_edge_schema.sql"
```

## Kalau error

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Conflict. The container name "/env_services_timescaledb" is already in use` | Sudah ada PostgreSQL dengan nama itu (dari stack lain) | Pakai Opsi B. Jalankan service dashboard tanpa `timescaledb`: `docker compose up -d --build dashboard stream-gateway edge-portfwd-nginx nodered` |
| `The "POSTGRES_PASSWORD" variable is not set` lalu container DB gagal init | `.env` belum berisi `POSTGRES_PASSWORD` | Isi di `dashboard/.env`, lalu `docker compose up -d timescaledb` |
| `password authentication failed for user "postgres"` | Password superuser salah, atau volume berisi DB lama dengan password lain | Pakai password lama. Mulai dari nol: `docker compose down` lalu `docker volume rm dashboard_timescaledb_volume` (**menghapus semua data**) |
| `password authentication failed for user "edge_owner"` di log dashboard / `/api/health` | `EDGE_DB_PASSWORD` di `.env` beda dengan password role | Jalankan ulang langkah 2 dengan password yang sama seperti di `.env` (atau `./setup/install.sh --from infra`), lalu `docker compose up -d dashboard` |
| `/api/health`: `Database "edge" does not exist` | Langkah 2 belum dijalankan di server ini | Jalankan langkah 2 |
| Kamera log `[bootstrap] database unavailable ... retrying` | Container kamera tidak bisa login sebagai `edge_device` atau tidak menjangkau host DB | Cek `EDGE_DEVICE_DB_PASSWORD` dan `EDGE_DB_HOST` di `dashboard/.env` (host harus bisa dijangkau dari network `envisions`), lalu Restart kamera |
| `no pg_hba.conf entry for host ... user "edge_device"` | Server PostgreSQL (Opsi B) menolak login password dari jaringan Docker | Tambahkan baris `host edge edge_device 172.16.0.0/12 scram-sha-256` (dan `edge_owner`) di `pg_hba.conf`, reload PostgreSQL |
| `Connection timed out` ke `host.docker.internal` | Firewall memblokir jaringan Docker ke port host, atau DB hanya listen di 127.0.0.1 | Sambungkan container DB ke network `envisions` dan pakai namanya, atau `sudo ufw allow from 172.16.0.0/12 to any port <port> proto tcp` |
| `Bind for 0.0.0.0:5435 failed: port is already allocated` | Port 5435 dipakai service lain | Ganti port host di compose; container tetap memakai `5432` lewat nama container |
