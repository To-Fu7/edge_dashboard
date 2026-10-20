# Design: Device config in PostgreSQL, realtime settings, dashboard login

Status: decisions confirmed by user (2026-10-21). Branch `feat/device-config-db`.
Scope: new installs only — the existing production server (10.11.0.95) is not
migrated, so there is no `.env_<CODE>` import path.

## Goals

- Every device and all of its variables live in PostgreSQL, database `edge`.
  No `.env_<CODE>` files, no camera services in `docker-compose.yml`.
- Global settings apply to every device in realtime.
- Dashboard login with two roles: `admin` (everything) and `user` (Stream +
  Detection dashboard only).
- `git pull` on a running box never conflicts with runtime-generated files.

## Database `edge`

Roles (created once by the installer with the PostgreSQL superuser):

| Role | Used by | Rights |
|---|---|---|
| `edge_owner` | dashboard | owns database `edge` and every table; runs migrations |
| `edge_device` | camera containers | read its config columns; write results + `device_status` |

Tables (dashboard migrations in `dashboard/db/migrations/*.sql`):

- `schema_migrations`
- `users` (`id uuid`, `username`, `password_hash` scrypt, `role` admin|user), `sessions`
- `settings` (`key='global'`, `value jsonb`) + `settings_history`
- `devices` (`id uuid` PK, `code` unique + renamable, `name`, `enabled`,
  `overrides jsonb`, `effective_env jsonb`, `config_version int`)
- `device_config_history` (snapshot per change → rollback)
- `device_status` (heartbeat: state, fps, in/out today, config version, error)
- `port_forwards` (`device_id` nullable FK, ON DELETE CASCADE)
- result tables unchanged in shape: `person_inout`, `inout_resample`,
  `apd_hourly`, `firesmoke_hourly`, `face_hourly`, `intrusion_hourly`, `known_faces`

## Config model

`effective_env = device defaults + global(settings, device) + overrides + derived + identity`

- Device stores only overrides. On save the dashboard diffs the submitted env
  against the inherited base, so the existing device form keeps working.
- Global keys: MQTT broker/credentials/topic templates, Triton default model and
  embed model, detection defaults (confidence, tags, intervals, JPEG quality,
  FPS limit, frame skip), face thresholds. Every global key can be overridden
  per device; FPS limit, frame skip and JPEG quality are shown on the device page.
- The dashboard computes `effective_env` (one implementation, TypeScript) and
  bumps `config_version` whenever a device or the global settings change, then
  `NOTIFY edge_config, '<device_id>:<version>'`.
- DB connection is not in the DB: dashboard `.env` (`EDGE_DB_*`).

## Camera containers

- Created by the dashboard through the Docker API: name `device-<code>`
  (lowercase, `_`→`-`), image `edge-device:latest`, network `envisions`,
  restart `unless-stopped`, code bind-mounted at `/app`.
- Container env: `EDGE_DEVICE_ID`, `EDGE_DB_*` (role `edge_device`), `TRITON_URL`.
- `bootstrap.py` loads `effective_env` into `os.environ` before
  `counting_config` is imported, caches it for DB outages, then runs `main`.
- `config_watch` LISTENs on `edge_config`: hot-applies safe keys, otherwise the
  main loop exits cleanly and Docker restarts the container.
- `heartbeat` upserts `device_status` every 10 s.
- Renaming the code recreates the container under the new name.

## Triton

`python-counting/docker-compose.yml` becomes static (tracked). Per-machine values
(`TRITON_IMAGE`, `TRITON_RUNTIME`, `TRT_BACKEND`, `HOST_PYTHON_COUNTING_DIR`) live
in the git-ignored `python-counting/.env`, written by the dashboard/installer.

## Auth

- Users in DB, scrypt hashes, seeded `admin:admin` and `user:user` (changing the
  defaults is deferred).
- Session cookie (httpOnly, HMAC-signed, 7 days) + `sessions` row for revocation.
- `proxy.ts` does the optimistic redirect; every API route checks the session and
  role server-side. `/nodered` (server.js) is admin-only.
- Login rate limit: 5 failures → 1 minute.
- Settings → Users: add/remove users, reset passwords, change roles.
- Known gap (accepted): stream-gateway URLs and RTSP port forwards are not behind
  the login. Node-RED's host port 1880 is no longer published.

## Next ideas (not in this branch)

- mp4 debug tool replacing `FALLBACK_VIDEO` / `DEBUG_MODE` (kept for dev/tests until then)
- automatic daily `pg_dump`
- Node-RED auto-created flows for initial setup
- forced change of default passwords
- stream-gateway tokens issued by the dashboard
