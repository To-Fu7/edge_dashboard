#!/usr/bin/env python3
"""Per-minute stream health for one counting container, from its docker logs:
FPS, stale frames dropped, persons detected per frame, H.264 decode errors
(tearing) and IN/OUT crossings — so tearing can be lined up with detection dips.

Usage (on the server, stdlib only):
    python3 tools/stream_health.py services-python-cctv-epw-s27            # last 60 min
    python3 tools/stream_health.py services-python-cctv-epw-s27 --since 3h
    python3 tools/stream_health.py services-python-cctv-epw-s27 --follow   # live, one row per minute
"""
import argparse
import datetime
import re
import subprocess
import sys

FPS_RE = re.compile(r'Processing FPS: ([0-9.]+)(?: \((?:dropped (\d+) stale frames)?(?:, )?(?:persons/frame det=([0-9.]+) trk=([0-9.]+))?\))?')
TEAR_RE = re.compile(r'error while decoding|non-existing PPS referenced')
CROSS_RE = re.compile(r'\b(IN|OUT) through\b')

HEADER = f"{'time':>5}  {'fps avg':>7} {'min':>5}  {'dropped':>7}  {'det/frm':>7} {'min':>5}  {'tearing':>7}  {'in':>3} {'out':>3}"


class Minute:
    def __init__(self):
        self.fps, self.det = [], []
        self.dropped = self.tearing = self.cin = self.cout = 0

    def add(self, line):
        m = FPS_RE.search(line)
        if m:
            self.fps.append(float(m.group(1)))
            if m.group(2):
                self.dropped += int(m.group(2))
            if m.group(3):
                self.det.append(float(m.group(3)))
            return
        if TEAR_RE.search(line):
            self.tearing += 1
            return
        m = CROSS_RE.search(line)
        if m:
            if m.group(1) == 'IN':
                self.cin += 1
            else:
                self.cout += 1

    def row(self, t):
        def avg(v, fmt):
            return format(sum(v) / len(v), fmt) if v else '-'

        def mn(v, fmt):
            return format(min(v), fmt) if v else '-'

        flag = '  <-- TEARING' if self.tearing else ''
        return (f"{t:%H:%M}  {avg(self.fps, '.1f'):>7} {mn(self.fps, '.1f'):>5}  {self.dropped:>7}  "
                f"{avg(self.det, '.2f'):>7} {mn(self.det, '.2f'):>5}  "
                f"{self.tearing:>7}  {self.cin:>3} {self.cout:>3}{flag}")


def parse_ts(line):
    """docker logs -t prefix (UTC, RFC3339Nano) -> local minute, rest of line."""
    ts, _, rest = line.partition(' ')
    try:
        dt = datetime.datetime.strptime(ts[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None, line
    return dt.astimezone().replace(second=0, microsecond=0), rest


def run(container, since, follow):
    cmd = ['docker', 'logs', '-t', '--since', '0s' if follow else since]
    if follow:
        cmd.append('-f')
    cmd.append(container)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)

    print(f"{container}  (times local; tearing = H.264 decode errors)")
    print(HEADER)
    current_t, current = None, Minute()
    totals = Minute()
    for line in proc.stdout:
        t, rest = parse_ts(line.rstrip('\n'))
        if t is None:
            continue
        if current_t is not None and t != current_t:
            print(current.row(current_t), flush=True)
            current = Minute()
        current_t = t
        current.add(rest)
        totals.add(rest)
    if current_t is not None:
        print(current.row(current_t))
    fps = f"{sum(totals.fps) / len(totals.fps):.1f}" if totals.fps else '-'
    print(f"\ntotal: fps avg {fps}, tearing events {totals.tearing}, crossings in {totals.cin} / out {totals.cout}")
    return proc.wait()


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('container')
    ap.add_argument('--since', default='60m', help='docker logs --since value (default 60m)')
    ap.add_argument('--follow', action='store_true', help='live mode: print a row as each minute closes')
    args = ap.parse_args()
    try:
        sys.exit(run(args.container, args.since, args.follow))
    except KeyboardInterrupt:
        pass
