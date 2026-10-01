"""Live-stream capture that always hands the processing loop the newest frame.

OpenCV's FFmpeg backend ignores CAP_PROP_BUFFERSIZE, so when the processing
loop runs slower than the camera (e.g. ~21 fps vs a 25 fps source) unread data
piles up in the RTSP/TCP socket. TCP then throttles the camera, and many
cameras/NVRs respond by dropping data from their send buffer mid-frame, which
shows up on our side as H.264 corruption (tearing). A dedicated reader thread
keeps the socket drained at the source rate and drops stale frames only after
they are fully decoded, at clean frame boundaries.
"""
import logging
import threading

import cv2

LIVE_PREFIXES = ('rtsp://', 'rtsps://', 'rtmp://', 'http://', 'https://')


def is_live_source(source):
    return isinstance(source, str) and source.lower().startswith(LIVE_PREFIXES)


class LatestFrameCapture:
    """Drop-in subset of cv2.VideoCapture (isOpened/read/grab/get/release)."""

    def __init__(self, source, read_timeout_s=20.0):
        self._cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
        self._read_timeout_s = read_timeout_s
        self._cond = threading.Condition()
        self._frame = None
        self._seq = 0
        self._consumed_seq = 0
        self._dropped = 0
        self._failed = False
        self._stop = False
        self._thread = None
        if self._cap.isOpened():
            self._thread = threading.Thread(target=self._run, name='rtsp-reader', daemon=True)
            self._thread.start()

    def _run(self):
        try:
            while not self._stop:
                ok, frame = self._cap.read()
                with self._cond:
                    if not ok:
                        self._failed = True
                        self._cond.notify_all()
                        return
                    if self._seq > self._consumed_seq:
                        self._dropped += 1
                    self._frame = frame
                    self._seq += 1
                    self._cond.notify_all()
        finally:
            # Released here, never from another thread, so release() can't race a read() in progress.
            self._cap.release()

    def isOpened(self):
        return self._thread is not None and not self._failed

    def read(self):
        with self._cond:
            got_new = self._cond.wait_for(
                lambda: self._seq > self._consumed_seq or self._failed or self._stop,
                timeout=self._read_timeout_s,
            )
            if not got_new:
                logging.error(f"No new frame from stream in {self._read_timeout_s:.0f}s")
                return False, None
            if self._seq == self._consumed_seq:
                return False, None
            self._consumed_seq = self._seq
            return True, self._frame

    def grab(self):
        ok, _ = self.read()
        return ok

    def pop_dropped(self):
        with self._cond:
            n, self._dropped = self._dropped, 0
            return n

    def get(self, prop):
        return self._cap.get(prop)

    def release(self):
        with self._cond:
            self._stop = True
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=5)
