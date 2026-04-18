from pathlib import Path
import json
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
FIREBASE_API_KEY = "AIzaSyDPNmHSjioHB6k1vGS2g05SIHQ30Vw54aM"
FIREBASE_PROJECT_ID = "rigsync-38f79"
FIREBASE_MANAGER_EMAIL = "manager@rigsync.com"
FIREBASE_MANAGER_PASSWORD = "123123"
firebase_token_cache = {"idToken": None, "expiresAt": 0.0}


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
    dependency_groups = {"rig_down": [], "rig_move": [], "rig_up": []}
    dependency_phase_groups = {"rig_down": [], "rig_move": [], "rig_up": []}
    for dependency in load_template.dependencies:
        depends_on = dependency.depends_on_load_template
        if not depends_on:
            continue
        dependency_groups.setdefault(dependency.dependency_phase, []).append(depends_on.code)
        if dependency.predecessor_activity_code:
            dependency_phase_groups.setdefault(dependency.dependency_phase, []).append(dependency.predecessor_activity_code)

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
                "rig_down_dependency_phase_codes": sorted(set(dependency_phase_groups.get("rig_down", []))),
                "rig_move_dependency_codes": sorted(set(dependency_groups.get("rig_move", []))),
                "rig_move_dependency_phase_codes": sorted(set(dependency_phase_groups.get("rig_move", []))),
                "rig_up_dependency_codes": sorted(set(dependency_groups.get("rig_up", []))),
                "rig_up_dependency_phase_codes": sorted(set(dependency_phase_groups.get("rig_up", []))),
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
            "rig_move_dependency_codes": sorted(set(dependency_groups.get("rig_move", []))),
            "rig_move_dependency_phase_codes": sorted(set(dependency_phase_groups.get("rig_move", []))),
            "rig_up_dependency_codes": sorted(set(dependency_groups.get("rig_up", []))),
            "rig_up_dependency_phase_codes": sorted(set(dependency_phase_groups.get("rig_up", []))),
            "avg_rig_up_minutes": load_template.avg_rig_up_minutes,
            "truckTypes": compatible_types,
            "isReusable": load_template.is_reusable,
            "minimum_crew_up_count": load_template.minimum_crew_up_count,
            "optimal_crew_up_count": load_template.optimal_crew_up_count,
            "minimum_crew_up_roles": role_requirement_groups["minimum"]["rig_up"],
            "optimal_crew_up_roles": role_requirement_groups["optimal"]["rig_up"],
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

    from database import Base

    Base.metadata.create_all(bind=engine)
    if engine.dialect.name != "sqlite":
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


def clamp_percentage(value):
    return max(0, min(100, round(float(value))))


def is_coordinate_pair(value):
    return (
        isinstance(value, list)
        and len(value) == 2
        and all(isinstance(entry, (int, float)) for entry in value)
    )


def serialize_firestore_safe_value(value, nested_in_array=False):
    if is_coordinate_pair(value):
        return {
            "__rigsyncType": "point",
            "lat": value[0],
            "lng": value[1],
        }

    if isinstance(value, list):
        items = [serialize_firestore_safe_value(item, nested_in_array=True) for item in value]
        if nested_in_array:
            return {
                "__rigsyncType": "array",
                "items": items,
            }
        return items

    if isinstance(value, dict):
        return {
            key: serialize_firestore_safe_value(entry_value)
            for key, entry_value in value.items()
        }

    return value


def encode_firestore_value(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int) and not isinstance(value, bool):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {
            "arrayValue": {
                "values": [encode_firestore_value(item) for item in value]
            }
        }
    if isinstance(value, dict):
        return {
            "mapValue": {
                "fields": {
                    key: encode_firestore_value(entry_value)
                    for key, entry_value in value.items()
                }
            }
        }
    return {"stringValue": str(value)}


def decode_firestore_value(value):
    if not isinstance(value, dict):
        return None
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return value["stringValue"]
    if "arrayValue" in value:
        return [decode_firestore_value(item) for item in value.get("arrayValue", {}).get("values", [])]
    if "mapValue" in value:
        return {
            key: decode_firestore_value(entry_value)
            for key, entry_value in value.get("mapValue", {}).get("fields", {}).items()
        }
    return None


def restore_firestore_safe_value(value):
    if isinstance(value, list):
        return [restore_firestore_safe_value(item) for item in value]

    if isinstance(value, dict):
        if (
            value.get("__rigsyncType") == "point"
            and isinstance(value.get("lat"), (int, float))
            and isinstance(value.get("lng"), (int, float))
        ):
            return [value["lat"], value["lng"]]
        if value.get("__rigsyncType") == "array" and isinstance(value.get("items"), list):
            return [restore_firestore_safe_value(item) for item in value["items"]]
        return {
            key: restore_firestore_safe_value(entry_value)
            for key, entry_value in value.items()
        }

    return value


def get_firebase_id_token():
    cached_token = firebase_token_cache.get("idToken")
    cached_expiry = firebase_token_cache.get("expiresAt", 0.0)
    if cached_token and cached_expiry > (time.time() + 60):
        return cached_token

    request_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"
    request_body = json.dumps(
        {
            "email": FIREBASE_MANAGER_EMAIL,
            "password": FIREBASE_MANAGER_PASSWORD,
            "returnSecureToken": True,
        }
    ).encode("utf-8")
    outbound_request = Request(
        request_url,
        data=request_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urlopen(outbound_request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))

    id_token = payload.get("idToken")
    expires_in = int(payload.get("expiresIn") or 3600)
    firebase_token_cache["idToken"] = id_token
    firebase_token_cache["expiresAt"] = time.time() + max(60, expires_in - 120)
    return id_token


def fetch_move_from_firestore(move_id):
    request_url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/moves/{move_id}"
    )
    outbound_request = Request(
        request_url,
        headers={
            "Authorization": f"Bearer {get_firebase_id_token()}",
        },
        method="GET",
    )

    with urlopen(outbound_request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))

    fields = payload.get("fields") or {}
    if not fields:
        return None

    decoded = {
        key: decode_firestore_value(value)
        for key, value in fields.items()
    }
    restored = restore_firestore_safe_value(decoded)
    restored["id"] = restored.get("id") or move_id
    return restored


def sync_move_to_firestore(move):
    move_id = str(move.get("id") or "").strip()
    if not move_id:
        raise ValueError("Move id is required for Firestore sync")

    serialized_move = serialize_firestore_safe_value(move)
    patch_fields = {
        "updatedAt": serialized_move.get("updatedAt"),
        "progressMinute": serialized_move.get("progressMinute"),
        "completionPercentage": serialized_move.get("completionPercentage"),
        "executionState": serialized_move.get("executionState"),
        "operatingState": serialized_move.get("operatingState"),
        "executionProgress": serialized_move.get("executionProgress"),
    }
    document_body = {
        "fields": {
            key: encode_firestore_value(value)
            for key, value in patch_fields.items()
        }
    }
    update_mask = urlencode(
        [
            ("updateMask.fieldPaths", "updatedAt"),
            ("updateMask.fieldPaths", "progressMinute"),
            ("updateMask.fieldPaths", "completionPercentage"),
            ("updateMask.fieldPaths", "executionState"),
            ("updateMask.fieldPaths", "operatingState"),
            ("updateMask.fieldPaths", "executionProgress"),
        ]
    )
    request_url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/moves/{move_id}?{update_mask}"
    )
    outbound_request = Request(
        request_url,
        data=json.dumps(document_body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {get_firebase_id_token()}",
        },
        method="PATCH",
    )

    with urlopen(outbound_request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def derive_manager_id_from_move(move):
    created_by = move.get("createdBy") or {}
    if created_by.get("role") == "Manager" and created_by.get("id"):
        return created_by.get("id")
    if created_by.get("managerId"):
        return created_by.get("managerId")
    if move.get("managerId"):
        return move.get("managerId")
    return None


def normalize_demo_tracking_progress(execution_progress):
    base_progress = execution_progress or {}
    return {
        "managerNotified": bool(base_progress.get("managerNotified")),
        "trucksReserved": bool(base_progress.get("trucksReserved")),
        "liveDataRequested": bool(base_progress.get("liveDataRequested")),
        "rigDownCompleted": bool(base_progress.get("rigDownCompleted")),
        "rigMoveCompleted": bool(base_progress.get("rigMoveCompleted")),
        "rigUpCompleted": bool(base_progress.get("rigUpCompleted")),
        "trackingMode": "demoUltrasonic" if base_progress.get("trackingMode") == "demoUltrasonic" else "driverApp",
        "ultrasonicStartCm": max(0, float(base_progress.get("ultrasonicStartCm") or 45)),
        "ultrasonicArrivalCm": max(0, float(base_progress.get("ultrasonicArrivalCm") or 8)),
        "ultrasonicLatestCm": (
            None
            if base_progress.get("ultrasonicLatestCm") is None
            else max(0, float(base_progress.get("ultrasonicLatestCm") or 0))
        ),
        "ultrasonicLastUpdatedAt": base_progress.get("ultrasonicLastUpdatedAt"),
    }


def apply_demo_ultrasonic_reading(move, distance_cm, start_cm=None, arrival_cm=None):
    simulation = move.get("simulation") or {}
    best_plan = simulation.get("bestPlan") or {}
    total_minutes = best_plan.get("totalMinutes") or move.get("progressMinute") or 0
    execution_progress = normalize_demo_tracking_progress(move.get("executionProgress"))

    safe_start_cm = max(
        0,
        float(start_cm if start_cm is not None else execution_progress.get("ultrasonicStartCm") or 45),
    )
    safe_arrival_cm = min(
        safe_start_cm,
        max(0, float(arrival_cm if arrival_cm is not None else execution_progress.get("ultrasonicArrivalCm") or 8)),
    )
    safe_distance_cm = max(0, float(distance_cm))
    total_window_cm = max(safe_start_cm - safe_arrival_cm, 0.001)
    progress_ratio = max(0, min(1, (safe_start_cm - safe_distance_cm) / total_window_cm))
    has_arrived = safe_distance_cm <= safe_arrival_cm
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    updated_execution_progress = {
        **execution_progress,
        "trackingMode": "demoUltrasonic",
        "liveDataRequested": False,
        "ultrasonicStartCm": safe_start_cm,
        "ultrasonicArrivalCm": safe_arrival_cm,
        "ultrasonicLatestCm": safe_distance_cm,
        "ultrasonicLastUpdatedAt": now_iso,
        "rigMoveCompleted": bool(execution_progress.get("rigMoveCompleted")) or has_arrived,
    }

    updated_move = {
        **move,
        "updatedAt": now_iso,
        "executionProgress": updated_execution_progress,
        "completionPercentage": 100 if bool(updated_execution_progress.get("rigUpCompleted")) else clamp_percentage(progress_ratio * 100),
        "progressMinute": (
            total_minutes
            if bool(updated_execution_progress.get("rigUpCompleted"))
            else max(0, round(float(total_minutes) * progress_ratio))
        ),
    }

    if not updated_move.get("executionState"):
        updated_move["executionState"] = "planning"
    if not updated_move.get("operatingState"):
        updated_move["operatingState"] = "standby"

    return updated_move, {
        "distanceCm": safe_distance_cm,
        "startCm": safe_start_cm,
        "arrivalCm": safe_arrival_cm,
        "progressPercent": 100 if bool(updated_execution_progress.get("rigUpCompleted")) else clamp_percentage(progress_ratio * 100),
        "arrived": has_arrived,
        "rigMoveCompleted": bool(updated_execution_progress.get("rigMoveCompleted")),
        "rigUpCompleted": bool(updated_execution_progress.get("rigUpCompleted")),
    }


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


@app.post("/api/demo-ultrasonic")
def post_demo_ultrasonic():
    payload = request.get_json(silent=True) or {}
    move_id = str(payload.get("moveId") or "").strip()
    distance_cm = payload.get("distanceCm")
    start_cm = payload.get("startCm")
    arrival_cm = payload.get("arrivalCm")

    if not move_id:
        return jsonify({"error": "moveId is required"}), 400

    try:
        safe_distance_cm = max(0, float(distance_cm))
    except (TypeError, ValueError):
        return jsonify({"error": "distanceCm must be a number"}), 400

    safe_start_cm = None
    if start_cm is not None:
        try:
            safe_start_cm = max(0, float(start_cm))
        except (TypeError, ValueError):
            return jsonify({"error": "startCm must be a number"}), 400

    safe_arrival_cm = None
    if arrival_cm is not None:
        try:
            safe_arrival_cm = max(0, float(arrival_cm))
        except (TypeError, ValueError):
            return jsonify({"error": "arrivalCm must be a number"}), 400

    started_at = time.perf_counter()
    session = SessionLocal()
    try:
        record = session.get(MoveRecord, move_id)
        move_payload = record.payload if record and isinstance(record.payload, dict) else None
        source = "sqlite"

        if not move_payload:
            try:
                move_payload = fetch_move_from_firestore(move_id)
                source = "firestore"
            except (HTTPError, URLError, TimeoutError, ValueError, OSError) as fetch_error:
                log_timing("/api/demo-ultrasonic", started_at, move_id=move_id, found=0, source="firestore", error="fetch_failed")
                return jsonify({"error": f"move not found in local db and Firestore fetch failed: {fetch_error}"}), 404

        if not move_payload:
            log_timing("/api/demo-ultrasonic", started_at, move_id=move_id, found=0, source="none")
            return jsonify({"error": "move not found"}), 404

        updated_move, sensor_state = apply_demo_ultrasonic_reading(
            move_payload,
            safe_distance_cm,
            start_cm=safe_start_cm,
            arrival_cm=safe_arrival_cm,
        )
        manager_id = derive_manager_id_from_move(updated_move)
        created_by = updated_move.get("createdBy") or {}

        if manager_id:
            if not record:
                record = MoveRecord(
                    id=move_id,
                    manager_id=manager_id,
                    created_by_id=created_by.get("id"),
                    summary_payload=build_move_summary(updated_move),
                    payload=updated_move,
                )
                session.add(record)
            else:
                record.manager_id = manager_id
                record.created_by_id = created_by.get("id")
                record.payload = updated_move
                record.summary_payload = build_move_summary(updated_move)
            session.commit()

        firestore_sync = {"ok": False, "error": None}
        try:
            sync_move_to_firestore(updated_move)
            firestore_sync["ok"] = True
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as sync_error:
            firestore_sync["error"] = str(sync_error)

        response_payload = {
            "ok": True,
            "moveId": move_id,
            "trackingMode": "demoUltrasonic",
            "source": source,
            "sensor": sensor_state,
            "move": build_move_summary(updated_move),
            "firestoreSync": firestore_sync,
        }
        log_timing(
            "/api/demo-ultrasonic",
            started_at,
            move_id=move_id,
            found=1,
            source=source,
            distance_cm=sensor_state["distanceCm"],
            progress=sensor_state["progressPercent"],
            arrived=int(sensor_state["arrived"]),
            firestore_sync=int(firestore_sync["ok"]),
        )
        return jsonify(response_payload)
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
    app.run(host="0.0.0.0", port=5000, debug=True)
