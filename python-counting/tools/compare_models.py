"""Compare person detections of two Triton models on the same frames.

Used to verify a uint8 variant (tools/make_uint8_input.py) matches its float
original before switching cameras to it, and to compare per-call latency.

Usage (inside the camera image, on the Triton network):
    python tools/compare_models.py --pair yolo26s_640 yolo26s_640_u8 frames/*.jpg
"""
import argparse
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from inference import TritonYoloClient


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pair', nargs=2, required=True, metavar=('REFERENCE', 'CANDIDATE'))
    ap.add_argument('--url', default=os.getenv('TRITON_URL', 'triton:8001'))
    ap.add_argument('--conf', type=float, default=0.3, help='Detections at/above this are compared')
    ap.add_argument('--show-extra', action='store_true', help='Print candidate-only detections')
    ap.add_argument('frames', nargs='+')
    args = ap.parse_args()

    ref = TritonYoloClient(args.url, args.pair[0], conf_thresh=0.05)
    cand = TritonYoloClient(args.url, args.pair[1], conf_thresh=0.05)
    ref.connect()
    cand.connect()

    n_ref = n_cand = matched = missing = extra = 0
    ious, conf_diffs, t_ref, t_cand = [], [], [], []
    for path in args.frames:
        frame = cv2.imread(path)
        if frame is None:
            continue
        t0 = time.perf_counter(); a = ref.infer(frame); t_ref.append(time.perf_counter() - t0)
        t0 = time.perf_counter(); b = cand.infer(frame); t_cand.append(time.perf_counter() - t0)
        A = [d for d in a if d[4] >= args.conf]
        B = list(b)
        n_ref += len(A)
        n_cand += sum(1 for d in B if d[4] >= args.conf)
        used = set()
        for d in A:
            best, bi = 0.0, -1
            for j, e in enumerate(B):
                if j not in used:
                    v = iou(d, e)
                    if v > best:
                        best, bi = v, j
            if best >= 0.5:
                used.add(bi)
                matched += 1
                ious.append(best)
                conf_diffs.append(abs(float(d[4]) - float(B[bi][4])))
            else:
                missing += 1
        for j, e in enumerate(B):
            if j in used or e[4] < args.conf:
                continue
            extra += 1
            if args.show_extra:
                near = max(((iou(e, d), float(d[4])) for d in a), default=(0.0, 0.0))
                print(f"  extra {os.path.basename(path)} conf={e[4]:.3f} box=({e[0]:.0f},{e[1]:.0f},{e[2]:.0f},{e[3]:.0f}) "
                      f"size={e[2] - e[0]:.0f}x{e[3] - e[1]:.0f}  best ref IoU={near[0]:.2f} @conf={near[1]:.3f}")

    frames = len(t_ref)
    print(f"{args.pair[0]} vs {args.pair[1]} on {frames} frames (conf >= {args.conf})")
    print(f"  detections: reference {n_ref}, candidate {n_cand}")
    print(f"  matched {matched}, missing in candidate {missing}, extra in candidate {extra}")
    if ious:
        print(f"  IoU of matches: mean {np.mean(ious):.4f}, min {np.min(ious):.4f}")
        print(f"  |conf diff|: mean {np.mean(conf_diffs):.4f}, max {np.max(conf_diffs):.4f}")
    print(f"  latency per call ms: reference {1000 * np.median(t_ref):.1f}, candidate {1000 * np.median(t_cand):.1f} (median)")


if __name__ == '__main__':
    main()
