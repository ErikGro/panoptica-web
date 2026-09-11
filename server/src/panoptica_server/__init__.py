def main() -> None:
    from panoptica_server.app import create_app

    create_app().run(host="127.0.0.1", port=8000, debug=True, reloader=True)