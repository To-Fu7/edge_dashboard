"""Realtime config updates: LISTEN edge_config and apply this device's changes.

The dashboard bumps devices.config_version and sends NOTIFY edge_config
'<device id>:<version>' whenever a device's effective env changes (its own form,
or a global setting it inherits). This thread then:

* applies the change in place when every changed key is "hot" — a plain value
  the pipeline reads as cfg.X at the moment it's used (tags, topics, JPEG
  quality, FPS limit, frame skip, ...);
* otherwise sets state.restart_requested; the main loop exits cleanly and
  Docker's restart policy starts the container again with the new config
  (bootstrap.py loads it).

A poll every 60 s backs up NOTIFY (which is lost while the connection is down).
"""
import logging
import os
import select
import threading
import time

import app_state as state
import counting_config as cfg
import edge_db


def _int(v):
    return int(float(v))


def _float(v):
    return float(v)


def _str(v):
    return str(v)


def _frame_skip(v):
    return max(1, _int(v))


# env key → (cfg attribute, parser). Only values read as cfg.X at use time and
# not baked into objects built at startup belong here.
HOT_KEYS = {
    'PEOPLE_COUNTING_TAG': ('PEOPLE_COUNTING_TAG', _str),
    'APD_TAG': ('APD_TAG', _str),
    'FIRE_TAG': ('FIRE_TAG', _str),
    'SMOKE_TAG': ('SMOKE_TAG', _str),
    'INSIDER_TAG': ('INSIDER_TAG', _str),
    'INTRUDER_TAG': ('INTRUDER_TAG', _str),
    'INTRUSION_TAG': ('INTRUSION_TAG', _str),
    'MQTT_TOPIC': ('MQTT_TOPIC', _str),
    'MQTT_INTERVAL_TOPIC': ('MQTT_INTERVAL_TOPIC', _str),
    'MQTT_APD_TOPIC': ('MQTT_APD_TOPIC', _str),
    'MQTT_FIRESMOKE_TOPIC': ('MQTT_FIRESMOKE_TOPIC', _str),
    'MQTT_FACE_TOPIC': ('MQTT_FACE_TOPIC', _str),
    'MQTT_INTRUSION_TOPIC': ('MQTT_INTRUSION_TOPIC', _str),
    'MQTT_INTERVAL_MINUTES': ('MQTT_INTERVAL_MINUTES', _int),
    'DAILY_SEND_TIME': ('DAILY_SEND_TIME', _str),
    'JPEG_QUALITY': ('JPEG_QUALITY', _int),
    'STREAM_JPEG_QUALITY': ('STREAM_JPEG_QUALITY', _int),
    'FIRE_SMOKE_COOLDOWN_MINUTES': ('FIRE_SMOKE_COOLDOWN_MINUTES', _float),
    'FACE_MATCH_THRESHOLD': ('FACE_MATCH_THRESHOLD', _float),
    'FRAME_SKIP': ('FRAME_SKIP', _frame_skip),
    'FPS_LIMIT': ('FPS_LIMIT', _float),
    'DEVICE_NAME': ('device_name', _str),
}

POLL_S = 60
CHANNEL = 'edge_config'


def classify(old_env, new_env):
    """Return (changed keys, whether all of them can be applied without a restart)."""
    keys = set(old_env) | set(new_env)
    changed = sorted(k for k in keys if old_env.get(k) != new_env.get(k))
    hot = all(k in HOT_KEYS and k in new_env for k in changed)
    return changed, hot


def apply_hot(changed, new_env):
    for key in changed:
        attr, parse = HOT_KEYS[key]
        setattr(cfg, attr, parse(new_env[key]))
        os.environ[key] = new_env[key]
    if 'FPS_LIMIT' in changed:
        cfg.FRAME_INTERVAL = 1.0 / cfg.FPS_LIMIT if cfg.FPS_LIMIT > 0 else 0


class ConfigWatcher(threading.Thread):
    def __init__(self, env, version):
        super().__init__(daemon=True, name='config-watch')
        self.env = dict(env)
        self.version = version

    def _check(self, conn, announced=None):
        if announced is not None and announced <= self.version:
            return
        row = edge_db.fetch_config(conn)
        if row is None:
            logging.warning("[config] this device was deleted — stopping")
            state.restart_requested = 'device deleted'
            return
        _code, new_env, version = row
        if version <= self.version:
            return
        changed, hot = classify(self.env, new_env)
        if not changed:
            self.version = version
            state.config_version = version
            return
        if hot:
            apply_hot(changed, new_env)
            self.env = dict(new_env)
            self.version = version
            state.config_version = version
            logging.info(f"[config] applied v{version} without restart: {', '.join(changed)}")
        else:
            cold = [k for k in changed if k not in HOT_KEYS]
            logging.info(f"[config] v{version} changes {', '.join(cold[:8])}{'…' if len(cold) > 8 else ''} — restarting to apply")
            state.restart_requested = f'config v{version}'

    def run(self):
        delay = 2
        while not state.restart_requested:
            conn = None
            try:
                conn = edge_db.connect()
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute(f'LISTEN {CHANNEL}')
                self._check(conn)          # catch anything missed while disconnected
                delay = 2
                last_poll = time.time()
                while not state.restart_requested:
                    if select.select([conn], [], [], 5) != ([], [], []):
                        conn.poll()
                        while conn.notifies:
                            note = conn.notifies.pop(0)
                            dev_id, _, ver = note.payload.partition(':')
                            if dev_id == edge_db.DEVICE_ID:
                                self._check(conn, int(ver or 0))
                    if time.time() - last_poll > POLL_S:
                        self._check(conn)
                        last_poll = time.time()
            except Exception as e:  # noqa: BLE001 — reconnect on any DB/network error
                logging.warning(f"[config] watch connection lost ({e}); retrying in {delay}s")
                time.sleep(delay)
                delay = min(delay * 2, 60)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:  # noqa: BLE001
                        pass


def start():
    """Start watching (no-op outside a dashboard-managed container)."""
    if not edge_db.enabled():
        return None
    version = int(os.getenv('EDGE_CONFIG_VERSION', '0') or 0)
    state.config_version = version
    watcher = ConfigWatcher(edge_db.LOADED_ENV, version)
    watcher.start()
    logging.info(f"[config] watching for changes (v{version})")
    return watcher
