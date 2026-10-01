"""Check that a Triton YOLO model returns the same detections per image whether
the image is sent alone (batch 1) or together with others in one batch.

Triton's dynamic batcher merges requests from different cameras, so a model
whose outputs change with batch size silently corrupts detections in production.

Usage (inside the camera image, on the Triton network):
    python tools/batch_check.py --model yolo26s_640_u8 frames/a.jpg frames/b.jpg frames/c.jpg
"""
import argparse
import os
import sys

import cv2
import numpy as np
import tritonclient.grpc as grpcclient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from inference import TritonYoloClient
from inference.postprocessing import decode_e2e
from inference.preprocessing import preprocess


def run(client, meta, tensors):
    batch = np.concatenate(tensors, axis=0)
    inp = grpcclient.InferInput(meta.input_name, list(batch.shape), meta.input_datatype)
    inp.set_data_from_numpy(batch)
    out = client.infer(meta.model_name, [inp]).as_numpy(meta.output_name)
    return [decode_e2e(out[i:i + 1].astype(np.float32), 0.3, 0) for i in range(len(tensors))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', required=True)
    ap.add_argument('--url', default=os.getenv('TRITON_URL', 'triton:8001'))
    ap.add_argument('frames', nargs='+')
    args = ap.parse_args()

    meta = TritonYoloClient(args.url, args.model)
    meta.connect()
    tensors = [preprocess(cv2.imread(f), meta.input_shape, meta.input_dtype)[0] for f in args.frames]
    client = grpcclient.InferenceServerClient(args.url)

    single = [run(client, meta, [t])[0] for t in tensors]
    batched = run(client, meta, tensors)
    print(f"{args.model} ({meta.input_datatype})")
    for f, s, b in zip(args.frames, single, batched):
        same = len(s) == len(b) and (len(s) == 0 or np.allclose(np.sort(s[:, 4]), np.sort(b[:, 4]), atol=0.01))
        print(f"  {os.path.basename(f):24s} batch1: {len(s):3d} dets   in batch of {len(tensors)}: {len(b):3d} dets   "
              f"{'same' if same else 'DIFFERENT'}")


if __name__ == '__main__':
    main()
