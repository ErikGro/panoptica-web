from panoptica import InputType, Panoptica_Evaluator
from panoptica.metrics import Metric

evaluator = Panoptica_Evaluator(
    expected_input=InputType.MATCHED_INSTANCE,
    decision_metric=Metric.IOU,
    decision_threshold=0.5,
)

def evaluate_panoptica(ref, pred):
    return evaluator.evaluate(pred, ref)["ungrouped"]