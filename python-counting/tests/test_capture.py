"""LatestFrameCapture tests against a fake cv2.VideoCapture (no camera needed).

Run from python-counting/:  python tests/test_capture.py
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import capture

FAILED = []


def check(name, cond, detail=''):
    print(f"  {'PASS' if cond else 'FAIL'} {name} {detail}")
    if not cond:
        FAILED.append(name)


class FakeVideoCapture:
    """Emits integer 'frames' at a fixed rate; fails after `limit` frames."""

    def __init__(self, source, api=None, interval=0.01, limit=None):
        self.interval = interval
        self.limit = limit
        self.n = 0
        self.released = threading.Event()

    def isOpened(self):
        return True

    def read(self):
        time.sleep(self.interval)
        if self.limit is not None and self.n >= self.limit:
            return False, None
        self.n += 1
        return True, self.n

    def get(self, prop):
        return 25.0

    def release(self):
        self.released.set()


def make(interval=0.01, limit=None, timeout=2.0):
    fakes = []

    def factory(source, api=None):
        f = FakeVideoCapture(source, api, interval, limit)
        fakes.append(f)
        return f

    capture.cv2.VideoCapture = factory
    cap = capture.LatestFrameCapture('rtsp://fake', read_timeout_s=timeout)
    return cap, fakes[0]


def test_slow_consumer_gets_latest():
    print('[1] slow consumer always gets the newest frame, stale ones are dropped')
    cap, fake = make(interval=0.01)
    ok1, f1 = cap.read()
    time.sleep(0.2)  # ~20 frames arrive meanwhile
    ok2, f2 = cap.read()
    check('reads succeed', ok1 and ok2)
    check('jumped forward to latest', f2 - f1 >= 10, f'(f1={f1}, f2={f2})')
    check('never older than what reader produced', f2 >= fake.n - 1, f'(f2={f2}, produced={fake.n})')
    check('drops counted', cap.pop_dropped() >= 10)
    check('drop counter resets', cap.pop_dropped() <= 2)
    cap.release()
    check('underlying capture released by reader thread', fake.released.wait(1))


def test_no_frame_returned_twice():
    print('[2] fast consumer never gets the same frame twice')
    cap, _ = make(interval=0.005)
    seen = [cap.read()[1] for _ in range(20)]
    check('strictly increasing', all(b > a for a, b in zip(seen, seen[1:])), str(seen[:8]))
    cap.release()


def test_stream_failure_propagates():
    print('[3] stream end/failure surfaces as read() -> (False, None)')
    cap, _ = make(interval=0.005, limit=3)
    results = [cap.read()[0] for _ in range(6)]
    check('eventually fails', results[-1] is False, str(results))
    check('isOpened false after failure', not cap.isOpened())
    cap.release()


def test_stalled_stream_times_out():
    print('[4] stalled stream times out instead of hanging')
    cap, _ = make(interval=5.0, timeout=0.3)
    t0 = time.time()
    ok, frame = cap.read()
    check('returns False', ok is False and frame is None)
    check('within timeout', time.time() - t0 < 1.0, f'({time.time() - t0:.2f}s)')
    cap.release()


def test_grab_skips_one_frame():
    print('[5] grab() consumes a frame (FRAME_SKIP semantics)')
    cap, _ = make(interval=0.005)
    a = cap.read()[1]
    check('grab ok', cap.grab())
    b = cap.read()[1]
    check('read after grab is newer than grabbed one', b > a + 1, f'(a={a}, b={b})')
    cap.release()


def test_live_source_detection():
    print('[6] only network streams use the reader')
    check('rtsp live', capture.is_live_source('rtsp://x/1'))
    check('RTSP upper-case live', capture.is_live_source('RTSP://x/1'))
    check('file not live', not capture.is_live_source('/data/clip.mp4'))
    check('device index not live', not capture.is_live_source(0))


if __name__ == '__main__':
    test_slow_consumer_gets_latest()
    test_no_frame_returned_twice()
    test_stream_failure_propagates()
    test_stalled_stream_times_out()
    test_grab_skips_one_frame()
    test_live_source_detection()
    print(f"\n{'ALL PASSED' if not FAILED else 'FAILED: ' + ', '.join(FAILED)}")
    sys.exit(1 if FAILED else 0)
