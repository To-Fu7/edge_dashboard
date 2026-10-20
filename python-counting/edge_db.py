"""Connection to the Edge database for camera containers (role edge_device).

The dashboard creates each camera container with EDGE_DEVICE_ID and EDGE_DB_*;
everything else about the device is read from the `devices` table. The role
can read only id/code/name/enabled/effective_env/config_version of devices and
write results and its heartbeat (see dashboard/db/migrations/001_edge_schema.sql).
"""
import os

import psycopg2

DEVICE_ID = os.getenv('EDGE_DEVICE_ID', '').strip()

# The effective env bootstrap.py loaded (what config_watch diffs against).
LOADED_ENV = {}


def enabled():
    """True inside a dashboard-managed container (config comes from the DB)."""
    return bool(DEVICE_ID)


def connect(**kwargs):
    return psycopg2.connect(
        host=os.getenv('EDGE_DB_HOST', 'env_services_timescaledb'),
        port=int(os.getenv('EDGE_DB_PORT', '5432')),
        dbname=os.getenv('EDGE_DB_NAME', 'edge'),
        user=os.getenv('EDGE_DB_USER', 'edge_device'),
        password=os.getenv('EDGE_DB_PASSWORD', ''),
        connect_timeout=5,
        application_name=f"edge-device-{DEVICE_ID[:8]}",
        **kwargs,
    )


def fetch_config(conn):
    """(code, effective_env, config_version) of this device, or None if deleted."""
    with conn.cursor() as cur:
        cur.execute('SELECT code, effective_env, config_version FROM devices WHERE id = %s', (DEVICE_ID,))
        return cur.fetchone()
