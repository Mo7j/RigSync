from pathlib import Path

from flask import Flask, jsonify, send_from_directory
from sqlalchemy import select

from database import SessionLocal
from models import LoadDependency, LoadTemplate


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")


@app.get("/api/loads")
def get_loads():
    session = SessionLocal()
    try:
        loads = session.scalars(select(LoadTemplate).order_by(LoadTemplate.id)).all()
        dependencies = session.scalars(
            select(LoadDependency).order_by(LoadDependency.load_id, LoadDependency.id)
        ).all()

        dependency_map = {}
        for dependency in dependencies:
            dependency_map.setdefault(dependency.load_id, []).append(
                dependency.depends_on_load_id
            )

        payload = []
        for load in loads:
            payload.append(
                {
                    "id": load.id,
                    "phase": load.phase,
                    "category": load.category,
                    "description": load.description,
                    "priority": load.priority,
                    "truck_type": load.truck_type,
                    "avg_duration_minutes": load.avg_duration_minutes,
                    "is_critical": load.is_critical,
                    "floor_men": load.floor_men,
                    "roustabouts": load.roustabouts,
                    "electricians": load.electricians,
                    "mechanics": load.mechanics,
                    "welders": load.welders,
                    "dependency_ids": dependency_map.get(load.id, []),
                }
            )

        return jsonify(payload)
    finally:
        session.close()


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ == "__main__":
    app.run(debug=True)
