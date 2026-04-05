from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import text
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


FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
STATE_TABLES_READY = False


def log_timing(endpoint, started_at, **fields):
    elapsed_ms = round((time.perf_counter() - started_at) * 1000, 1)
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"[timing] endpoint={endpoint} elapsed_ms={elapsed_ms}{(' ' + details) if details else ''}", flush=True)


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

    from database import engine

    if engine.dialect.name == "sqlite":
        STATE_TABLES_READY = True
        return

    from database import Base

    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE move_records ADD COLUMN IF NOT EXISTS summary_payload JSON"))
        connection.execute(text("ALTER TABLE manager_resource_states ADD COLUMN IF NOT EXISTS trucks JSON"))
        connection.execute(text("ALTER TABLE manager_resource_states ADD COLUMN IF NOT EXISTS drivers JSON"))
        connection.execute(text("ALTER TABLE manager_resource_states ADD COLUMN IF NOT EXISTS task_assignments JSON"))
        connection.execute(text("ALTER TABLE manager_resource_states DROP COLUMN IF EXISTS workers"))
    STATE_TABLES_READY = True


def initialize_app_state_tables():
    ensure_state_tables()


def get_default_resource_state(manager_id):
    defaults = {
        "manager-nasser": {
            "fleet": [],
            "trucks": [],
            "drivers": [],
            "task_assignments": [],
        }
    }
    return defaults.get(manager_id, {"fleet": [], "trucks": [], "drivers": [], "task_assignments": []})


def build_move_summary(payload):
    simulation = payload.get("simulation") or {}
    best_plan = simulation.get("bestPlan") or {}

    return {
        "id": payload.get("id"),
        "name": payload.get("name"),
        "createdAt": payload.get("createdAt"),
        "updatedAt": payload.get("updatedAt"),
        "createdBy": payload.get("createdBy") or {},
        "routeMode": payload.get("routeMode"),
        "loadCount": payload.get("loadCount") or 0,
        "startPoint": payload.get("startPoint"),
        "endPoint": payload.get("endPoint"),
        "startLabel": payload.get("startLabel"),
        "endLabel": payload.get("endLabel"),
        "routeKm": payload.get("routeKm"),
        "eta": payload.get("eta"),
        "routeTime": payload.get("routeTime"),
        "planningStartDate": payload.get("planningStartDate"),
        "planningStartTime": payload.get("planningStartTime"),
        "progressMinute": payload.get("progressMinute") or 0,
        "completionPercentage": payload.get("completionPercentage") or 0,
        "executionState": payload.get("executionState") or "planning",
        "operatingState": payload.get("operatingState") or "standby",
        "executionProgress": payload.get("executionProgress") or {},
        "truckSetup": payload.get("truckSetup") or simulation.get("truckSetup") or [],
        "simulation": {
            "truckCount": simulation.get("truckCount") or best_plan.get("truckCount") or 0,
            "truckSetup": simulation.get("truckSetup") or [],
            "routeMinutes": simulation.get("routeMinutes"),
            "preferredScenarioName": simulation.get("preferredScenarioName") or "",
        },
    }


def ensure_record_summary(record):
    if record.summary_payload:
        return record.summary_payload

    summary_payload = build_move_summary(record.payload or {})
    record.summary_payload = summary_payload
    return summary_payload


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
    started_at = time.perf_counter()
    manager_id = request.args.get("managerId", type=str)
    summary = request.args.get("summary", default="0", type=str) == "1"

    session = SessionLocal()
    try:
        query = session.query(MoveRecord)
        if manager_id:
            query = query.filter(MoveRecord.manager_id == manager_id)
        if summary:
            summary_rows = query.with_entities(MoveRecord.id, MoveRecord.summary_payload).all()
            missing_ids = [move_id for move_id, summary_payload in summary_rows if not summary_payload]
            summary_by_id = {move_id: summary_payload for move_id, summary_payload in summary_rows if summary_payload}

            if missing_ids:
                missing_records = session.query(MoveRecord).filter(MoveRecord.id.in_(missing_ids)).all()
                for record in missing_records:
                    summary_by_id[record.id] = ensure_record_summary(record)
                session.commit()

            response = jsonify([summary_by_id.get(move_id) for move_id, _ in summary_rows if summary_by_id.get(move_id)])
            log_timing("/api/moves", started_at, manager_id=manager_id, summary=1, records=len(summary_rows))
            return response

        records = query.all()
        response = jsonify([record.payload for record in records])
        log_timing("/api/moves", started_at, manager_id=manager_id, summary=0, records=len(records))
        return response
    finally:
        session.close()


@app.get("/api/moves/<move_id>")
def get_move(move_id):
    started_at = time.perf_counter()
    session = SessionLocal()
    try:
        record = session.get(MoveRecord, move_id)
        if not record:
            log_timing("/api/moves/<move_id>", started_at, move_id=move_id, found=0)
            return jsonify({"error": "move not found"}), 404
        response = jsonify(record.payload)
        log_timing("/api/moves/<move_id>", started_at, move_id=move_id, found=1)
        return response
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
                summary_payload=build_move_summary(move),
                payload=move,
            )
            session.add(record)
        else:
            record.manager_id = manager_id
            record.created_by_id = created_by.get("id")
            record.summary_payload = build_move_summary(move)
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
    started_at = time.perf_counter()
    session = SessionLocal()
    try:
        record = session.get(ManagerResourceState, manager_id)
        if not record:
            defaults = get_default_resource_state(manager_id)
            record = ManagerResourceState(
                manager_id=manager_id,
                fleet=defaults["fleet"],
                trucks=defaults["trucks"],
                drivers=defaults["drivers"],
                task_assignments=defaults["task_assignments"],
            )
            session.add(record)
            session.commit()
        response = jsonify(
            {
                "fleet": record.fleet or [],
                "trucks": record.trucks or [],
                "drivers": record.drivers or [],
                "taskAssignments": record.task_assignments or [],
            }
        )
        log_timing(
            "/api/manager-resources/<manager_id>",
            started_at,
            manager_id=manager_id,
            fleet=len(record.fleet or []),
            trucks=len(record.trucks or []),
            drivers=len(record.drivers or []),
        )
        return response
    finally:
        session.close()


@app.put("/api/manager-resources/<manager_id>")
def put_manager_resources(manager_id):
    payload = request.get_json(silent=True) or {}
    defaults = get_default_resource_state(manager_id)
    fleet = payload.get("fleet")
    trucks = payload.get("trucks")
    drivers = payload.get("drivers")
    task_assignments = payload.get("taskAssignments", payload.get("task_assignments"))

    if fleet is not None and not isinstance(fleet, list):
        return jsonify({"error": "fleet must be a list"}), 400
    if trucks is not None and not isinstance(trucks, list):
        return jsonify({"error": "trucks must be a list"}), 400
    if drivers is not None and not isinstance(drivers, list):
        return jsonify({"error": "drivers must be a list"}), 400
    if task_assignments is not None and not isinstance(task_assignments, list):
        return jsonify({"error": "taskAssignments must be a list"}), 400

    session = SessionLocal()
    try:
        record = session.get(ManagerResourceState, manager_id)
        if not record:
            record = ManagerResourceState(
                manager_id=manager_id,
                fleet=fleet if fleet is not None else defaults["fleet"],
                trucks=trucks if trucks is not None else defaults["trucks"],
                drivers=drivers if drivers is not None else defaults["drivers"],
                task_assignments=task_assignments if task_assignments is not None else defaults["task_assignments"],
            )
            session.add(record)
        else:
            if fleet is not None:
                record.fleet = fleet
            if trucks is not None:
                record.trucks = trucks
            if drivers is not None:
                record.drivers = drivers
            if task_assignments is not None:
                record.task_assignments = task_assignments
        session.commit()
        return jsonify(
            {
                "fleet": record.fleet or [],
                "trucks": record.trucks or [],
                "drivers": record.drivers or [],
                "taskAssignments": record.task_assignments or [],
            }
        )
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
