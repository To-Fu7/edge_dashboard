# 8. Verifikasi end-to-end

Checklist setelah setup selesai, atau setelah perubahan besar (pindah server,
ganti model, update besar). Semua harus ✅ sebelum sistem dianggap siap.

## Checklist

| # | Cek | Perintah / cara | Benar kalau |
|---|---|---|---|
| 1 | GPU di container | `docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi` | GPU tampil |
| 2 | Data di NVMe | `docker info --format '{{.DockerRootDir}}'` dan `findmnt /opt/ai` | Di bawah `/data` |
| 3 | Semua container jalan | `docker ps --format '{{.Names}}\t{{.Status}}'` | Triton, dashboard, stream-gateway, nginx, nodered, DB, MQTT, dan semua `services-python-*` berstatus `Up` (bukan `Restarting`) |
| 4 | Model siap | `curl -s -X POST localhost:8000/v2/repository/index` | Semua `READY` |
| 5 | Batch benar | `tools/batch_check.py` ([05](05-triton.md#verifikasi)) | Semua frame punya deteksi |
| 6 | FPS kamera | `python3 python-counting/tools/stream_health.py <container> --since 30m` | ≥ 20 fps, error decode mendekati 0 |
| 7 | Data masuk DB | Query di bawah | `interval_in/out` jam ini bertambah |
| 8 | 24 row per jam hari ini | Query di bawah | 24 per device |
| 9 | MQTT terkirim | `docker exec -it env_services_mqtt mosquitto_sub -t '/resampling_person/#' -v` | Pesan muncul tiap 5 menit per kamera |
| 10 | Live view | Halaman Stream | Semua kamera tampil, tidak hitam |
| 11 | GPU tidak penuh | Kartu GPU di Detection → Dashboard | Power < 90% dari limit |
| 12 | Tahan restart | `sudo reboot`, lalu ulangi #3, #4, #6 | Semua kembali sendiri |

### Query DB

```bash
docker exec -it env_services_timescaledb psql -U postgres
```

```sql
-- #7: hitungan per jam hari ini (hour_start disimpan UTC; WIB = UTC+7)
SELECT device_code, hour_start AT TIME ZONE 'Asia/Jakarta' AS jam_wib, interval_in, interval_out
FROM inout_resample
WHERE hour_start >= date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'
ORDER BY device_code, hour_start;

-- #8: harus 24 row per device untuk hari ini
SELECT device_code, count(*)
FROM inout_resample
WHERE hour_start >= date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'
GROUP BY device_code;

-- total harian
SELECT device_id, total_in, total_out, created_at FROM person_inout ORDER BY created_at DESC LIMIT 20;
```

## Kalau ada yang gagal

| Cek gagal | Ke mana |
|---|---|
| 1, 2 | [00-pre-setup.md](00-pre-setup.md#kalau-error) |
| 3 (Triton), 4, 5 | [05-triton.md](05-triton.md#kalau-error) |
| 3 (dashboard/gateway/nginx/nodered), 10 | [06-dashboard.md](06-dashboard.md#kalau-error) |
| 3 (`services-python-*` restart terus), 6 | [07-add-camera.md](07-add-camera.md#kalau-error) |
| 7, 8 | [01-database.md](01-database.md#kalau-error), lalu cek `DEBUG_MODE` di [07](07-add-camera.md#kalau-error) |
| 9 | [02-mqtt.md](02-mqtt.md#kalau-error) |
| 11 | Kurangi kamera yang memakai model 1280, atau tambah GPU |
| 12 | [00-pre-setup.md](00-pre-setup.md) langkah 4 (`RequiresMountsFor`, fstab) |
