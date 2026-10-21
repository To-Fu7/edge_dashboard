"""gRPC client for YOLO person detection served by NVIDIA Triton.

The camera container is a thin client: no torch, no CUDA context. All model
knowledge (input name/shape/precision, output layout) is discovered from Triton
model metadata at connect time, so the same client code serves TensorRT engines
(jetson/server modes) and onnxruntime-CPU models (cpu mode) without config drift.

Frames travel through system shared memory when Triton can see the same
/dev/shm (both containers mount the host's): the client writes the tensor into
its own region and the request only names it. That skips serializing ~1.2 MB
per frame into protobuf on both sides, which was most of the camera's CPU.
Without a shared /dev/shm (or TRITON_SHM=off) it falls back to sending the
tensor inside the request.

Failure model (Triton is a shared dependency for every camera):
- connect() and infer() raise TritonUnavailableError on transport/server errors.
- The caller (main loop) keeps the RTSP capture alive, backs off exponentially,
  and resets the tracker after reconnect — the process never exits because of
  Triton being down.
"""
from __future__ import annotations

import logging
import os

import numpy as np

import tritonclient.grpc as grpcclient
from tritonclient.utils import InferenceServerException

try:
    import tritonclient.utils.shared_memory as sysshm
except Exception:  # noqa: BLE001 — libcshm missing for this platform: request payloads only
    sysshm = None

from .postprocessing import decode_e2e, decode_raw, is_end_to_end, unletterbox
from .preprocessing import preprocess

_TRITON_TO_NP = {"FP32": np.float32, "FP16": np.float16, "UINT8": np.uint8}

SHM_ENABLED = os.getenv("TRITON_SHM", "auto").lower() not in ("off", "false", "0")


class TritonUnavailableError(RuntimeError):
    """Raised when Triton cannot be reached or inference fails server-side."""


class TritonYoloClient:
    def __init__(
        self,
        url: str,
        model_name: str,
        conf_thresh: float = 0.3,
        iou_thresh: float = 0.3,
        class_id: int | None = 0,
        timeout_s: float = 10.0,
    ):
        self.url = url
        self.model_name = model_name
        self.conf_thresh = conf_thresh
        self.iou_thresh = iou_thresh
        self.class_id = class_id
        self.timeout_s = timeout_s

        self._client: grpcclient.InferenceServerClient | None = None
        self.input_name: str | None = None
        self.input_dtype = np.float32
        self.input_datatype = "FP32"  # Triton's name for input_dtype
        self.input_shape: tuple[int, int] = (640, 640)  # (H, W)
        self.output_name: str | None = None
        self.end_to_end: bool = True
        self._batched_model = True  # config.max_batch_size > 0
        # System shared memory: {'in'|'out': (triton region name, handle, byte size)}
        self._shm: dict[str, tuple[str, object, int]] = {}
        self._out_dtype = np.float32
        self._shm_warned = False

    @property
    def connected(self) -> bool:
        return self._client is not None

    def connect(self):
        """Open the gRPC channel and read model metadata/config."""
        try:
            client = grpcclient.InferenceServerClient(url=self.url, verbose=False)
            if not client.is_server_ready():
                raise TritonUnavailableError(f"Triton at {self.url} is not ready")
            if not client.is_model_ready(self.model_name):
                raise TritonUnavailableError(
                    f"Model '{self.model_name}' is not loaded on Triton at {self.url}"
                )

            meta = client.get_model_metadata(self.model_name, as_json=True)
            config = client.get_model_config(self.model_name, as_json=True).get("config", {})
        except InferenceServerException as e:
            raise TritonUnavailableError(f"Triton connect failed ({self.url}): {e}") from e

        inp = meta["inputs"][0]
        out = meta["outputs"][0]
        self.input_name = inp["name"]
        self.output_name = out["name"]
        self.input_datatype = inp["datatype"] if inp["datatype"] in _TRITON_TO_NP else "FP32"
        self.input_dtype = _TRITON_TO_NP[self.input_datatype]
        self._batched_model = int(config.get("max_batch_size", 0) or 0) > 0

        # dims exclude the batch axis when max_batch_size > 0; UINT8 models are NHWC
        dims = [int(d) for d in inp["shape"]]
        if self.input_dtype == np.uint8 and len(dims) >= 3 and dims[-1] == 3:
            hw = dims[-3:-1]
        else:
            hw = dims[-2:] if len(dims) >= 2 else [640, 640]
        self.input_shape = tuple(640 if d <= 0 else d for d in hw)

        out_dims = [int(d) for d in out["shape"]]
        self.end_to_end = is_end_to_end(tuple(out_dims))

        self._client = client
        self._setup_shm(client, out)
        logging.info(
            f"[Triton] Connected {self.url} model={self.model_name} "
            f"input={self.input_name}{list(self.input_shape)} dtype={inp['datatype']} "
            f"output={self.output_name} e2e={self.end_to_end} "
            f"transport={'shared memory' if self._shm else 'grpc payload'}"
        )

    def _setup_shm(self, client, out_meta: dict):
        """Create and register this client's input (and, for a fixed-size output,
        output) region. Any failure leaves the client on request payloads."""
        if not SHM_ENABLED or sysshm is None:
            return
        h, w = self.input_shape
        in_bytes = h * w * 3 * np.dtype(self.input_dtype).itemsize
        out_dims = [int(d) for d in out_meta["shape"]][1 if self._batched_model else 0:]
        out_dtype = _TRITON_TO_NP.get(out_meta["datatype"])
        out_bytes = (int(np.prod(out_dims)) * np.dtype(out_dtype).itemsize
                     if out_dtype is not None and out_dims and all(d > 0 for d in out_dims) else 0)
        # Stable per device + model, so a restarted camera reuses its regions
        # instead of leaving new ones behind in /dev/shm.
        tag = f"edge_{os.getenv('EDGE_DEVICE_ID') or os.getpid()}_{self.model_name}"
        try:
            for kind, size in (("in", in_bytes), ("out", out_bytes)):
                if not size:
                    continue
                name = f"{tag}_{kind}"
                try:
                    client.unregister_system_shared_memory(name, client_timeout=2.0)
                except InferenceServerException:
                    pass
                handle = sysshm.create_shared_memory_region(name, "/" + name, size)
                self._shm[kind] = (name, handle, size)
                client.register_system_shared_memory(name, "/" + name, size)
        except Exception as e:  # noqa: BLE001 — e.g. Triton can't see our /dev/shm
            self._release_shm(client)
            if not self._shm_warned:
                logging.warning(f"[Triton] shared memory unavailable for {self.model_name}, "
                                f"sending frames in the request instead: {e}")
                self._shm_warned = True
            return
        self._out_dtype = out_dtype or np.float32

    def _release_shm(self, client):
        for name, handle, _ in self._shm.values():
            if client is not None:
                try:
                    client.unregister_system_shared_memory(name, client_timeout=2.0)
                except Exception:  # noqa: BLE001 — Triton may be gone; the region is still ours to free
                    pass
            try:
                sysshm.destroy_shared_memory_region(handle)
            except Exception:  # noqa: BLE001
                pass
        self._shm = {}

    def close(self):
        if self._shm:
            self._release_shm(self._client)
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def infer(self, frame_bgr: np.ndarray, pre_cache: dict | None = None) -> np.ndarray:
        """Detect persons in a BGR frame. Returns [N, 6] x1,y1,x2,y2,conf,cls in frame pixels.

        pre_cache: optional per-frame dict shared across clients — clients whose
        (input_shape, dtype) match reuse the same preprocessed tensor instead of
        re-letterboxing the identical frame once per model.
        """
        if self._client is None:
            self.connect()

        cache_key = (self.input_shape, np.dtype(self.input_dtype).name)
        if pre_cache is not None and cache_key in pre_cache:
            tensor, ratio, pad = pre_cache[cache_key]
        else:
            tensor, ratio, pad = preprocess(frame_bgr, self.input_shape, self.input_dtype)
            if pre_cache is not None:
                pre_cache[cache_key] = (tensor, ratio, pad)
        infer_input = grpcclient.InferInput(self.input_name, list(tensor.shape), self.input_datatype)
        requested = grpcclient.InferRequestedOutput(self.output_name)
        shm_in, shm_out = self._shm.get("in"), self._shm.get("out")
        if shm_in:
            sysshm.set_shared_memory_region(shm_in[1], [tensor])
            infer_input.set_shared_memory(shm_in[0], tensor.nbytes)
        else:
            infer_input.set_data_from_numpy(tensor)
        if shm_out:
            requested.set_shared_memory(shm_out[0], shm_out[2])
        outputs = [requested]

        try:
            result = self._client.infer(
                model_name=self.model_name,
                inputs=[infer_input],
                outputs=outputs,
                client_timeout=self.timeout_s,
            )
        except InferenceServerException as e:
            self.close()
            raise TritonUnavailableError(f"Triton infer failed ({self.url}): {e}") from e

        if shm_out:
            # astype copies, so the next request can reuse the region safely.
            shape = list(result.get_output(self.output_name).shape)
            output = sysshm.get_contents_as_numpy(shm_out[1], self._out_dtype, shape).astype(np.float32)
        else:
            output = result.as_numpy(self.output_name).astype(np.float32)

        if self.end_to_end:
            dets = decode_e2e(output, self.conf_thresh, self.class_id)
        else:
            dets = decode_raw(output, self.conf_thresh, self.iou_thresh, self.class_id)

        return unletterbox(dets, ratio, pad, frame_bgr.shape[:2])
