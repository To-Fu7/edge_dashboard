"""Concurrent raw recorder for all configured cameras — no inference.

Epiwalk production isn't on the Triton path yet, so this just captures each
camera's RTSP stream as-is (resized to 800x600, matching SCREEN_RESOLUTION),
one process per camera, and writes plain mp4 files for later offline review —
useful to check exposure/angle/distance/stream stability per camera without
touching the live counting containers.

Auto-discovers every .env_<CODE> file in this directory (same convention as
main.py) and records all of them in parallel. Skips devices with no RTSP_URL.

Usage:
    # Record all 14 configured cameras for 5 minutes
    python tools/record_all_cameras.py --seconds 300

    # Only specific devices
    python tools/record_all_cameras.py --devices S21,T1 --seconds 120

    # Until Ctrl+C (stops all camera processes together)
    python tools/record_all_cameras.py
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_RESOLUTION = (800, 600)  # (width, height)


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


def discover_devices(only: list[str] | None) -> list[tuple[str, str]]:
    """Returns [(device_code, rtsp_url), ...] for devices with a non-empty RTSP_URL."""
    devices = []
    for env_path in sorted(REPO_ROOT.glob('.env_*')):
        code = env_path.name[len('.env_'):]
        if only and code not in only:
            continue
        env = load_env_file(env_path)
        rtsp_url = env.get('RTSP_URL', '').strip()
        if not rtsp_url:
            print(f"[skip] {code}: no RTSP_URL configured")
            continue
        devices.append((code, rtsp_url))
    return devices


def record_one(device_code: str, rtsp_url: str, out_path: str, duration_s: float, stop_flag):
    """Runs in its own process. Opens the stream, resizes, writes mp4, reconnects on drop."""
    w, h = OUT_RESOLUTION
    prefix = f"[{device_code}]"

    def open_capture():
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    cap = open_capture()
    if not cap.isOpened():
        print(f"{prefix} error: could not open stream")
        return

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 15.0
    if src_fps <= 1 or src_fps > 30:
        src_fps = 15.0

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(out_path, fourcc, src_fps, (w, h))
    print(f"{prefix} recording -> {out_path} @ {src_fps:.1f}fps {w}x{h}")

    start = time.monotonic()
    last_report = start
    frame_count = 0
    frame_count_window = 0
    reconnects = 0

    try:
        while not stop_flag.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                print(f"{prefix} frame read failed, reconnecting...")
                cap.release()
                time.sleep(1.0)
                cap = open_capture()
                reconnects += 1
                if reconnects > 30:
                    print(f"{prefix} giving up after {reconnects} reconnects")
                    break
                continue

            resized = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
            cv2.putText(resized, f"{device_code}  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                        (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            writer.write(resized)

            frame_count += 1
            frame_count_window += 1
            elapsed = time.monotonic() - start

            now = time.monotonic()
            if now - last_report >= 5.0:
                fps = frame_count_window / (now - last_report)
                print(f"{prefix} t={elapsed:6.1f}s  fps={fps:5.1f}  frames={frame_count}  reconnects={reconnects}")
                last_report = now
                frame_count_window = 0

            if duration_s and elapsed >= duration_s:
                break
    finally:
        cap.release()
        writer.release()

    total_time = time.monotonic() - start
    print(f"{prefix} done. frames={frame_count} duration={total_time:.1f}s "
          f"avg_fps={frame_count / max(total_time, 0.01):.2f} reconnects={reconnects}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--devices', help='Comma-separated device codes to record (default: all .env_* found)')
    ap.add_argument('--seconds', type=float, default=0, help='Stop after N seconds (0 = run until Ctrl+C)')
    ap.add_argument('--out-dir', default=str(REPO_ROOT / 'recordings'), help='Output directory for mp4 files')
    args = ap.parse_args()

    only = [d.strip() for d in args.devices.split(',')] if args.devices else None
    devices = discover_devices(only)
    if not devices:
        sys.exit("error: no devices with a configured RTSP_URL found")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')

    print(f"[start] recording {len(devices)} camera(s): {', '.join(c for c, _ in devices)}")
    print(f"[start] output dir: {out_dir}  resolution={OUT_RESOLUTION[0]}x{OUT_RESOLUTION[1]}  "
          f"duration={'until Ctrl+C' if not args.seconds else f'{args.seconds:.0f}s'}")

    stop_flag = mp.Event()
    procs: list[mp.Process] = []
    for code, rtsp_url in devices:
        out_path = str(out_dir / f'{code}_{stamp}.mp4')
        p = mp.Process(target=record_one, args=(code, rtsp_url, out_path, args.seconds, stop_flag), daemon=True)
        p.start()
        procs.append(p)

    def handle_sigint(signum, frame):
        print("\n[stop] Ctrl+C received, stopping all cameras...")
        stop_flag.set()

    signal.signal(signal.SIGINT, handle_sigint)

    try:
        for p in procs:
            p.join()
    except KeyboardInterrupt:
        stop_flag.set()
        for p in procs:
            p.join()

    print(f"\n[done] all cameras finished. files in {out_dir}")


if __name__ == '__main__':
    main()
