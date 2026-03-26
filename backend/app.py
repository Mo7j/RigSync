from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import select

from database import SessionLocal
from models import LoadDependency, LoadTemplate


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")


def resolve_location_label(lat, lng):
    query = urlencode(
        {
            "format": "jsonv2",
            "lat": lat,
            "lon": lng,
            "zoom": 10,
            "accept-language": "en",
        }
    )
    request_url = f"https://nominatim.openstreetmap.org/reverse?{query}"
    outbound_request = Request(
        request_url,
        headers={
            "User-Agent": "RigSync/1.0 (location label lookup)"
        },
    )

    try:
        with urlopen(outbound_request, timeout=8) as response:
            payload = response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError):
        return None

    import json

    data = json.loads(payload)
    address = data.get("address", {})
    return (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or address.get("suburb")
        or address.get("city_district")
        or address.get("borough")
        or address.get("district")
        or address.get("neighbourhood")
        or address.get("hamlet")
        or address.get("quarter")
        or address.get("residential")
        or address.get("road")
        or address.get("county")
        or address.get("state_district")
        or address.get("state")
    )


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


@app.get("/api/location-label")
def get_location_label():
    lat = request.args.get("lat", type=float)
    lng = request.args.get("lng", type=float)

    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required"}), 400

    label = resolve_location_label(lat, lng)
    return jsonify({"label": label})


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ == "__main__":
    app.run(debug=True)
