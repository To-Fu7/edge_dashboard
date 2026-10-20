"""Container entrypoint: load this device's configuration from the database,
then run main.py.

counting_config reads os.environ once at import, so the config has to be in
the environment before main (and everything it imports) is loaded. The last
config that loaded successfully is cached in .config-cache/<device id>.json,
so a camera can still restart while the database is briefly down.

Outside a dashboard-managed container (no EDGE_DEVICE_ID) this just runs
main.py on the existing environment — local development and tests are unchanged.
"""
import json
import logging
import os
import sys
import time

import edge_db

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.config-cache')


def _cache_path():
    return os.path.join(CACHE_DIR, f'{edge_db.DEVICE_ID}.json')


def _write_cache(code, env, version):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = _cache_path() + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'code': code, 'env': env, 'version': version}, f)
        os.replace(tmp, _cache_path())
    except OSError as e:
        logging.warning(f"[bootstrap] could not write config cache: {e}")


def _read_cache():
    try:
        with open(_cache_path()) as f:
            data = json.load(f)
        return data['code'], data['env'], data['version']
    except (OSError, ValueError, KeyError):
        return None


def load_config():
    """Block until the config is available: from the DB, or from the cache if the
    DB is unreachable. Exits if the device no longer exists."""
    delay = 2
    while True:
        try:
            conn = edge_db.connect()
            try:
                row = edge_db.fetch_config(conn)
            finally:
                conn.close()
            if row is None:
                logging.error(f"[bootstrap] device {edge_db.DEVICE_ID} does not exist in the database — exiting")
                sys.exit(1)
            code, env, version = row
            _write_cache(code, env, version)
            logging.info(f"[bootstrap] loaded config v{version} for {code} from the database")
            return env, version
        except Exception as e:  # noqa: BLE001 — any DB problem: fall back to the cache, then retry
            cached = _read_cache()
            if cached:
                code, env, version = cached
                logging.warning(f"[bootstrap] database unavailable ({e}); using cached config v{version} for {code}")
                return env, version
            logging.error(f"[bootstrap] database unavailable and no cached config yet ({e}); retrying in {delay}s")
            time.sleep(delay)
            delay = min(delay * 2, 30)


def apply_environment(env, version):
    edge_db.LOADED_ENV = {k: str(v) for k, v in env.items()}
    for key, value in env.items():
        os.environ[key] = str(value)
    # Result writes use the same database and restricted role as the config read.
    os.environ['PG_HOST'] = os.getenv('EDGE_DB_HOST', 'env_services_timescaledb')
    os.environ['PG_PORT'] = os.getenv('EDGE_DB_PORT', '5432')
    os.environ['PG_DB'] = os.getenv('EDGE_DB_NAME', 'edge')
    os.environ['PG_USER'] = os.getenv('EDGE_DB_USER', 'edge_device')
    os.environ['PG_PASS'] = os.getenv('EDGE_DB_PASSWORD', '')
    # counting_config defaults DEBUG_MODE to true (handy for local runs); a
    # managed camera always writes its results.
    os.environ['DEBUG_MODE'] = 'false'
    os.environ['EDGE_CONFIG_VERSION'] = str(version)


if __name__ == '__main__':
    if edge_db.enabled():
        apply_environment(*load_config())
    import main  # noqa: E402 — must come after the environment is populated
    main.main()
