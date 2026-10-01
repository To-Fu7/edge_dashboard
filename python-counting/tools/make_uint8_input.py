"""Make a UINT8/NHWC-input copy of a YOLO model in the Triton repository.

The float models take a normalized NCHW float32 tensor, which the camera client
has to build, serialize and send every frame (19.6 MB at 1280x1280). This wraps
an existing model.onnx so its input is the letterboxed RGB image as uint8 NHWC
and the /255 + HWC->CHW happen inside the graph, on the GPU:

    images (uint8 [N,H,W,3]) -> Cast(float) -> Div(255) -> Transpose(0,3,1,2) -> original graph

The input keeps the name "images", so inference/triton_client.py only needs the
datatype from Triton metadata to pick the uint8 path.

Usage (needs the `onnx` package, e.g. inside the yolo-export image):
    python make_uint8_input.py --src ../models/yolo26s_640 --dst ../models/yolo26s_640_u8
Then build the engine with build_engine.sh (it reads input_layout from metadata.json).
"""
import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def add_uint8_input(model, size):
    """Replace the float NCHW input with uint8 NHWC + Cast/Div(255)/Transpose, in place."""
    graph = model.graph
    old = graph.input[0]
    name = old.name
    batch = old.type.tensor_type.shape.dim[0]
    batch_dim = batch.dim_param or batch.dim_value or 'batch'

    inner = f'{name}_f32'
    for node in graph.node:
        node.input[:] = [inner if x == name else x for x in node.input]

    graph.input.remove(old)
    graph.input.insert(0, helper.make_tensor_value_info(name, TensorProto.UINT8, [batch_dim, size, size, 3]))
    graph.initializer.append(numpy_helper.from_array(np.array(255.0, dtype=np.float32), f'{name}_255'))
    graph.node.insert(0, helper.make_node('Transpose', [f'{name}_scaled'], [inner], perm=[0, 3, 1, 2]))
    graph.node.insert(0, helper.make_node('Div', [f'{name}_float', f'{name}_255'], [f'{name}_scaled']))
    graph.node.insert(0, helper.make_node('Cast', [name], [f'{name}_float'], to=TensorProto.FLOAT))
    return name, batch_dim


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--src', required=True, help='Source model dir (with 1/model.onnx and metadata.json)')
    ap.add_argument('--dst', required=True, help='Destination model dir to create')
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    meta = json.loads((src / 'metadata.json').read_text())
    size = int(meta['imgsz'])

    model = onnx.load(str(src / '1' / 'model.onnx'))
    name, batch_dim = add_uint8_input(model, size)

    onnx.checker.check_model(model)
    (dst / '1').mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst / '1' / 'model.onnx'))

    meta.update({'input_layout': 'NHWC', 'input_dtype': 'uint8', 'derived_from': src.name})
    (dst / 'metadata.json').write_text(json.dumps(meta, indent=2))
    shutil.copy(src / 'config.pbtxt', dst / 'config.pbtxt')
    cfg = (dst / 'config.pbtxt').read_text().replace(f'name: "{src.name}"', f'name: "{dst.name}"')
    (dst / 'config.pbtxt').write_text(cfg)
    print(f'{src.name} -> {dst.name}: input {name} uint8 [{batch_dim},{size},{size},3]')


if __name__ == '__main__':
    main()
