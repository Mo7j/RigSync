from sqlalchemy import text

from database import Base, SessionLocal, engine
from models import (
    LoadAllowedTruckType,
    LoadDependency,
    LoadRoleRequirement,
    LoadTemplate,
    ManagerResourceState,
    MoveRecord,
    RigInventoryState,
    TruckSpec,
)
from planning_dataset import DATASET_PATH, load_planning_dataset


def _dimension_value(dimensions, key):
    return float((dimensions or {}).get(key) or 0)


def _build_load_template_payload(row, source_kind):
    return {
        "source_kind": source_kind,
        "code": row["code"],
        "load_type": row.get("load_type"),
        "description": row.get("description"),
        "category": row.get("category"),
        "load_count": row.get("load_count") or row.get("count") or 1,
        "weight_tons": row.get("weight_tons"),
        "weight_text": row.get("weight_text"),
        "length_m": _dimension_value(row.get("dimensions"), "length") or None,
        "width_m": _dimension_value(row.get("dimensions"), "width") or None,
        "height_m": _dimension_value(row.get("dimensions"), "height") or None,
        "dimensions_text": row.get("dimensions_text"),
        "priority": row.get("priority") or 0,
        "avg_rig_down_minutes": row.get("avg_rig_down_minutes"),
        "avg_rig_up_minutes": row.get("avg_rig_up_minutes"),
        "optimal_rig_down_minutes": row.get("optimal_rig_down_minutes"),
        "optimal_rig_up_minutes": row.get("optimal_rig_up_minutes"),
        "is_critical": bool(row.get("is_critical")),
        "minimum_crew_down_count": row.get("minimum_crew_down_count") or 0,
        "minimum_crew_up_count": row.get("minimum_crew_up_count") or 0,
        "optimal_crew_down_count": row.get("optimal_crew_down_count") or 0,
        "optimal_crew_up_count": row.get("optimal_crew_up_count") or 0,
        "dependency_label": row.get("dependencyLabel"),
        "is_reusable": bool(row.get("isReusable")),
    }


def _validate_fit(load_template, compatible_types, truck_specs_by_type):
    for truck_type in compatible_types:
        truck_spec = truck_specs_by_type.get(truck_type)
        if not truck_spec:
            continue

        fits_weight = (
            load_template.weight_tons is None
            or load_template.weight_tons <= truck_spec.max_weight_tons
        )
        fits_length = (
            load_template.length_m is None
            or load_template.length_m <= truck_spec.max_length_m
        )
        fits_width = (
            load_template.width_m is None
            or load_template.width_m <= truck_spec.max_width_m
        )
        fits_height = (
            load_template.height_m is None
            or load_template.height_m <= truck_spec.max_height_m
        )

        if fits_weight and fits_length and fits_width and fits_height:
            return True

    return False


def import_dataset():
    if not DATASET_PATH.exists():
        raise FileNotFoundError(f"Dataset not found: {DATASET_PATH}")

    dataset = load_planning_dataset()
    with engine.begin() as connection:
        for table_name in [
            "load_dependencies",
            "load_allowed_truck_types",
            "load_role_requirements",
            "load_templates",
            "truck_specs",
            "rig_loads",
            "startup_loads",
        ]:
            connection.execute(text(f"DROP TABLE IF EXISTS {table_name} CASCADE"))
    Base.metadata.create_all(bind=engine)

    session = SessionLocal()
    try:
        for row in dataset["truck_specs"]:
            session.add(
                TruckSpec(
                    type=row["type"],
                    max_weight_tons=row.get("max_weight_tons") or 0,
                    max_length_m=_dimension_value(row.get("dimensions"), "length"),
                    max_width_m=_dimension_value(row.get("dimensions"), "width"),
                    max_height_m=_dimension_value(row.get("dimensions"), "height"),
                    average_speed_kmh=row.get("average_speed_kmh") or 0,
                    alpha=row.get("alpha") or 0.3,
                )
            )

        session.flush()

        truck_specs_by_type = {
            truck_spec.type: truck_spec
            for truck_spec in session.query(TruckSpec).all()
        }

        all_rows = [
            *[("rig", row) for row in dataset["rig_loads"]],
            *[("startup", row) for row in dataset["startup_loads"]],
        ]

        templates_by_code = {}

        for source_kind, row in all_rows:
            template = LoadTemplate(**_build_load_template_payload(row, source_kind))
            session.add(template)
            session.flush()
            templates_by_code[template.code] = template

            compatible_types = row.get("truck_types") or row.get("truckTypes") or []
            for truck_type in compatible_types:
                if truck_type not in truck_specs_by_type:
                    continue
                session.add(
                    LoadAllowedTruckType(
                        load_template_id=template.id,
                        truck_type=truck_type,
                    )
                )

            role_requirement_sets = [
                ("rig_down", "minimum", row.get("minimum_crew_down_roles") or {}),
                ("rig_up", "minimum", row.get("minimum_crew_up_roles") or {}),
                ("rig_down", "optimal", row.get("optimal_crew_down_roles") or {}),
                ("rig_up", "optimal", row.get("optimal_crew_up_roles") or {}),
            ]
            for phase, requirement_kind, role_requirements in role_requirement_sets:
                for role_id, required_count in (role_requirements or {}).items():
                    session.add(
                        LoadRoleRequirement(
                            load_template_id=template.id,
                            phase=phase,
                            role_id=role_id,
                            requirement_kind=requirement_kind,
                            required_count=max(0, int(required_count or 0)),
                        )
                    )

        session.flush()

        for source_kind, row in all_rows:
            template = templates_by_code[row["code"]]

            if source_kind == "rig":
                dependency_sets = [
                    ("rig_down", row.get("rig_down_dependency_codes") or []),
                    ("rig_up", row.get("rig_up_dependency_codes") or []),
                ]
            else:
                dependency_sets = [("rig_up", row.get("rig_up_dependency_codes") or [])]

            for dependency_phase, dependency_codes in dependency_sets:
                for dependency_code in dependency_codes:
                    depends_on = templates_by_code.get(dependency_code)
                    if not depends_on or depends_on.id == template.id:
                        continue
                    session.add(
                        LoadDependency(
                            load_template_id=template.id,
                            depends_on_load_template_id=depends_on.id,
                            dependency_phase=dependency_phase,
                        )
                    )

        session.flush()

        invalid_codes = []
        for template in templates_by_code.values():
            compatible_types = [row.truck_type for row in template.allowed_truck_types]
            if compatible_types and not _validate_fit(template, compatible_types, truck_specs_by_type):
                invalid_codes.append(template.code)

        if invalid_codes:
            raise ValueError(
                "The dataset contains infeasible load/truck mappings: "
                + ", ".join(sorted(invalid_codes))
            )

        session.commit()
        return {
            "load_templates": len(templates_by_code),
            "truck_specs": len(truck_specs_by_type),
            "source": str(DATASET_PATH),
        }
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    result = import_dataset()
    print(
        f"Imported {result['load_templates']} load templates and "
        f"{result['truck_specs']} truck specs from {result['source']}"
    )
