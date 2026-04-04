import math
import os
import re
from functools import lru_cache
from pathlib import Path

from openpyxl import load_workbook


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def resolve_dataset_path():
    override = os.environ.get("RIGSYNC_DATASET_PATH")
    if override:
        return Path(override).expanduser()

    search_roots = [
        PROJECT_ROOT,
        Path.home() / "Downloads",
    ]
    candidate_names = (
        "iseData.xlsx",
    )

    for search_root in search_roots:
        for candidate_name in candidate_names:
            candidate = search_root / candidate_name
            if candidate.exists():
                return candidate

    return PROJECT_ROOT / "FinalData.xlsx"


DATASET_PATH = resolve_dataset_path()

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

SHEET_NAME_CANDIDATES = {
    "rig": ("Expanded Loads", "Rig Loads"),
    "startup": ("Expanded Additional Loads", "Additional Needed Loads"),
    "truck": ("Trucks Info",),
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
    if "flatbed" in key:
        key = "flatbed"
    elif "lowbed" in key or "support" in key:
        key = "lowbed"
    elif "heavyhaul" in key:
        key = "heavyhauler"
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
    return [match.upper() for match in re.findall(r"\b(?:RL|SU)-\d+(?:-L\d+)?\b", text, flags=re.IGNORECASE)]


def normalize_header(value):
    text = normalize_text(value)
    if not text:
        return None
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def read_sheet_rows(workbook, candidate_names):
    sheet = next((workbook[name] for name in candidate_names if name in workbook.sheetnames), None)
    if sheet is None:
        raise KeyError(f"None of the expected sheets were found: {', '.join(candidate_names)}")

    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        return []

    headers = [normalize_header(value) for value in rows[0]]
    records = []
    for row in rows[1:]:
        record = {}
        for index, header in enumerate(headers):
            if not header:
                continue
            record[header] = row[index] if index < len(row) else None
        records.append(record)
    return records


def row_value(row, *header_names):
    for header_name in header_names:
        value = row.get(normalize_header(header_name))
        if value is not None:
            return value
    return None


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
    code = normalize_text(row_value(row, "Load ID", "Code"))
    if not code:
        return None

    minimum_crew = parse_crew_counts(row_value(row, "Minimum Crew (Rig Down / Rig Up)", "Minimum Crew"))
    optimal_crew = parse_crew_counts(row_value(row, "Optimal Crew (Rig Down / Rig Up)", "Optimal Crew"))
    weight_value = row_value(row, "Weight (tons)", "Weight")
    dimensions_value = row_value(row, "Dimensions (L x W x H)", "Dimensions")
    is_expanded_code = bool(re.search(r"-L\d+$", code, flags=re.IGNORECASE))
    load_count = 1 if is_expanded_code else (normalize_int(row_value(row, "Total Loads in Task", "Load Count", "Count")) or 1)

    return {
        "id": normalize_int(code),
        "code": code,
        "load_type": normalize_text(row_value(row, "Load Type")),
        "description": normalize_text(row_value(row, "Description")),
        "category": normalize_text(row_value(row, "Category")),
        "load_count": load_count,
        "weight_tons": parse_weight_tons(weight_value),
        "weight_text": normalize_text(weight_value),
        "dimensions": parse_dimension_triplet(dimensions_value),
        "dimensions_text": normalize_text(dimensions_value),
        "priority": normalize_int(row_value(row, "Priority")) or 0,
        "rig_down_dependency_codes": parse_dependency_codes(row_value(row, "Rig Down Predecessor(s)")),
        "rig_up_dependency_codes": parse_dependency_codes(row_value(row, "Rig Up Predecessor(s)")),
        "avg_rig_down_minutes": parse_duration_minutes(row_value(row, "Avg Rig Down Time", "Average Rig Down Time")),
        "avg_rig_up_minutes": parse_duration_minutes(row_value(row, "Avg Rig Up Time", "Average Rig Up Time")),
        "is_critical": parse_yes_no(row_value(row, "Critical Lift", "Critical")),
        "truck_type": normalize_text(row_value(row, "Truck Type(s)", "Truck Type")),
        "truck_types": parse_truck_types(row_value(row, "Truck Type(s)", "Truck Type")),
        "minimum_crew_down_count": sum(minimum_crew["rig_down"].values()),
        "minimum_crew_up_count": sum(minimum_crew["rig_up"].values()),
        "optimal_crew_down_count": sum(optimal_crew["rig_down"].values()),
        "optimal_crew_up_count": sum(optimal_crew["rig_up"].values()),
        "minimum_crew_down_roles": minimum_crew["rig_down"],
        "minimum_crew_up_roles": minimum_crew["rig_up"],
        "optimal_crew_down_roles": optimal_crew["rig_down"],
        "optimal_crew_up_roles": optimal_crew["rig_up"],
        "optimal_rig_down_minutes": parse_duration_minutes(row_value(row, "Optimal Rig Down Time")),
        "optimal_rig_up_minutes": parse_duration_minutes(row_value(row, "Optimal Rig Up Time")),
    }


def build_startup_load_payload(row):
    code = normalize_text(row_value(row, "Load ID", "Code"))
    if not code:
        return None
    weight_value = row_value(row, "Weight (tons)", "Weight")
    dimensions_value = row_value(row, "Dimensions (L x W x H)", "Dimensions")
    is_expanded_code = bool(re.search(r"-L\d+$", code, flags=re.IGNORECASE))
    count = 1 if is_expanded_code else (normalize_int(row_value(row, "Count", "Load #", "Load Count")) or 1)

    return {
        "id": code,
        "code": code,
        "load_type": normalize_text(row_value(row, "Load Type")),
        "description": normalize_text(row_value(row, "Description")),
        "count": count,
        "weight_tons": parse_weight_tons(weight_value),
        "weight_text": normalize_text(weight_value),
        "dimensions": parse_dimension_triplet(dimensions_value),
        "dimensions_text": normalize_text(dimensions_value),
        "priority": normalize_int(row_value(row, "Priority")) or 0,
        "dependencyLabel": normalize_text(row_value(row, "Rig Up Predecessor(s)", "Dependency")) or "Standalone startup load",
        "rig_up_dependency_codes": parse_dependency_codes(row_value(row, "Rig Up Predecessor(s)", "Dependency")),
        "avg_rig_up_minutes": parse_duration_minutes(row_value(row, "Avg Rig Up Time", "Average Rig Up Time")),
        "truck_type": normalize_text(row_value(row, "Truck Type(s)", "Truck Type")),
        "truckTypes": parse_truck_types(row_value(row, "Truck Type(s)", "Truck Type")),
        "isReusable": any(code.startswith(prefix) for prefix in STARTUP_REUSABLE_IDS),
    }


def build_truck_spec_payload(row):
    truck_type = normalize_truck_type(row_value(row, "Truck Type", "Type"))
    if not truck_type:
        return None

    alpha_values = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", normalize_text(row_value(row, "α", "Alpha")) or "")]
    alpha = sum(alpha_values) / len(alpha_values) if alpha_values else 0.3

    return {
        "type": truck_type,
        "max_weight_tons": normalize_float(row_value(row, "Maximum Weight (tons)", "Maximum Weight")) or 0,
        "dimensions": parse_dimension_triplet(row_value(row, "Approx. Truck Dimensions (L x W x H, m)", "Dimensions")),
        "average_speed_kmh": normalize_float(row_value(row, "Average Speed (km/h)", "Average Speed")) or 0,
        "alpha": alpha,
    }


@lru_cache(maxsize=1)
def load_planning_dataset():
    workbook = load_workbook(DATASET_PATH, data_only=True)

    rig_loads = [
        payload
        for payload in (
            build_rig_load_payload(row)
            for row in read_sheet_rows(workbook, SHEET_NAME_CANDIDATES["rig"])
        )
        if payload
    ]
    startup_loads = [
        payload
        for payload in (
            build_startup_load_payload(row)
            for row in read_sheet_rows(workbook, SHEET_NAME_CANDIDATES["startup"])
        )
        if payload
    ]
    truck_specs = [
        payload
        for payload in (
            build_truck_spec_payload(row)
            for row in read_sheet_rows(workbook, SHEET_NAME_CANDIDATES["truck"])
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
