#!/usr/bin/env python3
"""Line up one camera's FPS with CPU (main thread / process / host), GPU and
Triton timings, one row per interval — to tell whether an FPS drop comes from
the camera's main thread being pinned at one core (GIL-bound) or from waiting
on the shared GPU/Triton.

Usage (on the server, stdlib only; needs docker, nvidia-smi, Triton :8002):
    python3 tools/resource_monitor.py services-python-cctv-epw-s27 --model yolo26s_1280
"""
import argparse
import datetime
import os
import re
import subprocess
import threading
import time
import urllib.request

CLK_TCK = os.sysconf('SC_CLK_TCK')
FPS_RE = re.compile(r'Processing FPS: ([0-9.]+)')
DET_RE = re.compile(r'det=([0-9.]+)')
METRIC_RE = re.compile(r'^(nv_inference_(?:count|exec_count|queue_duration_us|compute_infer_duration_us))\{model="([^"]+)"[^}]*\} ([0-9.e+]+)$')
# clocks_event_reasons bits worth flagging (idle 0x1 is ignored)
THROTTLE_BITS = {0x4: 'pwrcap', 0x8: 'hwslow', 0x20: 'swthermal', 0x40: 'hwthermal', 0x80: 'pwrbrake'}

HEADER = (f"{'time':>8}  {'fps':>5} {'det':>5}  {'main%':>5} {'max':>4}  {'proc%':>5}  {'host%':>5}  "
          f"{'gpu%':>4} {'max':>3}  {'watt':>4} {'max':>4}  {'sm_mhz':>6}  {'trt_q':>6} {'trt_c':>6} {'batch':>5} {'inf/s':>5}  flags")


def main_pid(container):
    out = subprocess.run(['docker', 'top', container, '-o', 'pid,cmd'], capture_output=True, text=True).stdout
    for line in out.splitlines()[1:]:
        pid, _, cmd = line.strip().partition(' ')
        if 'main.py' in cmd:
            return int(pid)
    raise SystemExit(f'main.py process not found in {container}')


def cpu_ticks(path):
    with open(path) as f:
        fields = f.read().rsplit(')', 1)[1].split()
    return int(fields[11]) + int(fields[12])  # utime + stime


def host_ticks():
    with open('/proc/stat') as f:
        vals = [int(v) for v in f.readline().split()[1:]]
    idle = vals[3] + vals[4]
    return sum(vals) - idle, sum(vals)


def triton_metrics(url):
    totals = {}
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            for line in r.read().decode().splitlines():
                m = METRIC_RE.match(line)
                if m:
                    name, model, val = m.groups()
                    totals[(name, model)] = float(val)
    except OSError:
        pass
    return totals


class GpuReader(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.samples = []
        self.lock = threading.Lock()

    def run(self):
        cmd = ['nvidia-smi', '--query-gpu=utilization.gpu,power.draw,clocks.sm,clocks_event_reasons.active',
               '--format=csv,noheader,nounits', '-lms', '1000']
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1)
        for line in proc.stdout:
            try:
                util, watt, sm, reasons = [v.strip() for v in line.split(',')]
                sample = (float(util), float(watt), float(sm), int(reasons, 16))
            except ValueError:
                continue
            with self.lock:
                self.samples.append(sample)

    def take(self):
        with self.lock:
            s, self.samples = self.samples, []
        return s


class FpsReader(threading.Thread):
    def __init__(self, container):
        super().__init__(daemon=True)
        self.container = container
        self.latest = None
        self.lock = threading.Lock()

    def run(self):
        proc = subprocess.Popen(['docker', 'logs', '-f', '--since', '0s', self.container],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)
        for line in proc.stdout:
            m = FPS_RE.search(line)
            if m:
                d = DET_RE.search(line)
                with self.lock:
                    self.latest = (float(m.group(1)), d.group(1) if d else None)

    def take(self):
        with self.lock:
            v, self.latest = self.latest, None
        return v


def run(container, model, interval, metrics_url):
    pid = main_pid(container)
    main_path, proc_path = f'/proc/{pid}/task/{pid}/stat', f'/proc/{pid}/stat'
    gpu, fps = GpuReader(), FpsReader(container)
    gpu.start()
    fps.start()

    print(f"{container} pid={pid} model={model} interval={interval}s  "
          f"(main% = camera main thread, 100 = one full core; trt_q/trt_c = Triton queue/compute ms per request)")
    print(HEADER, flush=True)

    prev_m = triton_metrics(metrics_url)
    last_main, last_proc, last_host = cpu_ticks(main_path), cpu_ticks(proc_path), host_ticks()
    last_t = time.time()
    main_samples, proc_samples, host_samples = [], [], []
    window_start = time.time()
    while True:
        time.sleep(1)
        try:
            m, p = cpu_ticks(main_path), cpu_ticks(proc_path)
        except FileNotFoundError:
            print('camera process exited (container restarted?) — stopping', flush=True)
            return
        h = host_ticks()
        now = time.time()
        dt = now - last_t
        main_samples.append((m - last_main) / CLK_TCK / dt * 100)
        proc_samples.append((p - last_proc) / CLK_TCK / dt * 100)
        host_samples.append((h[0] - last_host[0]) / max(1, h[1] - last_host[1]) * 100)
        last_main, last_proc, last_host, last_t = m, p, h, now

        if now - window_start < interval:
            continue
        window_start = now

        cur_m = triton_metrics(metrics_url)

        def delta(name, mdl=model):
            return cur_m.get((name, mdl), 0) - prev_m.get((name, mdl), 0)

        n_req = delta('nv_inference_count')
        n_exec = delta('nv_inference_exec_count')
        q_ms = delta('nv_inference_queue_duration_us') / n_req / 1000 if n_req else 0
        c_ms = delta('nv_inference_compute_infer_duration_us') / n_req / 1000 if n_req else 0
        batch = n_req / n_exec if n_exec else 0
        fleet = sum(v - prev_m.get(k, 0) for k, v in cur_m.items() if k[0] == 'nv_inference_count') / interval
        prev_m = cur_m

        g = gpu.take()
        util = [s[0] for s in g] or [0]
        watt = [s[1] for s in g] or [0]
        sm = [s[2] for s in g] or [0]
        reasons = 0
        for s in g:
            reasons |= s[3]
        f = fps.take()

        flags = [name for bit, name in THROTTLE_BITS.items() if reasons & bit]
        if max(main_samples) >= 95:
            flags.append('MAIN-THREAD-BOUND')
        if f and f[0] < 12:
            flags.append('LOW-FPS')

        def avg(v):
            return sum(v) / len(v)

        print(f"{datetime.datetime.now():%H:%M:%S}  {f[0] if f else '-':>5} {(f[1] or '-') if f else '-':>5}  "
              f"{avg(main_samples):5.0f} {max(main_samples):4.0f}  {avg(proc_samples):5.0f}  {avg(host_samples):5.0f}  "
              f"{avg(util):4.0f} {max(util):3.0f}  {avg(watt):4.0f} {max(watt):4.0f}  {min(sm):6.0f}  "
              f"{q_ms:6.1f} {c_ms:6.1f} {batch:5.2f} {fleet:5.0f}  {' '.join(flags)}", flush=True)
        main_samples, proc_samples, host_samples = [], [], []


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('container')
    ap.add_argument('--model', required=True, help='Triton model this camera uses (TRITON_MODEL in its .env)')
    ap.add_argument('--interval', type=int, default=10)
    ap.add_argument('--metrics-url', default='http://localhost:8002/metrics')
    args = ap.parse_args()
    try:
        run(args.container, args.model, args.interval, args.metrics_url)
    except KeyboardInterrupt:
        pass
