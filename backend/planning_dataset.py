import math
import re
from functools import lru_cache
from pathlib import Path

from openpyxl import load_workbook


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "FinalData.xlsx"

WORKER_ROLE_DEFINITIONS = [
    {"id": "assistant_driller", "label": "Assistant Driller"},
    {"id": "bop_tech", "label": "BOP Tech"},
    {"id": "camp_foreman", "label": "Camp Foreman"},
    {"id": "crane_operator", "label": "Crane Operator"},
    {"id": "derrickman", "label": "Derrickman"},
    {"id": "driller", "label": "Driller"},
    {"id": "electrician", "label": "Electrician"},
    {"id": "floorman", "label": "Floorman"},
    {"id": "forklift_crane_operator", "label": "Forklift/Crane Operator"},
    {"id": "mechanic", "label": "Mechanic"},
    {"id": "operator", "label": "Operator"},
    {"id": "pumpman_mechanic", "label": "Pumpman/Mechanic"},
    {"id": "rigger", "label": "Rigger"},
    {"id": "roustabout", "label": "Roustabout"},
    {"id": "welder", "label": "Welder"},
    {"id": "yard_foreman", "label": "Yard Foreman"},
]

WORKER_ROLE_ALIASES = {
    "asst. driller": "assistant_driller",
    "assistant driller": "assistant_driller",
    "bop tech": "bop_tech",
    "bop techs": "bop_tech",
    "camp foreman": "camp_foreman",
    "crane operator": "crane_operator",
    "crane operators": "crane_operator",
    "derrickman": "derrickman",
    "driller": "driller",
    "electrician": "electrician",
    "electricians": "electrician",
    "floormen": "floorman",
    "floor men": "floorman",
    "forklift/crane operator": "forklift_crane_operator",
    "mechanic": "mechanic",
    "mechanics": "mechanic",
    "operator": "operator",
    "pumpman/mechanic": "pumpman_mechanic",
    "rigger": "rigger",
    "riggers": "rigger",
    "roustabout": "roustabout",
    "roustabouts": "roustabout",
    "welder": "welder",
    "welders": "welder",
    "yard foreman": "yard_foreman",
}


TRUCK_TYPE_ALIASES = {
    "flatbed": "Flat-bed",
    "flat-bed": "Flat-bed",
    "lowbed": "Low-bed",
    "low-bed": "Low-bed",
    "heavyhauler": "Heavy Hauler",
    "heavy hauler": "Heavy Hauler",
}

STARTUP_REUSABLE_IDS = {
    "SU-01",
    "SU-02",
    "SU-03",
    "SU-04",
    "SU-05",
    "SU-06",
    "SU-13",
    "SU-14",
}


def normalize_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_int(value):
    if value is None:
        return None
    text = normalize_text(value)
    if text is None:
        return None
    match = re.search(r"-?\d+", text.replace(",", ""))
    return int(match.group()) if match else None


def normalize_float(value):
    if value is None:
        return None
    text = normalize_text(value)
    if text is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    return float(match.group()) if match else None


def parse_duration_minutes(value):
    text = normalize_text(value)
    if not text or text == "—":
        return None
    match = re.search(r"(\d+(?:\.\d+)?)\s*hr", text, flags=re.IGNORECASE)
    return int(math.ceil(float(match.group(1)) * 60)) if match else None


def parse_dimension_triplet(value):
    text = normalize_text(value)
    if not text:
        return None
    values = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", text)]
    if len(values) < 3:
        return None
    return {
        "length": values[0],
        "width": values[1],
        "height": values[2],
    }


def parse_weight_tons(value):
    text = normalize_text(value)
    if not text:
        return None
    values = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", text.replace(",", ""))]
    return max(values) if values else None


def parse_yes_no(value):
    text = normalize_text(value)
    return bool(text and text.lower() in {"yes", "true", "1"})


def normalize_truck_type(value):
    text = normalize_text(value)
    if not text:
        return None
    key = re.sub(r"[^a-z]", "", text.lower())
    return TRUCK_TYPE_ALIASES.get(key, text)


def parse_truck_types(value):
    text = normalize_text(value)
    if not text:
        return []
    return [
        normalized
        for normalized in (
            normalize_truck_type(part)
            for part in re.split(r"[/|,;]+", text)
        )
        if normalized
    ]


def parse_dependency_codes(value):
    text = normalize_text(value)
    if not text or text == "—":
        return []
    return re.findall(r"[A-Z]{2}-\d+", text)


def normalize_worker_role(value):
    text = normalize_text(value)
    if not text:
        return None
    key = text.lower()
    return WORKER_ROLE_ALIASES.get(key)


def parse_crew_section(section, prefix):
    if not section:
        return {}
    match = re.search(rf"{prefix}\s*:\s*(.*)", section, flags=re.IGNORECASE)
    if not match:
        return {}

    requirements = {}
    for part in match.group(1).split(";"):
        text = normalize_text(part)
        if not text:
            continue

        role_match = re.match(r"(.+?)\s+(\d+)\s*$", text)
        if not role_match:
            continue

        role_id = normalize_worker_role(role_match.group(1))
        if not role_id:
            continue

        requirements[role_id] = requirements.get(role_id, 0) + int(role_match.group(2))

    return requirements


def parse_crew_counts(value):
    text = normalize_text(value)
    if not text:
        return {
            "rig_down": {},
            "rig_up": {},
        }
    sections = [part.strip() for part in text.split("|")]
    return {
        "rig_down": parse_crew_section(sections[0] if sections else "", "RD"),
        "rig_up": parse_crew_section(sections[1] if len(sections) > 1 else "", "RU"),
    }


def build_rig_load_payload(row):
    code = normalize_text(row[0])
    if not code:
        return None

    minimum_crew = parse_crew_counts(row[14])
    optimal_crew = parse_crew_counts(row[15])
    weight_tons = parse_weight_tons(row[5])
    dimensions = parse_dimension_triplet(row[6])

    return {
        "id": normalize_int(code),
        "code": code,
        "load_type": normalize_text(row[1]),
        "description": normalize_text(row[2]),
        "category": normalize_text(row[3]),
        "load_count": normalize_int(row[4]) or 1,
        "weight_tons": weight_tons,
        "weight_text": normalize_text(row[5]),
        "dimensions": dimensions,
        "dimensions_text": normalize_text(row[6]),
        "priority": normalize_int(row[7]) or 0,
        "rig_down_dependency_codes": parse_dependency_codes(row[8]),
        "rig_up_dependency_codes": parse_dependency_codes(row[9]),
        "avg_rig_down_minutes": parse_duration_minutes(row[10]),
        "avg_rig_up_minutes": parse_duration_minutes(row[11]),
        "is_critical": parse_yes_no(row[12]),
        "truck_type": normalize_text(row[13]),
        "truck_types": parse_truck_types(row[13]),
        "minimum_crew_down_count": sum(minimum_crew["rig_down"].values()),
        "minimum_crew_up_count": sum(minimum_crew["rig_up"].values()),
        "optimal_crew_down_count": sum(optimal_crew["rig_down"].values()),
        "optimal_crew_up_count": sum(optimal_crew["rig_up"].values()),
        "minimum_crew_down_roles": minimum_crew["rig_down"],
        "minimum_crew_up_roles": minimum_crew["rig_up"],
        "optimal_crew_down_roles": optimal_crew["rig_down"],
        "optimal_crew_up_roles": optimal_crew["rig_up"],
        "optimal_rig_down_minutes": parse_duration_minutes(row[16]),
        "optimal_rig_up_minutes": parse_duration_minutes(row[17]),
    }


def build_startup_load_payload(row):
    code = normalize_text(row[0])
    if not code:
        return None

    return {
        "id": code,
        "code": code,
        "load_type": normalize_text(row[1]),
        "description": normalize_text(row[2]),
        "count": normalize_int(row[3]) or 1,
        "weight_tons": parse_weight_tons(row[4]),
        "weight_text": normalize_text(row[4]),
        "dimensions": parse_dimension_triplet(row[5]),
        "dimensions_text": normalize_text(row[5]),
        "priority": normalize_int(row[6]) or 0,
        "dependencyLabel": normalize_text(row[7]) or "Standalone startup load",
        "rig_up_dependency_codes": parse_dependency_codes(row[7]),
        "avg_rig_up_minutes": parse_duration_minutes(row[8]),
        "truck_type": normalize_text(row[9]),
        "truckTypes": parse_truck_types(row[9]),
        "isReusable": code in STARTUP_REUSABLE_IDS,
    }


def build_truck_spec_payload(row):
    truck_type = normalize_truck_type(row[0])
    if not truck_type:
        return None

    alpha_values = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", normalize_text(row[4]) or "")]
    alpha = sum(alpha_values) / len(alpha_values) if alpha_values else 0.3

    return {
        "type": truck_type,
        "max_weight_tons": normalize_float(row[1]) or 0,
        "dimensions": parse_dimension_triplet(row[2]),
        "average_speed_kmh": normalize_float(row[3]) or 0,
        "alpha": alpha,
    }


@lru_cache(maxsize=1)
def load_planning_dataset():
    workbook = load_workbook(DATASET_PATH, data_only=True)

    rig_sheet = workbook["Rig Loads"]
    startup_sheet = workbook["Additional Needed Loads"]
    truck_sheet = workbook["Trucks Info"]

    rig_loads = [
        payload
        for payload in (
            build_rig_load_payload(row)
            for row in rig_sheet.iter_rows(min_row=2, values_only=True)
        )
        if payload
    ]
    startup_loads = [
        payload
        for payload in (
            build_startup_load_payload(row)
            for row in startup_sheet.iter_rows(min_row=2, values_only=True)
        )
        if payload
    ]
    truck_specs = [
        payload
        for payload in (
            build_truck_spec_payload(row)
            for row in truck_sheet.iter_rows(min_row=2, values_only=True)
        )
        if payload
    ]

    return {
        "rig_loads": rig_loads,
        "startup_loads": startup_loads,
        "truck_specs": truck_specs,
    }


def get_worker_roles():
    return WORKER_ROLE_DEFINITIONS
