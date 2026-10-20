"""Heartbeat: upsert this camera's status into device_status every 10 s.

The dashboard shows it on the Detection dashboard and device pages (online,
FPS, IN/OUT today, Triton reachable, last error) and compares config_version
with the device's current version to show whether a change has been applied.
Only runs in dashboard-managed containers (EDGE_DEVICE_ID set).
"""
import datetime
import logging
import threading
import time

import app_state as state
import edge_db

INTERVAL_S = 10

UPSERT = """
INSERT INTO device_status (device_id, state, fps, persons, in_today, out_today, config_version,
                           triton_ok, last_error, started_at, updated_at)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
ON CONFLICT (device_id) DO UPDATE SET
  state = EXCLUDED.state, fps = EXCLUDED.fps, persons = EXCLUDED.persons,
  in_today = EXCLUDED.in_today, out_today = EXCLUDED.out_today,
  config_version = EXCLUDED.config_version, triton_ok = EXCLUDED.triton_ok,
  last_error = EXCLUDED.last_error, started_at = EXCLUDED.started_at, updated_at = now()
"""

_started_at = datetime.datetime.now(datetime.timezone.utc)
_conn = None


def current_state():
    if state.restart_requested:
        return 'stopping'
    if state.triton_ok is False:
        return 'degraded'          # camera fine, inference unavailable
    if state.hb_fps is None:
        return 'error' if state.last_error else 'starting'
    return 'running'


def _send(status=None):
    global _conn
    if _conn is None or _conn.closed:
        _conn = edge_db.connect()
        _conn.autocommit = True
    with _conn.cursor() as cur:
        cur.execute(UPSERT, (
            edge_db.DEVICE_ID, status or current_state(), state.hb_fps, state.hb_persons,
            state.person_in, state.person_out, state.config_version, state.triton_ok,
            (state.last_error or None) and str(state.last_error)[:500], _started_at,
        ))


def _loop():
    while True:
        try:
            _send()
        except Exception as e:  # noqa: BLE001 — never let monitoring hurt the pipeline
            logging.debug(f"[heartbeat] send failed: {e}")
            global _conn
            _conn = None
        time.sleep(INTERVAL_S)


def start():
    if not edge_db.enabled():
        return
    threading.Thread(target=_loop, daemon=True, name='heartbeat').start()


def send_final(status='stopping'):
    """Best-effort last beat before a clean exit."""
    if not edge_db.enabled():
        return
    try:
        _send(status)
    except Exception:  # noqa: BLE001
        pass
