"""Build a batch-safe end-to-end YOLO model with TensorRT's EfficientNMS plugin.

The ultralytics nms=True export only returns detections for the first image of a
batch, so Triton's dynamic batching silently emptied most cameras' frames. This
takes a raw-head export (export_model.py --no-nms, output [B, 4+nc, anchors] with
cx,cy,w,h boxes and sigmoid scores) and appends EfficientNMS_TRT, which runs NMS
per image, then packs its outputs into the [B, max_det, 6] (x1,y1,x2,y2,conf,cls)
layout inference/postprocessing.decode_e2e already reads. Unused rows are zeros,
so they fall below any confidence threshold.

Usage (needs `onnx`, e.g. inside the yolo-export image), from tools/:
    python add_efficient_nms.py --src ../models/yolo26s_640_nonms --dst ../models/yolo26s_640_enms_u8 --uint8
Then build the engine with build_engine.sh.
"""
import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from make_uint8_input import add_uint8_input


def const(graph, name, values):
    graph.initializer.append(numpy_helper.from_array(np.array(values, dtype=np.int64), name))
    return name


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--src', required=True, help='Raw-head model dir (export_model.py --no-nms)')
    ap.add_argument('--dst', required=True)
    ap.add_argument('--uint8', action='store_true', help='Also take uint8 NHWC input (see make_uint8_input.py)')
    ap.add_argument('--iou', type=float, default=0.3, help='NMS IoU (matches the previous exports)')
    ap.add_argument('--score', type=float, default=0.01, help='Min score kept (client filters further)')
    ap.add_argument('--max-det', type=int, default=300)
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    meta = json.loads((src / 'metadata.json').read_text())
    size = int(meta['imgsz'])
    model = onnx.load(str(src / '1' / 'model.onnx'))
    graph = model.graph

    raw = graph.output[0]
    dims = [d.dim_value for d in raw.type.tensor_type.shape.dim]
    num_ch = dims[1]
    if num_ch < 5:
        raise SystemExit(f'expected raw head [B, 4+nc, anchors], got {dims}')
    batch = raw.type.tensor_type.shape.dim[0]
    batch_dim = batch.dim_param or batch.dim_value or 'batch'
    out = raw.name
    graph.output.remove(raw)
    for node in graph.node:  # keep the external output name for the packed result
        node.output[:] = ['raw_head' if x == out else x for x in node.output]
    graph.initializer.append(numpy_helper.from_array(np.array(0.5, dtype=np.float32), 'nms_half'))

    graph.node.extend([
        helper.make_node('Transpose', ['raw_head'], ['nms_pred'], perm=[0, 2, 1]),  # [B, anchors, 4+nc]
        # cx,cy,w,h -> x1,y1,x2,y2 here so the plugin's box format is unambiguous (box_coding=0)
        helper.make_node('Slice', ['nms_pred', const(graph, 'nms_c0', [0]), const(graph, 'nms_c2', [2]),
                                   const(graph, 'nms_ax', [2])], ['nms_xy']),
        helper.make_node('Slice', ['nms_pred', 'nms_c2', const(graph, 'nms_c4', [4]), 'nms_ax'], ['nms_wh']),
        helper.make_node('Mul', ['nms_wh', 'nms_half'], ['nms_half_wh']),
        helper.make_node('Sub', ['nms_xy', 'nms_half_wh'], ['nms_x1y1']),
        helper.make_node('Add', ['nms_xy', 'nms_half_wh'], ['nms_x2y2']),
        helper.make_node('Concat', ['nms_x1y1', 'nms_x2y2'], ['nms_boxes'], axis=2),
        helper.make_node('Slice', ['nms_pred', 'nms_c4', const(graph, 'nms_s1', [num_ch]), 'nms_ax'], ['nms_scores']),
        helper.make_node('EfficientNMS_TRT', ['nms_boxes', 'nms_scores'],
                         ['num_dets', 'det_boxes', 'det_scores', 'det_classes'],
                         background_class=-1, box_coding=0, iou_threshold=args.iou,
                         max_output_boxes=args.max_det, plugin_version='1', score_activation=0,
                         score_threshold=args.score),
        helper.make_node('Unsqueeze', ['det_scores', const(graph, 'nms_u2', [2])], ['det_scores_3d']),
        helper.make_node('Cast', ['det_classes'], ['det_classes_f'], to=TensorProto.FLOAT),
        helper.make_node('Unsqueeze', ['det_classes_f', 'nms_u2'], ['det_classes_3d']),
        helper.make_node('Concat', ['det_boxes', 'det_scores_3d', 'det_classes_3d'], [out], axis=2),
    ])
    graph.output.insert(0, helper.make_tensor_value_info(out, TensorProto.FLOAT, [batch_dim, args.max_det, 6]))

    if args.uint8:
        add_uint8_input(model, size)

    # No onnx.checker: EfficientNMS_TRT is a TensorRT plugin op the checker doesn't know.
    (dst / '1').mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst / '1' / 'model.onnx'))

    meta.update({'end_to_end': True, 'max_det': args.max_det, 'export_iou': args.iou,
                 'nms': 'EfficientNMS_TRT', 'derived_from': src.name})
    if args.uint8:
        meta.update({'input_layout': 'NHWC', 'input_dtype': 'uint8'})
    (dst / 'metadata.json').write_text(json.dumps(meta, indent=2))
    cfg = (src / 'config.pbtxt').read_text().replace(f'name: "{src.name}"', f'name: "{dst.name}"')
    (dst / 'config.pbtxt').write_text(cfg)
    print(f'{src.name} -> {dst.name}: output {out} [{batch_dim},{args.max_det},6]'
          f'{", uint8 NHWC input" if args.uint8 else ""}')


if __name__ == '__main__':
    main()
