from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy.orm import selectinload

from database import SessionLocal
from models import (
    LoadDependency,
    LoadRoleRequirement,
    LoadTemplate,
    ManagerResourceState,
    MoveRecord,
    RigInventoryState,
    TruckSpec,
)
from planning_dataset import get_worker_roles


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
STATE_TABLES_READY = False


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


def serialize_dimensions(load_template):
    if (
        load_template.length_m is None
        and load_template.width_m is None
        and load_template.height_m is None
    ):
        return None

    return {
        "length": load_template.length_m,
        "width": load_template.width_m,
        "height": load_template.height_m,
    }


def serialize_load_template(load_template):
    dependency_groups = {"rig_down": [], "rig_up": []}
    for dependency in load_template.dependencies:
        depends_on = dependency.depends_on_load_template
        if not depends_on:
            continue
        dependency_groups.setdefault(dependency.dependency_phase, []).append(depends_on.code)

    compatible_types = [item.truck_type for item in load_template.allowed_truck_types]
    role_requirement_groups = {
        "minimum": {"rig_down": {}, "rig_up": {}},
        "optimal": {"rig_down": {}, "rig_up": {}},
    }
    for requirement in load_template.role_requirements:
        role_requirement_groups.setdefault(requirement.requirement_kind, {}).setdefault(requirement.phase, {})[
            requirement.role_id
        ] = requirement.required_count

    payload = {
        "id": load_template.id,
        "code": load_template.code,
        "load_type": load_template.load_type,
        "description": load_template.description,
        "weight_tons": load_template.weight_tons,
        "weight_text": load_template.weight_text,
        "dimensions": serialize_dimensions(load_template),
        "dimensions_text": load_template.dimensions_text,
        "priority": load_template.priority,
        "truck_type": " / ".join(compatible_types) if compatible_types else None,
    }

    if load_template.source_kind == "rig":
        payload.update(
            {
                "category": load_template.category,
                "load_count": load_template.load_count,
                "rig_down_dependency_codes": sorted(set(dependency_groups.get("rig_down", []))),
                "rig_up_dependency_codes": sorted(set(dependency_groups.get("rig_up", []))),
                "avg_rig_down_minutes": load_template.avg_rig_down_minutes,
                "avg_rig_up_minutes": load_template.avg_rig_up_minutes,
                "is_critical": load_template.is_critical,
                "truck_types": compatible_types,
                "minimum_crew_down_count": load_template.minimum_crew_down_count,
                "minimum_crew_up_count": load_template.minimum_crew_up_count,
                "optimal_crew_down_count": load_template.optimal_crew_down_count,
                "optimal_crew_up_count": load_template.optimal_crew_up_count,
                "minimum_crew_down_roles": role_requirement_groups["minimum"]["rig_down"],
                "minimum_crew_up_roles": role_requirement_groups["minimum"]["rig_up"],
                "optimal_crew_down_roles": role_requirement_groups["optimal"]["rig_down"],
                "optimal_crew_up_roles": role_requirement_groups["optimal"]["rig_up"],
                "optimal_rig_down_minutes": load_template.optimal_rig_down_minutes,
                "optimal_rig_up_minutes": load_template.optimal_rig_up_minutes,
            }
        )
        return payload

    payload.update(
        {
            "count": load_template.load_count,
            "dependencyLabel": load_template.dependency_label,
            "rig_up_dependency_codes": sorted(set(dependency_groups.get("rig_up", []))),
            "avg_rig_up_minutes": load_template.avg_rig_up_minutes,
            "truckTypes": compatible_types,
            "isReusable": load_template.is_reusable,
        }
    )
    return payload


def read_db_dataset():
    session = SessionLocal()
    try:
        load_templates = (
            session.query(LoadTemplate)
            .options(
                selectinload(LoadTemplate.allowed_truck_types),
                selectinload(LoadTemplate.dependencies).selectinload(LoadDependency.depends_on_load_template),
                selectinload(LoadTemplate.role_requirements),
            )
            .order_by(LoadTemplate.id)
            .all()
        )
        truck_specs = session.query(TruckSpec).order_by(TruckSpec.type).all()

        if not load_templates and not truck_specs:
            raise RuntimeError("Planning dataset tables are empty. Import the Supabase dataset first.")

        rig_loads = [
            serialize_load_template(load_template)
            for load_template in load_templates
            if load_template.source_kind == "rig"
        ]
        startup_loads = [
            serialize_load_template(load_template)
            for load_template in load_templates
            if load_template.source_kind == "startup"
        ]
        truck_payload = [
            {
                "type": truck_spec.type,
                "max_weight_tons": truck_spec.max_weight_tons,
                "dimensions": {
                    "length": truck_spec.max_length_m,
                    "width": truck_spec.max_width_m,
                    "height": truck_spec.max_height_m,
                },
                "average_speed_kmh": truck_spec.average_speed_kmh,
                "alpha": truck_spec.alpha,
            }
            for truck_spec in truck_specs
        ]

        return {
            "rig_loads": rig_loads,
            "startup_loads": startup_loads,
            "truck_specs": truck_payload,
        }
    finally:
        session.close()


def get_active_dataset():
    return read_db_dataset()


def ensure_state_tables():
    global STATE_TABLES_READY
    if STATE_TABLES_READY:
        return

    from database import Base, engine

    Base.metadata.create_all(bind=engine)
    STATE_TABLES_READY = True


def initialize_app_state_tables():
    ensure_state_tables()


def get_default_resource_state(manager_id):
    default_worker_counts = {
        "assistant_driller": 1,
        "bop_tech": 1,
        "camp_foreman": 1,
        "crane_operator": 2,
        "derrickman": 1,
        "driller": 1,
        "electrician": 3,
        "floorman": 8,
        "forklift_crane_operator": 2,
        "mechanic": 3,
        "operator": 1,
        "pumpman_mechanic": 1,
        "rigger": 4,
        "roustabout": 8,
        "welder": 2,
        "yard_foreman": 2,
    }
    default_worker_rates = {
        "assistant_driller": 28,
        "bop_tech": 34,
        "camp_foreman": 24,
        "crane_operator": 30,
        "derrickman": 26,
        "driller": 32,
        "electrician": 34,
        "floorman": 20,
        "forklift_crane_operator": 28,
        "mechanic": 36,
        "operator": 24,
        "pumpman_mechanic": 36,
        "rigger": 22,
        "roustabout": 18,
        "welder": 32,
        "yard_foreman": 26,
    }
    defaults = {
        "manager-nasser": {
            "fleet": [
                {"id": "heavy-haul", "type": "Heavy Hauler", "count": 6, "hourlyCost": 260},
                {"id": "flatbed", "type": "Flat-bed", "count": 4, "hourlyCost": 105},
                {"id": "low-bed", "type": "Low-bed", "count": 3, "hourlyCost": 155},
            ],
            "workers": {
                role["id"]: {
                    "count": default_worker_counts.get(role["id"], 0),
                    "hourlyCost": default_worker_rates.get(role["id"], 0),
                }
                for role in get_worker_roles()
            },
        }
    }
    return defaults.get(manager_id, {"fleet": [], "workers": {}})


@app.get("/api/dataset-status")
def get_dataset_status():
    dataset = get_active_dataset()
    return jsonify(
        {
            "source": "database",
            "rig_loads": len(dataset["rig_loads"]),
            "startup_loads": len(dataset["startup_loads"]),
            "truck_specs": len(dataset["truck_specs"]),
        }
    )


@app.get("/api/moves")
def get_moves():
    manager_id = request.args.get("managerId", type=str)

    session = SessionLocal()
    try:
        query = session.query(MoveRecord)
        if manager_id:
            query = query.filter(MoveRecord.manager_id == manager_id)
        records = query.all()
        return jsonify([record.payload for record in records])
    finally:
        session.close()


@app.put("/api/moves/<move_id>")
def put_move(move_id):
    payload = request.get_json(silent=True) or {}
    move = payload.get("move") or payload
    if not isinstance(move, dict):
        return jsonify({"error": "move payload is required"}), 400

    created_by = move.get("createdBy") or {}
    manager_id = created_by.get("id") if created_by.get("role") == "Manager" else created_by.get("managerId")
    if not manager_id:
        return jsonify({"error": "manager_id could not be derived from move.createdBy"}), 400

    session = SessionLocal()
    try:
        record = session.get(MoveRecord, move_id)
        if not record:
            record = MoveRecord(
                id=move_id,
                manager_id=manager_id,
                created_by_id=created_by.get("id"),
                payload=move,
            )
            session.add(record)
        else:
            record.manager_id = manager_id
            record.created_by_id = created_by.get("id")
            record.payload = move
        session.commit()
        return jsonify(record.payload)
    finally:
        session.close()


@app.delete("/api/moves/<move_id>")
def delete_move(move_id):
    session = SessionLocal()
    try:
        record = session.get(MoveRecord, move_id)
        if record:
            session.delete(record)
            session.commit()
        return jsonify({"ok": True})
    finally:
        session.close()


@app.get("/api/manager-resources/<manager_id>")
def get_manager_resources(manager_id):
    session = SessionLocal()
    try:
        record = session.get(ManagerResourceState, manager_id)
        if not record:
            defaults = get_default_resource_state(manager_id)
            record = ManagerResourceState(
                manager_id=manager_id,
                fleet=defaults["fleet"],
                workers=defaults["workers"],
            )
            session.add(record)
            session.commit()
        return jsonify({"fleet": record.fleet or [], "workers": record.workers or {}})
    finally:
        session.close()


@app.put("/api/manager-resources/<manager_id>")
def put_manager_resources(manager_id):
    payload = request.get_json(silent=True) or {}
    fleet = payload.get("fleet")
    workers = payload.get("workers")
    if not isinstance(fleet, list) or not isinstance(workers, dict):
        return jsonify({"error": "fleet list and workers object are required"}), 400

    session = SessionLocal()
    try:
        record = session.get(ManagerResourceState, manager_id)
        if not record:
            record = ManagerResourceState(manager_id=manager_id, fleet=fleet, workers=workers)
            session.add(record)
        else:
            record.fleet = fleet
            record.workers = workers
        session.commit()
        return jsonify({"fleet": record.fleet, "workers": record.workers})
    finally:
        session.close()


@app.get("/api/rig-inventory/<rig_id>")
def get_rig_inventory(rig_id):
    session = SessionLocal()
    try:
        record = session.get(RigInventoryState, rig_id)
        return jsonify({"rigId": rig_id, "adjustments": (record.adjustments if record else {})})
    finally:
        session.close()


@app.put("/api/rig-inventory/<rig_id>")
def put_rig_inventory(rig_id):
    payload = request.get_json(silent=True) or {}
    adjustments = payload.get("adjustments")
    if not isinstance(adjustments, dict):
        return jsonify({"error": "adjustments object is required"}), 400

    session = SessionLocal()
    try:
        record = session.get(RigInventoryState, rig_id)
        if not record:
            record = RigInventoryState(rig_id=rig_id, adjustments=adjustments)
            session.add(record)
        else:
            record.adjustments = adjustments
        session.commit()
        return jsonify({"rigId": rig_id, "adjustments": record.adjustments})
    finally:
        session.close()


@app.get("/api/loads")
def get_loads():
    return jsonify(get_active_dataset()["rig_loads"])


@app.get("/api/startup-loads")
def get_startup_loads():
    return jsonify(get_active_dataset()["startup_loads"])


@app.get("/api/truck-specs")
def get_truck_specs():
    return jsonify(get_active_dataset()["truck_specs"])


@app.get("/api/worker-roles")
def get_worker_role_definitions():
    return jsonify(get_worker_roles())


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
    initialize_app_state_tables()
    app.run(debug=True)
