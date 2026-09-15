# Implementation Plan - Edge Management with Activation Code (ENVI-XXX) & Bidirectional Sync

Membangun modul **Edge Management** lengkap (Frontend Next.js + Backend AdonisJS) untuk mengelola, meregistrasi, dan menghubungkan perangkat Edge fisik dengan platform Envisions menggunakan mekanisme **Activation Code** berawalan `ENVI-` (contoh: `ENVI-8B4B-40B7`) serta komunikasi dua arah (*bidirectional data pull/push*) langsung melalui Envisions REST API.

> [!NOTE]
> Modul ini menggunakan komunikasi langsung (*native*) ke Envisions Backend API tanpa pihak ketiga (GCP Pub/Sub / GCS / external relay ditiadakan).

---

## 1. Fitur Utama & Alur Kerja Sistem

```
┌────────────────────────────────────────────────────────┐
│               Cloud Platform (Envisions)               │
│                                                        │
│  [Web Dashboard] ◄──► [AdonisJS REST API]              │
│  (/admin/manage/edge)  (/api/v2.1/edges & /edge)       │
│                               ▲                        │
└───────────────────────────────┼────────────────────────┘
                                │
                  Activation Code: ENVI-XXXX-XXXX
                  Heartbeat (30-60s) & Data Sync
                                │
                                ▼
┌────────────────────────────────────────────────────────┐
│                  Edge Device (Hardware)                │
│                                                        │
│  - Edge Daemon Service / Local Agent                   │
│  - Unique MAC Address, Hardware Telemetry (CPU/RAM)    │
│  - AI Analytics, CCTV Feeds, Local Buffer Storage      │
└────────────────────────────────────────────────────────┘
```

### A. Alur Aktivasi dengan Activation Code (`ENVI-XXXX-XXXX`)
1. **Registrasi di Cloud Dashboard**:
   - Admin membuat perangkat edge baru melalui tombol **`+ Register New Edge`** di `/admin/manage/edge`.
   - Admin menginput: *Edge Name*, *Site Address*, *Area / Lokasi (opsional)*, *Notes*, dan *License Tier*.
   - Cloud membuat record dengan status **`Pending`**, men-generate:
     - `unique_key`: UUID unik permanen (contoh: `efe88429-1f9a-4c24-b465-eeae7e6e7b9d`).
     - `activation_code`: Kode acak berawalan **`ENVI-`** (contoh: `ENVI-8B4B-40B7`).
2. **Setup Praktis via Terminal One-Liner (Saran 1)**:
   - Pada halaman detail, tersedia tombol **`Copy Setup Command`** berisi curl one-liner untuk memudahkan teknisi lapangan saat mengonfigurasi perangkat edge melalui SSH:
     ```bash
     curl -X POST https://api.envisionsapp.com/api/v2.1/edge/activate \
       -H "Content-Type: application/json" \
       -d '{"activation_code": "ENVI-8B4B-40B7"}'
     ```
3. **Aktivasi dari Perangkat Edge ke Cloud**:
   - Operator mengeksekusi aktivasi dari daemon/terminal edge.
   - Endpoint publik: `POST /api/v2.1/edge/activate` menerima payload:
     ```json
     {
       "activation_code": "ENVI-8B4B-40B7",
       "mac_address": "00:15:5d:17:2a:25",
       "ip_address": "192.168.1.120",
       "system_info": { "cpu_model": "ARM64", "total_ram": "8GB", "os": "Ubuntu 22.04" }
     }
     ```
   - Backend memverifikasi kode, mengupdate status menjadi **`Active`**, mencatat `activated_at`, mengosongkan `activation_code` (*single-use*), dan menerbitkan `device_token` permanen.
4. **Regenerate Code & Reset Status (Saran 3)**:
   - Tombol **`Regenerate Code`**: Menghasilkan kode `ENVI-` baru jika belum sempat dipakai.
   - Tombol **`Reset to Pending`**: Jika perangkat di lapangan diganti/di-flash ulang, admin dapat mereset perangkat ke status pending untuk dihubungkan ulang.
   - Tombol **`Revoke Access`**: Menonaktifkan token jika perangkat hilang/rusak.

---

### B. Deteksi Status Otomatis & Heartbeat (Saran 2)
1. **Heartbeat Ringan**:
   - Edge mengirim heartbeat berkala (`POST /api/v2.1/edge/heartbeat`) setiap 30–60 detik dengan menyertakan metrik hardware terkini (CPU usage %, RAM usage %, Disk, Uptime).
2. **Kalkulasi Status Dinamis**:
   - **`Pending`**: Belum pernah melakukan aktivasi pertama kali (kuning/oranye).
   - **`Online / Active`**: Sudah aktif dan `last_seen_at` < 3 menit yang lalu (hijau emerald).
   - **`Offline`**: Sudah pernah aktif namun `last_seen_at` >= 3 menit yang lalu (abu-abu / red status indicator).
   - Memastikan status dashboard selalu akurat tanpa beban background cron berlebih.

---

### C. Alur Komunikasi Dua Arah (Bidirectional Data Pull & Push)
1. **Cloud Aplikasi ➔ Edge**:
   - **Pull Data**: Cloud mengirim permintaan snapshot data terkini (status sensor, metrics CPU/RAM/suhu, log analitik AI, status kamera) ke Edge.
   - **Push Command / Settings**: Cloud mengirimkan update konfigurasi deteksi, jadwal, atau perintah restart agent.
2. **Edge ➔ Cloud Aplikasi**:
   - **Push Data / Events**: Edge mengirimkan telemetri berkala, deteksi analitik AI, dan alarm langsung ke endpoint Cloud API (`POST /api/v2.1/edge/data`).

---

## 2. Proposed Changes

### Backend (AdonisJS 6 - `/home/muliaabdi/www/backend`)

#### [NEW] [create_edge_devices_tables.ts](file:///home/muliaabdi/www/backend/database/migrations/1783600000000_create_edge_devices_tables.ts)
- Membuat tabel `edge_devices`:
  - `id` (UUID Primary Key)
  - `company_id` (UUID FK ke `companies.id`, tenant scope)
  - `workspace_id` (UUID nullable)
  - `area_id` (UUID nullable, relasi ke master data area Envisions - Saran 4)
  - `name` (VARCHAR(150), nama perangkat)
  - `site_address` (VARCHAR(255) nullable)
  - `status` (VARCHAR(50), default `'pending'`, nilai: `'pending'`, `'active'`, `'offline'`, `'suspended'`)
  - `activation_code` (VARCHAR(50) nullable, index, prefix `ENVI-`)
  - `unique_key` (UUID unik)
  - `mac_address` (VARCHAR(50) nullable)
  - `ip_address` (VARCHAR(50) nullable)
  - `notes` (TEXT nullable)
  - `license_tier` (VARCHAR(50) default `'standard'`)
  - `system_info` (JSONB nullable, info hardware: CPU, RAM, OS, model)
  - `telemetry_latest` (JSONB nullable, CPU %, RAM %, disk, uptime dari heartbeat terakhir)
  - `activated_at` (TIMESTAMPTZ nullable)
  - `last_seen_at` (TIMESTAMPTZ nullable)
  - `device_token` (VARCHAR(255) nullable)
  - `created_at`, `updated_at`, `deleted_at` (soft delete)
- Membuat tabel `edge_sync_logs`:
  - `id` (UUID Primary Key)
  - `edge_device_id` (UUID FK ke `edge_devices.id`)
  - `direction` (VARCHAR: `'pull'` atau `'push'`)
  - `type` (VARCHAR: `'telemetry'`, `'snapshot'`, `'command'`, `'status'`)
  - `payload` (JSONB)
  - `status` (VARCHAR: `'success'`, `'failed'`, `'pending'`)
  - `created_at` (TIMESTAMPTZ)

#### [NEW] [edge_device.ts](file:///home/muliaabdi/www/backend/app/models/edge_device.ts)
- Model Lucid ORM untuk `edge_devices` lengkap dengan getter dinamis `is_online` (berdasarkan `last_seen_at` < 3 menit) serta relasi ke `area` dan `sync_logs`.

#### [NEW] [edge_sync_log.ts](file:///home/muliaabdi/www/backend/app/models/edge_sync_log.ts)
- Model Lucid ORM untuk `edge_sync_logs`.

#### [NEW] [edge_devices_controller.ts](file:///home/muliaabdi/www/backend/app/controllers/core/edge_devices_controller.ts)
1. **Admin Management Endpoints** (`auth:api`):
   - `GET /api/v2.1/edges`: List edges (filter status, search, pagination, include area relation).
   - `POST /api/v2.1/edges`: Pendaftaran edge baru, generate `unique_key` & `activation_code` (`ENVI-XXXX-XXXX`).
   - `GET /api/v2.1/edges/:id`: Detail perangkat edge, hardware specs, dan riwayat log sinkronisasi.
   - `PUT /api/v2.1/edges/:id`: Update nama, site address, area_id, notes, license tier.
   - `DELETE /api/v2.1/edges/:id`: Soft delete perangkat edge.
   - `POST /api/v2.1/edges/:id/regenerate-code`: Regenerasi kode aktivasi baru `ENVI-XXXX-XXXX`.
   - `POST /api/v2.1/edges/:id/revoke`: Revoke token akses perangkat edge (Saran 3).
   - `POST /api/v2.1/edges/:id/reset`: Reset perangkat ke status pending dan buat kode aktivasi baru (Saran 3).
   - `POST /api/v2.1/edges/:id/pull`: Memicu pull snapshot data dari edge.
   - `POST /api/v2.1/edges/:id/push-command`: Mengirim perintah ke edge.
2. **Device-facing Endpoints** (Publik / Token Header):
   - `POST /api/v2.1/edge/activate`: Validasi kode aktivasi `ENVI-`, pasangkan MAC/IP, aktifkan perangkat, return token.
   - `POST /api/v2.1/edge/heartbeat`: Update `last_seen_at` dan telemetri hardware (CPU, RAM, temp).
   - `POST /api/v2.1/edge/data`: Menerima kiriman data analitik / log event dari edge.
   - `GET /api/v2.1/edge/commands`: Mengambil antrean perintah dari cloud.

#### [NEW] [simulate_edge.ts](file:///home/muliaabdi/www/backend/scripts/simulate_edge.ts) (Saran 5)
- Script simulator CLI untuk developer/tester:
  - Mensimulasikan perangkat edge fisik: melakukan aktivasi dengan kode `ENVI-`, mengirim heartbeat metrik CPU/RAM setiap 10 detik, dan mengirim data deteksi AI untuk verifikasi visual instan di dashboard.

#### [MODIFY] [core.ts](file:///home/muliaabdi/www/backend/start/routes/core.ts)
- Pendaftaran seluruh rute `/api/v2.1/edges` dan `/api/v2.1/edge/...`.

---

### Frontend (Next.js 15 App Router - `/home/muliaabdi/www/web-next`)

#### [NEW] [/admin/manage/edge/page.tsx](file:///home/muliaabdi/www/web-next/src/app/admin/manage/edge/page.tsx)
- Halaman tabel utama **Edge Management** (sesuai Screenshot 1):
  - Header: **Edge Management** ("Register and manage edge devices in this workspace").
  - Tombol **`+ Register New Edge`** dengan modal form registrasi (input nama, alamat, pilihan area/lokasi, notes, tier).
  - Tabel Data:
    - **EDGE NAME**: Nama perangkat (link ke detail).
    - **SITE ADDRESS**: Alamat fisik / nama area.
    - **STATUS**: Badge status dinamis:
      - `Pending` (Kuning/Oranye amber)
      - `Online` (Hijau emerald dengan dot pulse)
      - `Offline` (Abu-abu / Red dot jika tidak ada heartbeat >3 menit)
    - **ACTIVATED**: Format tanggal aktivasi atau `-`.
    - **MAC ADDRESS**: Monospace font (contoh: `00:15:5d:17:2a:25`) atau `-`.
    - **ACTIONS**: Tombol `View` dan `Delete`.

#### [NEW] [/admin/manage/edge/[id]/page.tsx](file:///home/muliaabdi/www/web-next/src/app/admin/manage/edge/[id]/page.tsx)
- Halaman detail perangkat (tata letak bersih dan proporsional):
  - **Header & Navigation**: Tombol kembali `< Edge Management`, Nama Edge, dan Badge Status Online/Offline/Pending.
  - **Kartu 1 - ACTIVATION CODE**:
    - Tampilan kode aktivasi besar `ENVI-8B4B-40B7` dengan tombol *Copy*.
    - Tombol **`Copy Setup Command`** (curl one-liner untuk terminal edge - Saran 1).
    - Subtext status: *"Single-use code. Cleared after edge activates."* (atau *"Device active"* jika sudah terhubung).
    - Tombol **`Regenerate Code`** dan menu opsi **`Reset to Pending`** / **`Revoke Token`** (Saran 3).
  - **Kartu 2 - IDENTITY & HARDWARE SPECS**:
    - Unique Key (UUID).
    - MAC Address & IP Address.
    - Waktu Aktivasi & Last Seen Heartbeat.
    - Metrik Hardware Terkini (jika aktif): CPU %, RAM %, Uptime (Saran 2).
  - **Kartu 3 - DETAILS**:
    - Form edit: Edge Name, Site Address, Pilihan Area (Envisions master data), Notes, License Tier.
    - Tombol simpan perubahan.
  - **Kartu 4 - BIDIRECTIONAL SYNC & LOGS**:
    - Tombol **`Pull Data from Edge`** untuk meminta data snapshot real-time.
    - Tabel riwayat aktivitas sinkronisasi data (Pull/Push, status, timestamp).

#### [MODIFY] [sidebar.tsx](file:///home/muliaabdi/www/web-next/src/components/layout/sidebar.tsx)
- Menambahkan menu **`Edge Devices`** di bagian *Management* (`/admin/manage/edge`) menggunakan icon `mdiServerNetwork`.

---

## 3. Verification Plan

### Automated / Backend Checks
- Menjalankan migrasi database: `node ace migration:run`.
- Verifikasi tipe data & linting di kedua repository:
  - Backend: `pnpm typecheck`
  - Frontend: `pnpm tsc --noEmit`
- Menjalankan script simulator:
  ```bash
  node ace run scripts/simulate_edge.ts --code ENVI-XXXX-XXXX
  ```
  Memastikan simulator berhasil mengaktivasi, mengirim heartbeat, dan status di dashboard langsung berubah menjadi hijau (*Online*).

### Manual UI Verification
- Buka `/admin/manage/edge` di browser:
  - Periksa kesesuaian tabel data dan modal pendaftaran.
  - Daftarkan perangkat baru -> cek tampilan kode `ENVI-XXXX-XXXX`.
  - Klik tombol `Copy Setup Command`, jalankan di terminal atau via simulator.
  - Amati perubahan status real-time di UI: dari *Pending* -> *Online* (dengan metrik CPU/RAM).
  - Coba tombol *Pull Data from Edge* dan periksa tabel log sinkronisasi.
  - Periksa tampilan pada Dark Mode dan Light Mode sesuai standar Anti-Slop.
