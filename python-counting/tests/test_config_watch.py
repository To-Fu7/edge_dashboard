"""config_watch: which config changes apply live and which need a restart.

Run from python-counting/:  python tests/test_config_watch.py
(no database needed — exercises classify() and apply_hot() only)
"""
from testutil import check, finish  # sets up sys.path and the minimal env

import counting_config as cfg
import config_watch

base = {'RTSP_URL': 'rtsp://a', 'JPEG_QUALITY': '40', 'FPS_LIMIT': '0', 'FRAME_SKIP': '2',
        'MQTT_TOPIC': '/p/A', 'APD_TAG': 'alarm', 'lineA': '[(0,0),(1,1)]'}

changed, hot = config_watch.classify(base, dict(base))
check('no change → nothing to do', changed == [] and hot)

changed, hot = config_watch.classify(base, {**base, 'JPEG_QUALITY': '80', 'FPS_LIMIT': '5', 'FRAME_SKIP': '3'})
check('JPEG / FPS limit / frame skip are hot', hot and changed == ['FPS_LIMIT', 'FRAME_SKIP', 'JPEG_QUALITY'], str(changed))

changed, hot = config_watch.classify(base, {**base, 'MQTT_TOPIC': '/p/B', 'APD_TAG': 'info'})
check('topics and tags are hot', hot)

check('RTSP change needs restart', not config_watch.classify(base, {**base, 'RTSP_URL': 'rtsp://b'})[1])
check('line change needs restart', not config_watch.classify(base, {**base, 'lineA': '[(0,0),(2,2)]'})[1])
check('mixed hot + cold needs restart', not config_watch.classify(base, {**base, 'JPEG_QUALITY': '80', 'RTSP_URL': 'rtsp://b'})[1])
check('removing a hot key needs restart (no value to apply)', not config_watch.classify(base, {k: v for k, v in base.items() if k != 'APD_TAG'})[1])

config_watch.apply_hot(['JPEG_QUALITY', 'FPS_LIMIT', 'FRAME_SKIP', 'DEVICE_NAME'],
                       {'JPEG_QUALITY': '77', 'FPS_LIMIT': '4', 'FRAME_SKIP': '0', 'DEVICE_NAME': 'Gate 2'})
check('JPEG parsed to int', cfg.JPEG_QUALITY == 77)
check('FPS limit updates frame interval', cfg.FPS_LIMIT == 4.0 and abs(cfg.FRAME_INTERVAL - 0.25) < 1e-9)
check('frame skip clamped to >= 1', cfg.FRAME_SKIP == 1)
check('device name applied', cfg.device_name == 'Gate 2')
config_watch.apply_hot(['FPS_LIMIT'], {'FPS_LIMIT': '0'})
check('FPS limit 0 disables limiting', cfg.FRAME_INTERVAL == 0)

finish()
