"""Export a YOLO .pt checkpoint to ONNX for the Triton model repository.

This is the ONLY place ultralytics/torch is needed. Run it inside the export
container (see Dockerfile.export) or any environment with ultralytics installed:

    python export_model.py --weights yolo26m.pt --imgsz 640 --out-dir ../models

Produces:
    models/<name>_<imgsz>/1/model.onnx
    models/<name>_<imgsz>/metadata.json     (imgsz, e2e flag, classes)
    models/<name>_<imgsz>/config.pbtxt      (onnxruntime CPU config; the
                                             model-builder rewrites it for TensorRT)

Never exports with ultralytics' nms=True: that NMS stage only returns detections
for the first image of a batch, and Triton's dynamic batching merges requests
from different cameras (it emptied about half the frames in production). YOLO26
is NMS-free and exports as end-to-end [B, 300, 6]; older heads (YOLO11) export
the raw [B, 4+nc, anchors] head and the client runs NMS (decode_raw). Both are
batch-safe. The layout is read from the exported ONNX, not from ultralytics'
end2end flag, which is False even for YOLO26 checkpoints.

Verify any new model with tools/batch_check.py before pointing cameras at it.
"""

import argparse
import json
import shutil
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--weights', required=True, help='Path to .pt weights (e.g. yolo26m.pt)')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--out-dir', default='../models', help='Triton model repository root')
    ap.add_argument('--name', default=None, help='Model repo name (default: <stem>_<imgsz>)')
    ap.add_argument('--max-det', type=int, default=300)
    args = ap.parse_args()

    from ultralytics import YOLO

    weights = Path(args.weights)
    name = args.name or f"{weights.stem}_{args.imgsz}"
    model_dir = Path(args.out_dir) / name
    version_dir = model_dir / '1'
    version_dir.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(weights))
    print(f"Exporting {weights} -> {version_dir / 'model.onnx'}")
    onnx_path = model.export(
        format='onnx',
        imgsz=args.imgsz,
        nms=False,
        max_det=args.max_det,
        simplify=True,
        dynamic=True,    # dynamic batch axis: required for Triton dynamic batching (max_batch_size 8)
    )
    shutil.move(onnx_path, version_dir / 'model.onnx')

    import onnx  # installed by ultralytics' ONNX export
    out_dims = [d.dim_param or d.dim_value
                for d in onnx.load(str(version_dir / 'model.onnx')).graph.output[0].type.tensor_type.shape.dim]
    is_e2e = out_dims[-1] == 6
    print(f"Output {out_dims}: {'end-to-end' if is_e2e else 'raw head (client-side NMS)'}")

    metadata = {
        'source_weights': weights.name,
        'imgsz': args.imgsz,
        'end_to_end': is_e2e,   # True: [B, max_det, 6] xyxy+conf+cls; False: raw [B, 4+nc, anchors]
        'max_det': args.max_det,
        'classes': model.names,
    }
    (model_dir / 'metadata.json').write_text(json.dumps(metadata, indent=2))

    # Default config: onnxruntime CPU. build_engine.sh rewrites this to
    # tensorrt_plan after building model.plan on the target device.
    config = f'''name: "{name}"
platform: "onnxruntime_onnx"
max_batch_size: 8
dynamic_batching {{
  max_queue_delay_microseconds: 5000
}}
instance_group [
  {{ count: 1, kind: KIND_CPU }}
]
'''
    (model_dir / 'config.pbtxt').write_text(config)
    print(f"Done. Model repository entry: {model_dir}")
    print("Run tools/build_engine.sh on the target device to build a TensorRT plan (GPU modes).")


if __name__ == '__main__':
    main()
