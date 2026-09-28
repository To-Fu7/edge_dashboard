"""preprocess() must match the previous numpy implementation and be faster.

Run from python-counting/:  python tests/test_preprocess.py [frame.jpg ...]
"""
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from inference.preprocessing import letterbox, preprocess

FAILED = []


def check(name, cond, detail=''):
    print(f"  {'PASS' if cond else 'FAIL'} {name} {detail}")
    if not cond:
        FAILED.append(name)


def reference(frame_bgr, input_shape, dtype=np.float32):
    padded, ratio, pad = letterbox(frame_bgr, input_shape)
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None], dtype=dtype), ratio, pad


def timeit(fn, n=30):
    fn()
    t0 = time.perf_counter()
    for _ in range(n):
        fn()
    return (time.perf_counter() - t0) / n * 1000


def main():
    rng = np.random.default_rng(0)
    frames = [('random 1920x1080', rng.integers(0, 256, (1080, 1920, 3), dtype=np.uint8)),
              ('random 800x600', rng.integers(0, 256, (600, 800, 3), dtype=np.uint8))]
    for path in sys.argv[1:]:
        img = cv2.imread(path)
        if img is not None:
            frames.append((os.path.basename(path), img))

    for label, frame in frames:
        for size in ((640, 640), (1280, 1280)):
            print(f'[{label} -> {size[0]}]')
            ref, r_ratio, r_pad = reference(frame, size)
            new, n_ratio, n_pad = preprocess(frame, size, np.float32)
            check('float shape/dtype', new.shape == ref.shape and new.dtype == np.float32, str(new.shape))
            check('float contiguous', new.flags['C_CONTIGUOUS'])
            diff = float(np.abs(new - ref).max())
            check('float values match', diff < 1e-6, f'(max abs diff {diff:.2e})')
            check('ratio/pad unchanged', r_ratio == n_ratio and r_pad == n_pad)

            u8, _, _ = preprocess(frame, size, np.uint8)
            check('uint8 NHWC shape', u8.shape == (1, size[0], size[1], 3) and u8.dtype == np.uint8, str(u8.shape))
            back = u8[0].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
            check('uint8 + /255 + transpose == float path', float(np.abs(back - ref).max()) < 1e-6)

            f16, _, _ = preprocess(frame, size, np.float16)
            check('fp16 path', f16.dtype == np.float16 and f16.shape == ref.shape)

            t_old = timeit(lambda: reference(frame, size))
            t_new = timeit(lambda: preprocess(frame, size, np.float32))
            t_u8 = timeit(lambda: preprocess(frame, size, np.uint8))
            print(f'  time ms: old {t_old:.1f}  new float {t_new:.1f}  uint8 {t_u8:.1f}  '
                  f'| bytes float {ref.nbytes / 1e6:.1f} MB, uint8 {u8.nbytes / 1e6:.1f} MB')

    print(f"\n{'ALL PASSED' if not FAILED else 'FAILED: ' + ', '.join(sorted(set(FAILED)))}")
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
