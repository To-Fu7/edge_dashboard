"""Check that a model gives the same detections over system shared memory as
over a plain gRPC request, and how long each takes.

Run inside the camera image with the host's /dev/shm mounted (as the camera
containers have it), from python-counting/:

    python tools/shm_check.py --url triton:8001 --model yolo26n_640_e2e_u8 frame1.jpg frame2.jpg
"""
import argparse
import importlib
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def load_client(shm: bool):
    os.environ['TRITON_SHM'] = 'auto' if shm else 'off'
    import inference.triton_client as tc
    return importlib.reload(tc)


def run(module, url, model, frames, repeat):
    client = module.TritonYoloClient(url, model, class_id=None)
    client.connect()
    transport = 'shared memory' if client._shm else 'grpc payload'
    dets = [client.infer(f) for f in frames]
    t0 = time.perf_counter()
    for _ in range(repeat):
        for f in frames:
            client.infer(f)
    ms = (time.perf_counter() - t0) * 1000 / (repeat * len(frames))
    client.close()
    return transport, dets, ms


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default=os.getenv('TRITON_URL', 'triton:8001'))
    ap.add_argument('--model', required=True)
    ap.add_argument('--repeat', type=int, default=20)
    ap.add_argument('frames', nargs='+')
    args = ap.parse_args()

    frames = [cv2.imread(p) for p in args.frames]
    if any(f is None for f in frames):
        sys.exit('could not read one of the frames')

    t_shm, d_shm, ms_shm = run(load_client(True), args.url, args.model, frames, args.repeat)
    t_grpc, d_grpc, ms_grpc = run(load_client(False), args.url, args.model, frames, args.repeat)
    print(f'{args.model}: {t_shm} {ms_shm:.1f} ms/frame, {t_grpc} {ms_grpc:.1f} ms/frame')

    ok = True
    for path, a, b in zip(args.frames, d_shm, d_grpc):
        same = a.shape == b.shape and np.allclose(a, b, atol=1e-3)
        ok &= same
        print(f'  {os.path.basename(path):24} {len(a):3} vs {len(b):3} dets  {"same" if same else "DIFFERENT"}')
    if t_shm != 'shared memory':
        print('shared memory was NOT used — is /dev/shm shared with Triton?')
        ok = False
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
