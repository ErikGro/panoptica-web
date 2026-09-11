import math

import numpy as np
from bottle import request, response
from PIL import Image

from panoptica import (
    ConnectedComponentsInstanceApproximator,
    InputType,
    NaiveThresholdMatching,
    Panoptica_Evaluator,
)
from panoptica.metrics import Metric

try:  # keep the server non-interactive; harmless if the API differs
    from panoptica import disable_citation_reminder

    disable_citation_reminder()
except Exception:  # noqa: BLE001
    pass

# Binary masks -> instances via connected components, then IoU-based matching.
evaluator = Panoptica_Evaluator(
    expected_input=InputType.SEMANTIC,
    instance_approximator=ConnectedComponentsInstanceApproximator(),
    instance_matcher=NaiveThresholdMatching(),
    decision_metric=Metric.IOU,
    decision_threshold=0.5,
)


def _to_binary_mask(upload) -> np.ndarray:
    """Decode an uploaded RGBA PNG into a 2-D binary (0/1) uint8 array.

    Foreground = any drawn (non-transparent) pixel. Using the alpha channel is
    robust to stroke color and to the layer's display opacity; a luminance
    threshold would drop dark strokes (e.g. red ~119/255).
    """
    img = Image.open(upload.file).convert("RGBA")
    alpha = np.asarray(img)[..., 3]
    return (alpha > 10).astype(np.uint8)


def _json_safe(value):
    """Recursively make a to_dict() result JSON-serializable.

    numpy scalars -> python numbers; NaN/inf -> None (Bottle would otherwise
    emit NaN/Infinity tokens that break strict JSON.parse on the frontend).
    """
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return value


def evaluate_panoptica():
    if "prediction" not in request.files or "reference" not in request.files:
        response.status = 400
        return {"error": "expected multipart fields 'prediction' and 'reference'"}

    try:
        pred = _to_binary_mask(request.files["prediction"])
        ref = _to_binary_mask(request.files["reference"])

        if pred.shape != ref.shape:
            response.status = 400
            return {"error": f"shape mismatch: prediction {pred.shape} vs reference {ref.shape}"}

        result = evaluator.evaluate(pred, ref)["ungrouped"]
        return _json_safe(result.to_dict())
    except Exception as exc:  # noqa: BLE001 — always answer /api with JSON, never an HTML 500
        response.status = 500
        return {"error": f"{type(exc).__name__}: {exc}"}
