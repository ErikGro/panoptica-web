from bottle import Bottle, request
from panoptica_server.evaluation import evaluate_panoptica

def health() -> dict[str, str]:
    return {"status": "ok"}

def create_app() -> Bottle:
    app = Bottle()
    app.route("/api/health", "GET", health)
    app.route("/api/evaluate", "GET", evaluate_panoptica)

    return app