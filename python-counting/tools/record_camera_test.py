"""Standalone per-camera / per-video recording tool for detection QA.

Connects to one RTSP stream OR a local video file, runs the SAME Triton YOLO
inference path used by the production counting service (so results are
directly comparable to what's running live), optionally applies the same
resize(SCREEN_RESOLUTION) -> crop(CROP_AREA) preprocessing main.py does,
draws boxes + confidence + a live FPS/detection overlay, and records the
annotated feed to an mp4 — while also optionally serving that same annotated
feed live over MJPEG (--stream-port), so a viewer can watch bounding boxes
appear in real time during the run, not just review the finished recording
afterward. Use it to check a camera or a saved test clip in isolation —
distance/angle/resolution causing missed detections vs. genuine GPU/model
instability — without touching the live counting containers, and without
live-camera noise (network jitter, other cameras' GPU contention) muddying
whether a low FPS / low detection rate is the model's fault.

Usage:
    # Load RTSP_URL / TRITON_URL / TRITON_MODEL / YOLO_CONFIDENCE (and
    # SCREEN_RESOLUTION / CROP_AREA, applied automatically) from an existing
    # device .env file (same convention as main.py):
    python tools/record_camera_test.py --device S21 --seconds 120

    # Test a saved mp4 against a specific model, matching a device's
    # preprocessing exactly, with a live MJPEG preview on :8099 (this is what
    # the dashboard's Model Test page runs):
    python tools/record_camera_test.py --rtsp test-videos/lobby.mp4 \\
        --triton-url triton:8001 --model yolo26m_640 --conf 0.3 \\
        --resolution 800,600 --crop 38,11,770,440 --stream-port 8099

Output: ./recordings/<device-or-tag>_<timestamp>.mp4 (annotated) next to a
.log with per-second detection-count stats, unless --out overrides it.
"""
from __future__ import annotations

import argparse
import os
import socketserver
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from inference import TritonUnavailableError, TritonYoloClient  # noqa: E402

# ── Minimal MJPEG live preview ────────────────────────────────────────────
# A trimmed inline copy of outputs/mjpeg_server.py's protocol (same
# multipart/x-mixed-replace format the dashboard already knows how to proxy
# for live camera views), NOT importing that module directly — it reads
# cfg.STREAM_PORT from counting_config, which would drag in the full env-var
# surface (DEVICE_ID, PG_HOST, lineA, ...) just to run a standalone test tool
# against an mp4 with none of that configured.
_stream_frame: bytes | None = None
_stream_lock = threading.Lock()


def _push_frame(jpeg_bytes: bytes):
    global _stream_frame
    with _stream_lock:
        _stream_frame = jpeg_bytes


class _MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        try:
            while True:
                with _stream_lock:
                    frame = _stream_frame
                if frame is not None:
                    header = (b'--frame\r\nContent-Type: image/jpeg\r\n'
                              + f'Content-Length: {len(frame)}\r\n\r\n'.encode())
                    self.wfile.write(header + frame + b'\r\n')
                    self.wfile.flush()
                time.sleep(0.04)  # ~25fps cap, matches outputs/mjpeg_server.py
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def log_message(self, format, *args):  # noqa: A002 — suppress access logs
        pass


def _start_mjpeg_server(port: int):
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', port), _MJPEGHandler) as srv:
        srv.serve_forever()


def parse_resolution(raw: str | None) -> tuple[int, int] | None:
    if not raw:
        return None
    w, h = raw.split(',')
    return int(w), int(h)


def parse_crop(raw: str | None) -> tuple[int, int, int, int] | None:
    if not raw:
        return None
    x1, y1, x2, y2 = raw.split(',')
    return int(x1), int(y1), int(x2), int(y2)


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, val = line.partition('=')
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        env[key.strip()] = val
    return env


def resolve_config(args: argparse.Namespace):
    """Returns (rtsp_url, triton_url, model_name, conf_thresh, tag, resolution, crop).
    resolution/crop are (w,h) / (x1,y1,x2,y2) or None (no resize/crop applied)."""
    import ast

    resolution = parse_resolution(args.resolution)
    crop = parse_crop(args.crop)

    if args.device:
        env_path = Path(__file__).resolve().parent.parent / f'.env_{args.device}'
        if not env_path.exists():
            sys.exit(f"error: {env_path} not found")
        env = load_env_file(env_path)
        rtsp_url = args.rtsp or env.get('RTSP_URL', '')
        triton_url = args.triton_url or env.get('TRITON_URL', 'triton:8001')
        model_name = args.model or env.get('TRITON_MODEL') or _derive_model(env.get('YOLO_MODEL', 'yolo26m.pt'))
        conf = args.conf if args.conf is not None else float(env.get('YOLO_CONFIDENCE', 0.3))
        tag = args.device
        # Mirror main.py's preprocessing unless explicitly overridden on the CLI —
        # a device's SCREEN_RESOLUTION/CROP_AREA directly affects detection rate
        # (shrinks pixel density before the model ever sees the frame), so testing
        # without them isn't actually "the same conditions as main.py".
        if resolution is None and env.get('SCREEN_RESOLUTION', '').strip().lower() not in ('', 'auto'):
            try:
                w, h = ast.literal_eval(env['SCREEN_RESOLUTION'])
                resolution = (int(w), int(h))
            except Exception:
                pass
        if crop is None and env.get('CROP_AREA', '').strip():
            try:
                (x1, y1), (x2, y2) = ast.literal_eval(env['CROP_AREA'])
                crop = (int(x1), int(y1), int(x2), int(y2))
            except Exception:
                pass
    else:
        if not args.rtsp:
            sys.exit("error: pass --device CODE or --rtsp URL")
        rtsp_url = args.rtsp
        triton_url = args.triton_url or 'triton:8001'
        model_name = args.model or 'yolo26m_640'
        conf = args.conf if args.conf is not None else 0.3
        tag = args.tag or 'camera'

    if not rtsp_url:
        sys.exit("error: no RTSP_URL resolved (empty in env file and no --rtsp given)")
    return rtsp_url, triton_url, model_name, conf, tag, resolution, crop


def _derive_model(yolo_model: str) -> str:
    stem = Path(yolo_model).stem
    return f'{stem}_640'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--device', help='Device code, loads .env_<CODE> for RTSP_URL/TRITON_URL/TRITON_MODEL/YOLO_CONFIDENCE')
    ap.add_argument('--rtsp', help='RTSP/file URL (overrides --device env, or use standalone)')
    ap.add_argument('--triton-url', help='Triton gRPC endpoint, default triton:8001 or from env')
    ap.add_argument('--model', help='Triton model repository name, default yolo26m_640 or from env')
    ap.add_argument('--conf', type=float, help='Confidence threshold, default 0.3 or from env')
    ap.add_argument('--tag', help='Label used in output filename when --device is not set')
    ap.add_argument('--seconds', type=float, default=0, help='Stop after N seconds (0 = run until end of file / Ctrl+C)')
    ap.add_argument('--out', help='Output mp4 path (default: recordings/<tag>_<timestamp>.mp4)')
    ap.add_argument('--no-record', action='store_true', help='Preview stats only, skip writing the video file')
    ap.add_argument('--resolution', help='W,H — resize every frame before inference, mirroring SCREEN_RESOLUTION (default: from --device env, or none)')
    ap.add_argument('--crop', help='x1,y1,x2,y2 — crop after resize, mirroring CROP_AREA (default: from --device env, or none)')
    ap.add_argument('--stream-port', type=int, help='Serve the annotated feed live as MJPEG on this port while running')
    args = ap.parse_args()

    rtsp_url, triton_url, model_name, conf, tag, resolution, crop = resolve_config(args)
    is_file = os.path.isfile(rtsp_url)

    print(f"[config] source={rtsp_url} ({'file' if is_file else 'stream'})")
    print(f"[config] triton={triton_url} model={model_name} conf={conf}")
    print(f"[config] resolution={resolution or 'native'} crop={crop or 'none'}")

    def preprocess(frame):
        if resolution is not None:
            frame = cv2.resize(frame, resolution)
        if crop is not None:
            x1, y1, x2, y2 = crop
            frame = frame[y1:y2, x1:x2]
        return frame

    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not cap.isOpened():
        sys.exit(f"error: could not open source {rtsp_url}")

    ok, frame = cap.read()
    if not ok or frame is None:
        sys.exit("error: source opened but first frame read failed")
    frame = preprocess(frame)
    h, w = frame.shape[:2]
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if src_fps <= 1 or src_fps > 60:
        src_fps = 25.0

    client = TritonYoloClient(url=triton_url, model_name=model_name, conf_thresh=conf, class_id=0)
    try:
        client.connect()
    except TritonUnavailableError as e:
        sys.exit(f"error: {e}")

    if args.stream_port:
        threading.Thread(target=_start_mjpeg_server, args=(args.stream_port,), daemon=True).start()
        print(f"[stream] live MJPEG preview on :{args.stream_port}")

    writer = None
    out_path = None
    log_path = None
    log_f = None
    if not args.no_record:
        out_dir = Path(__file__).resolve().parent.parent / 'recordings'
        out_dir.mkdir(exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_path = Path(args.out) if args.out else out_dir / f'{tag}_{stamp}.mp4'
        log_path = out_path.with_suffix('.log')
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(str(out_path), fourcc, src_fps, (w, h))
        log_f = open(log_path, 'w')
        print(f"[record] writing {out_path} @ {src_fps:.1f}fps {w}x{h}")

    start = time.monotonic()
    last_report = start
    frame_count = 0
    det_count_window = 0
    frame_count_window = 0
    infer_errors = 0
    max_det_in_frame = 0
    total_dets = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                if is_file:
                    print("[done] end of file reached")
                    break
                print("[warn] frame read failed, reconnecting...")
                cap.release()
                time.sleep(1.0)
                cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                continue

            frame = preprocess(frame)

            t0 = time.monotonic()
            try:
                dets = client.infer(frame)
            except TritonUnavailableError as e:
                infer_errors += 1
                dets = np.empty((0, 6), dtype=np.float32)
                cv2.putText(frame, f"INFERENCE ERROR: {e}", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            infer_ms = (time.monotonic() - t0) * 1000

            n = len(dets)
            total_dets += n
            det_count_window += n
            frame_count_window += 1
            max_det_in_frame = max(max_det_in_frame, n)

            for x1, y1, x2, y2, sc, _cls in dets:
                p1, p2 = (int(x1), int(y1)), (int(x2), int(y2))
                cv2.rectangle(frame, p1, p2, (0, 255, 0), 2)
                cv2.putText(frame, f"{sc:.2f}", (p1[0], max(0, p1[1] - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

            elapsed = time.monotonic() - start
            overlay = f"t={elapsed:6.1f}s  det={n:2d}  infer={infer_ms:5.1f}ms  errs={infer_errors}"
            cv2.putText(frame, overlay, (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
            cv2.putText(frame, datetime.now().strftime('%Y-%m-%d %H:%M:%S'), (10, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

            if writer is not None:
                writer.write(frame)

            if args.stream_port:
                ok_enc, jpg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok_enc:
                    _push_frame(jpg.tobytes())

            frame_count += 1

            now = time.monotonic()
            if now - last_report >= 1.0:
                fps = frame_count_window / (now - last_report)
                avg_det = det_count_window / max(1, frame_count_window)
                line = (f"t={elapsed:6.1f}s  fps={fps:5.1f}  avg_det/frame={avg_det:4.2f}  "
                        f"max_det={max_det_in_frame}  infer_last={infer_ms:5.1f}ms  errs={infer_errors}")
                print(line)
                if log_f:
                    log_f.write(line + "\n")
                    log_f.flush()
                last_report = now
                det_count_window = 0
                frame_count_window = 0

            if args.seconds and elapsed >= args.seconds:
                break

    except KeyboardInterrupt:
        print("\n[stop] interrupted by user")
    finally:
        cap.release()
        if writer is not None:
            writer.release()
        if log_f is not None:
            log_f.close()
        client.close()

    total_time = time.monotonic() - start
    print("\n=== summary ===")
    print(f"frames={frame_count}  duration={total_time:.1f}s  avg_fps={frame_count / max(total_time, 0.01):.2f}")
    print(f"total_detections={total_dets}  avg_det/frame={total_dets / max(frame_count, 1):.2f}  max_det_in_frame={max_det_in_frame}")
    print(f"infer_errors={infer_errors}")
    if out_path:
        print(f"video={out_path}")
    if log_path:
        print(f"log={log_path}")


if __name__ == '__main__':
    main()
