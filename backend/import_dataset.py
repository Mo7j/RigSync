import math
import re
from pathlib import Path

import pandas as pd

from database import Base, SessionLocal, engine
from models import LoadDependency, LoadTemplate


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "DataSet.xlsx"
SHEET_NAME = "S1"

EXCEL_TO_DB_COLUMNS = {
    "ID": "id",
    "Phase": "phase",
    "Category": "category",
    "Load Description": "description",
    "Priority": "priority",
    "Truck Type": "truck_type",
    "Critical Operation": "is_critical",
    "Floor Men": "floor_men",
    "Roustabouts": "roustabouts",
    "Electrician": "electricians",
    "Mechanics": "mechanics",
    "Welder/Safety": "welders",
}


def normalize_text(value):
    if pd.isna(value):
        return None

    text = str(value).strip()
    return text or None


def normalize_int(value):
    if pd.isna(value):
        return None

    if isinstance(value, str):
        value = value.strip()
        if not value or value.lower() == "none":
            return None

    return int(float(value))


def parse_duration_minutes(value):
    text = normalize_text(value)
    if text is None or text.lower() == "not specified":
        return None

    match = re.search(r"(\d+(?:\.\d+)?)\s*hr", text, flags=re.IGNORECASE)
    if not match:
        return None

    hours = float(match.group(1))
    return int(math.ceil(hours * 60))


def parse_is_critical(value):
    text = normalize_text(value)
    return bool(text and text.lower() in {"yes", "true", "1"})


def parse_dependency_ids(value):
    if pd.isna(value):
        return []

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return [int(value)]

    text = str(value).strip()
    if not text or text.lower() == "none":
        return []

    dependency_ids = []
    for part in re.split(r"[;,/|]+", text):
        candidate = part.strip()
        if not candidate:
            continue
        match = re.search(r"\d+", candidate)
        if match:
            dependency_ids.append(int(match.group()))

    return dependency_ids


def build_load_template(row):
    template_data = {
        db_column: row.get(excel_column)
        for excel_column, db_column in EXCEL_TO_DB_COLUMNS.items()
    }

    return LoadTemplate(
        id=normalize_int(template_data["id"]),
        phase=normalize_text(template_data["phase"]),
        category=normalize_text(template_data["category"]),
        description=normalize_text(template_data["description"]),
        priority=normalize_text(template_data["priority"]),
        truck_type=normalize_text(template_data["truck_type"]),
        avg_duration_minutes=parse_duration_minutes(row.get("Avg Time (ą Margin)")),
        is_critical=parse_is_critical(template_data["is_critical"]),
        floor_men=normalize_int(template_data["floor_men"]),
        roustabouts=normalize_int(template_data["roustabouts"]),
        electricians=normalize_int(template_data["electricians"]),
        mechanics=normalize_int(template_data["mechanics"]),
        welders=normalize_int(template_data["welders"]),
    )


def import_dataset():
    if not DATASET_PATH.exists():
        raise FileNotFoundError(f"Dataset not found: {DATASET_PATH}")

    df = pd.read_excel(DATASET_PATH, sheet_name=SHEET_NAME)
    records = df.to_dict(orient="records")

    Base.metadata.create_all(bind=engine)

    session = SessionLocal()
    try:
        session.query(LoadDependency).delete()
        session.query(LoadTemplate).delete()

        for row in records:
            load_template = build_load_template(row)
            if load_template.id is None:
                continue
            session.add(load_template)

        session.flush()

        for row in records:
            load_id = normalize_int(row.get("ID"))
            if load_id is None:
                continue

            for depends_on_load_id in parse_dependency_ids(row.get("Dependency ID")):
                session.add(
                    LoadDependency(
                        load_id=load_id,
                        depends_on_load_id=depends_on_load_id,
                    )
                )

        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    import_dataset()
    print("Imported dataset into rigsync.db")
