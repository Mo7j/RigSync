import math
from collections import defaultdict


DAY_START_MINUTES = 6 * 60
DAY_END_MINUTES = 18 * 60
OVERHEAD_SAR_PER_DAY = 5000
TIME_STEP_MINUTES = 15


def normalize_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_truck_type_key(value):
    text = normalize_text(value)
    if not text:
        return ""
    normalized = "".join(character for character in text.lower() if character.isalpha())
    if normalized in {"fb", "flatbed"} or "flatbed" in normalized:
        return "flatbed"
    if normalized in {"lb", "lowbed"} or "lowbed" in normalized or "support" in normalized:
        return "lowbed"
    if normalized in {"hh", "heavyhauler", "heavyhaul"} or "heavyhaul" in normalized:
        return "heavyhauler"
    return normalized


def normalize_truck_type_label(value):
    key = normalize_truck_type_key(value)
    if key == "flatbed":
        return "Flat-bed"
    if key == "lowbed":
        return "Low-bed"
    if key == "heavyhauler":
        return "Heavy Hauler"
    return normalize_text(value) or "Truck"


def parse_int(value, default=0):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def parse_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def overlaps(start_a, end_a, start_b, end_b):
    return start_a < end_b and start_b < end_a


def count_workers(role_counts):
    return sum(
        max(0, parse_int(count))
        for role_id, count in (role_counts or {}).items()
        if role_id != "truck_driver"
    )


def build_truck_spec_map(truck_specs, configured_trucks):
    rate_override = {
        normalize_truck_type_key(item.get("type")): max(0, parse_float(item.get("hourlyCost")))
        for item in (configured_trucks or [])
    }
    spec_map = {}
    for row in truck_specs or []:
        key = normalize_truck_type_key(row.get("type"))
        if not key:
            continue
        dimensions = row.get("dimensions") or {}
        spec_map[key] = {
            "type": normalize_truck_type_label(row.get("type")),
            "max_weight_tons": max(0, parse_float(row.get("max_weight_tons"))),
            "max_length_m": parse_float(dimensions.get("length")),
            "max_width_m": parse_float(dimensions.get("width")),
            "max_height_m": parse_float(dimensions.get("height")),
            "average_speed_kmh": max(0, parse_float(row.get("average_speed_kmh"))),
            "alpha": parse_float(row.get("alpha"), 0.3) or 0.3,
            "hourlyCost": rate_override.get(key) or max(0, parse_float(row.get("hourly_cost_sar") or row.get("hourlyCost"))),
        }
    return spec_map


def build_worker_rate_map(worker_rates):
    return {
        normalize_text(row.get("role_id") or row.get("role_name")): max(0, parse_float(row.get("hourly_rate_sar")))
        for row in (worker_rates or [])
        if normalize_text(row.get("role_id") or row.get("role_name"))
    }


def build_fleet(truck_setup, truck_spec_map):
    fleet = []
    for truck in truck_setup or []:
        truck_type = normalize_truck_type_label(truck.get("type"))
        key = normalize_truck_type_key(truck_type)
        count = max(0, parse_int(truck.get("count")))
        spec = truck_spec_map.get(key)
        if not key or not spec or count <= 0:
            continue
        for index in range(count):
            fleet.append(
                {
                    "id": f"{key}-{index + 1}",
                    "type": truck_type,
                    "key": key,
                    "spec": spec,
                }
            )
    return fleet


def get_phase_role_counts(load, phase_code, crew_mode):
    phase_suffix = "down" if phase_code == "RD" else "up"
    minimum = dict(load.get(f"minimum_crew_{phase_suffix}_roles") or {})
    optimal = dict(load.get(f"optimal_crew_{phase_suffix}_roles") or minimum)
    maximum = dict(load.get(f"maximum_crew_{phase_suffix}_roles") or optimal)

    if crew_mode == "minimum":
        return minimum
    if crew_mode == "optimal":
        return optimal
    if crew_mode == "maximum":
        return maximum

    role_ids = set([*minimum.keys(), *optimal.keys()])
    midpoint = {}
    for role_id in role_ids:
        low = max(0, parse_int(minimum.get(role_id)))
        high = max(low, parse_int(optimal.get(role_id, low)))
        midpoint[role_id] = int(math.ceil((low + high) / 2))
    return midpoint


def get_phase_duration_minutes(load, phase_code, crew_mode):
    if phase_code == "RD":
        base_minutes = max(0, parse_float(load.get("avg_rig_down_minutes") or load.get("rig_down_duration"))) or 0
        optimal_minutes = parse_float(load.get("optimal_rig_down_minutes") or load.get("optimal_avg_rig_down_minutes"), base_minutes)
    else:
        base_minutes = max(0, parse_float(load.get("avg_rig_up_minutes") or load.get("rig_up_duration"))) or 0
        optimal_minutes = parse_float(load.get("optimal_rig_up_minutes") or load.get("optimal_avg_rig_up_minutes"), base_minutes)
    if base_minutes <= 0:
        return 0

    min_roles = get_phase_role_counts(load, phase_code, "minimum")
    opt_roles = get_phase_role_counts(load, phase_code, "optimal")
    assigned_roles = get_phase_role_counts(load, phase_code, crew_mode)

    min_workers = max(1, count_workers(min_roles))
    opt_workers = max(min_workers, count_workers(opt_roles))
    max_effective_workers = max(opt_workers, count_workers(load.get(f"maximum_crew_{'down' if phase_code == 'RD' else 'up'}_roles") or {}))
    assigned_workers = max(min_workers, count_workers(assigned_roles))
    effective_workers = min(max_effective_workers or opt_workers, assigned_workers)

    if opt_workers <= min_workers or optimal_minutes <= 0:
        return max(1, int(round(base_minutes)))

    improvement_ratio = (effective_workers - min_workers) / max(1, opt_workers - min_workers)
    clamped_improvement = max(0.0, min(1.0, improvement_ratio))
    duration = base_minutes - ((base_minutes - optimal_minutes) * clamped_improvement)
    return max(1, int(round(duration)))


def get_required_truck_keys(load):
    option_fields = [
        load.get("truck_types"),
        load.get("truckTypes"),
        load.get("truck_options"),
    ]
    keys = []
    for values in option_fields:
        for item in values or []:
            key = normalize_truck_type_key(item)
            if key and key not in keys:
                keys.append(key)
    direct_type = normalize_truck_type_key(load.get("truck_type"))
    if direct_type and direct_type not in keys:
        keys.append(direct_type)
    return keys


def get_load_distance_km(load, route_data, selected_source=None):
    if selected_source and selected_source.get("distance_km") is not None:
        return max(0, parse_float(selected_source.get("distance_km")))
    for key in ("routeDistanceKm", "distanceKm", "source_distance_km_override"):
        value = load.get(key)
        if value is not None:
            return max(0, parse_float(value))
    return max(0, parse_float(route_data.get("distanceKm")))


def get_candidate_sources(load, source_options, source_inventory, source_nodes, route_data, remaining_inventory=None):
    family_id = normalize_text(load.get("family_id") or load.get("startup_family_id") or load.get("id"))
    options = source_options.get(family_id)
    results = []
    seen = set()

    live_candidates = [
        row
        for (source_id_key, family_id_key), row in (source_inventory or {}).items()
        if family_id_key == family_id
        for _ in [source_id_key]
    ]
    for row in live_candidates:
        source_id = normalize_text(row.get("source_id"))
        if not source_id or source_id in seen:
            continue
        seen.add(source_id)
        source_node = source_nodes.get(source_id) or {}
        remaining_units = max(0, parse_int((remaining_inventory or {}).get((source_id, family_id), row.get("available_units", 0))))
        reserved_units = max(0, parse_int(row.get("reserved_units")))
        distance_km = source_node.get("distance_to_destination_km")
        if distance_km is None:
            distance_km = route_data.get("defaultStartupDistanceKm") or route_data.get("distanceKm")
        results.append(
            {
                "source_id": source_id,
                "source_label": source_node.get("source_name") or source_id,
                "distance_km": max(0, parse_float(distance_km)),
                "available_units": max(0, parse_int(row.get("available_units"))),
                "remaining_units": remaining_units,
                "reserved_units": reserved_units,
                "active": bool(row.get("active", source_node.get("active", True))),
                "split_allowed": True,
                "early_pickup_allowed": False,
                "selection_mode": "LIVE_RIG_INVENTORY",
            }
        )

    preferred_source_ids = []
    if options:
        preferred_source_ids = [
            options.get("preferred_source_1"),
            options.get("preferred_source_2"),
            options.get("preferred_source_3"),
            options.get("fallback_source"),
        ]

    for source_id in preferred_source_ids:
        source_id = normalize_text(source_id)
        if not source_id or source_id in seen:
            continue
        seen.add(source_id)
        source_node = source_nodes.get(source_id) or {}
        inventory = source_inventory.get((source_id, family_id), {})
        available_units = max(0, parse_int(inventory.get("available_units")))
        reserved_units = max(0, parse_int(inventory.get("reserved_units")))
        remaining_units = max(0, parse_int((remaining_inventory or {}).get((source_id, family_id), max(0, available_units - reserved_units))))
        distance_km = source_node.get("distance_to_destination_km")
        if distance_km is None:
            distance_km = route_data.get("defaultStartupDistanceKm") or route_data.get("distanceKm")
        results.append(
            {
                "source_id": source_id,
                "source_label": source_node.get("source_name") or source_id,
                "distance_km": max(0, parse_float(distance_km)),
                "available_units": available_units,
                "remaining_units": remaining_units,
                "reserved_units": reserved_units,
                "active": bool(source_node.get("active", True)),
                "split_allowed": bool(options.get("split_allowed")) if options else False,
                "early_pickup_allowed": bool(options.get("early_pickup_allowed")) if options else False,
                "selection_mode": options.get("source_selection_mode") if options else None,
            }
        )
    return [row for row in results if row["active"] and row["remaining_units"] > 0]


def choose_startup_source(load, objective, route_data, source_options, source_inventory, source_nodes, remaining_inventory):
    candidates = get_candidate_sources(load, source_options, source_inventory, source_nodes, route_data, remaining_inventory)
    if not candidates:
        return None
    if objective == "cheapest":
        candidates.sort(key=lambda row: (row["distance_km"], -row["remaining_units"], row["source_label"]))
    elif objective == "utilized":
        candidates.sort(key=lambda row: (-row["remaining_units"], row["distance_km"], row["source_label"]))
    else:
        candidates.sort(key=lambda row: (row["distance_km"], -row["remaining_units"], row["source_label"]))
    return candidates[0]


def build_load_snapshot(loads, route_data, objective, source_options, source_inventory, source_nodes):
    snapshot = []
    remaining_inventory = {
        key: max(0, parse_int(row.get("available_units")) - parse_int(row.get("reserved_units")))
        for key, row in (source_inventory or {}).items()
    }
    for load in loads or []:
        item = dict(load)
        if normalize_text(item.get("source_kind")) == "startup" or str(item.get("scope") or "").upper() == "STARTUP":
            selected_source = choose_startup_source(item, objective, route_data, source_options, source_inventory, source_nodes, remaining_inventory)
            if selected_source:
                item["selected_source"] = selected_source
                item["sourceLabel"] = selected_source["source_label"]
                item["routeDistanceKm"] = selected_source["distance_km"]
                item["early_pickup_allowed"] = selected_source["early_pickup_allowed"]
                source_key = (selected_source["source_id"], normalize_text(item.get("family_id") or item.get("id")))
                remaining_inventory[source_key] = max(0, parse_int(remaining_inventory.get(source_key)) - 1)
        snapshot.append(item)
    return snapshot


def compute_truck_option(load, truck, route_data):
    spec = truck["spec"]
    distance_km = get_load_distance_km(load, route_data, load.get("selected_source"))
    average_speed = max(1.0, parse_float(spec.get("average_speed_kmh"), 1))
    weight_tons = max(0.0, parse_float(load.get("weight_tons") or load.get("weight_t")))
    max_weight = max(1.0, parse_float(spec.get("max_weight_tons"), 1))
    alpha = max(0.0, parse_float(spec.get("alpha"), 0.3))
    loaded_speed = max(5.0, average_speed * (1 - ((alpha * weight_tons) / max_weight)))
    loaded_minutes = max(1, int(round((distance_km / loaded_speed) * 60))) if distance_km else 1
    return_minutes = max(1, int(round((distance_km / average_speed) * 60))) if distance_km else 1
    rate = max(0.0, parse_float(spec.get("hourlyCost")))
    return {
        "truckId": truck["id"],
        "truckType": truck["type"],
        "durationMinutes": loaded_minutes,
        "returnDurationMinutes": return_minutes,
        "transportCost": ((loaded_minutes + return_minutes) / 60) * rate,
    }


def eligible_trucks(load, fleet):
    allowed = set(get_required_truck_keys(load))
    weight_tons = max(0.0, parse_float(load.get("weight_tons") or load.get("weight_t")))
    results = []
    for truck in fleet:
        if allowed and truck["key"] not in allowed:
            continue
        max_weight = max(0.0, parse_float(truck["spec"].get("max_weight_tons")))
        if max_weight and weight_tons and weight_tons > max_weight:
            continue
        results.append(truck)
    return results


def parse_phase_dependency_refs(values):
    refs = []
    for value in values or []:
        text = normalize_text(value)
        if not text:
            continue
        refs.append(text)
    return refs


def build_task_graph(loads, route_data, fleet, crew_mode, worker_rates, inputs):
    all_primary_rm_ids = []
    tasks = []
    for index, load in enumerate(loads):
        load_code = normalize_text(load.get("code") or load.get("unit_id") or load.get("id")) or f"LOAD-{index + 1}"
        source_kind = normalize_text(load.get("source_kind")) or ("startup" if str(load.get("scope") or "").upper() == "STARTUP" else "rig")
        base = {
            "loadId": normalize_text(load.get("id") or load.get("unit_id")) or load_code,
            "loadCode": load_code,
            "familyId": normalize_text(load.get("family_id")),
            "description": normalize_text(load.get("description")) or load_code,
            "priority": parse_int(load.get("priority")),
            "isCritical": bool(load.get("is_critical") or load.get("critical_lift")),
            "load": load,
            "sourceKind": source_kind,
            "order": index,
        }

        if source_kind != "startup" and get_phase_duration_minutes(load, "RD", crew_mode) > 0:
            role_counts = get_phase_role_counts(load, "RD", crew_mode)
            tasks.append(
                {
                    **base,
                    "id": f"{load_code} (RD)",
                    "phaseCode": "RD",
                    "phase": "rig_down",
                    "activityLabel": "Rig Down",
                    "durationMinutes": get_phase_duration_minutes(load, "RD", crew_mode),
                    "roleCounts": role_counts,
                    "siteWorkers": count_workers(role_counts),
                    "predecessorIds": [],
                    "candidateTruckOptions": [],
                }
            )

        candidate_options = [compute_truck_option(load, truck, route_data) for truck in eligible_trucks(load, fleet)]
        if not candidate_options:
            raise ValueError(f"No compatible truck is available for {load_code}.")
        tasks.append(
            {
                **base,
                "id": f"{load_code} (RM)",
                "phaseCode": "RM",
                "phase": "move",
                "activityLabel": "Rig Move",
                "durationMinutes": min(option["durationMinutes"] for option in candidate_options),
                "roleCounts": {},
                "siteWorkers": 0,
                "predecessorIds": [] if source_kind == "startup" else [f"{load_code} (RD)"],
                "candidateTruckOptions": candidate_options,
            }
        )

        role_counts = get_phase_role_counts(load, "RU", crew_mode)
        tasks.append(
            {
                **base,
                "id": f"{load_code} (RU)",
                "phaseCode": "RU",
                "phase": "rig_up",
                "activityLabel": "Rig Up",
                "durationMinutes": get_phase_duration_minutes(load, "RU", crew_mode),
                "roleCounts": role_counts,
                "siteWorkers": count_workers(role_counts),
                "predecessorIds": [f"{load_code} (RM)"],
                "candidateTruckOptions": [],
            }
        )

        if source_kind != "startup":
            all_primary_rm_ids.append(f"{load_code} (RM)")

    task_map = {task["id"]: task for task in tasks}
    family_ru_ids = defaultdict(list)
    family_rd_ids = defaultdict(list)
    for task in tasks:
        if task["familyId"]:
            if task["phaseCode"] == "RU":
                family_ru_ids[task["familyId"]].append(task["id"])
            if task["phaseCode"] == "RD":
                family_rd_ids[task["familyId"]].append(task["id"])

    startup_gate_policy = normalize_text(inputs.get("startup_gate_policy")) or "PRIMARY_COMPLETE_GATE"
    for task in tasks:
        load = task["load"]
        if task["phaseCode"] == "RD":
            dependency_refs = parse_phase_dependency_refs(load.get("rig_down_dependency_phase_codes"))
        elif task["phaseCode"] == "RM":
            dependency_refs = parse_phase_dependency_refs(load.get("rig_move_dependency_phase_codes"))
        else:
            dependency_refs = parse_phase_dependency_refs(load.get("rig_up_dependency_phase_codes"))

        for ref in dependency_refs:
            predecessor_id = normalize_text(ref)
            if predecessor_id and predecessor_id in task_map and predecessor_id != task["id"]:
                task["predecessorIds"].append(predecessor_id)

        if task["phaseCode"] == "RD":
            for family_id in load.get("rig_down_dependency_codes") or []:
                task["predecessorIds"].extend(family_rd_ids.get(family_id, []))
        elif task["phaseCode"] == "RU":
            for family_id in load.get("rig_up_dependency_codes") or []:
                task["predecessorIds"].extend(family_ru_ids.get(family_id, []))

        if task["sourceKind"] == "startup" and task["phaseCode"] == "RM":
            if not bool(load.get("early_pickup_allowed")) and startup_gate_policy == "PRIMARY_COMPLETE_GATE":
                task["predecessorIds"].extend(all_primary_rm_ids)

        task["predecessorIds"] = sorted(set(item for item in task["predecessorIds"] if item in task_map and item != task["id"]))
        task["laborCost"] = sum(
            max(0, parse_int(count)) * max(0, parse_float(worker_rates.get(role_id, 0))) * (task["durationMinutes"] / 60)
            for role_id, count in task["roleCounts"].items()
        )

    return tasks


def sort_ready_tasks(task, objective, successor_counts):
    critical_score = 1 if task["isCritical"] else 0
    successor_score = successor_counts.get(task["id"], 0)
    phase_rank = {"RD": 0, "RM": 1, "RU": 2}.get(task["phaseCode"], 3)
    if objective == "cheapest":
        return (task["priority"], task["laborCost"], phase_rank, task["order"], task["id"])
    if objective == "utilized":
        return (-successor_score, task["priority"], task["durationMinutes"], phase_rank, task["order"], task["id"])
    return (-critical_score, task["priority"], -successor_score, phase_rank, task["order"], task["id"])


def build_successor_counts(tasks):
    counts = defaultdict(int)
    for task in tasks:
        for predecessor_id in task["predecessorIds"]:
            counts[predecessor_id] += 1
    return counts


def get_day_window(minute, day_start, day_end):
    day_index = minute // (24 * 60)
    start = (day_index * 24 * 60) + day_start
    end = (day_index * 24 * 60) + day_end
    if minute < start:
        return start, end
    if minute >= end:
        return start + (24 * 60), end + (24 * 60)
    return start, end


def fit_to_day_window(start_minute, duration_minutes, day_start, day_end):
    candidate = max(0, start_minute)
    for _ in range(20000):
        window_start, window_end = get_day_window(candidate, day_start, day_end)
        if candidate < window_start:
            candidate = window_start
            continue
        if candidate + duration_minutes > window_end:
            candidate = window_start + (24 * 60)
            continue
        return candidate
    raise RuntimeError("Could not fit critical task into daylight window.")


def requires_day_shift(task):
    return bool(task.get("isCritical")) and task.get("phaseCode") in {"RD", "RU"}


def build_day_shift_segments(start_minute, duration_minutes, day_start, day_end):
    remaining = max(0, parse_int(duration_minutes))
    candidate = max(0, parse_int(start_minute))
    segments = []

    while remaining > 0:
        window_start, window_end = get_day_window(candidate, day_start, day_end)
        if candidate < window_start:
            candidate = window_start
            continue
        if candidate >= window_end:
            candidate = window_start + (24 * 60)
            continue

        worked_minutes = min(remaining, window_end - candidate)
        segment_end = candidate + worked_minutes
        segments.append({
            "startMinute": candidate,
            "endMinute": segment_end,
        })
        remaining -= worked_minutes
        candidate = segment_end if remaining <= 0 else window_start + (24 * 60)

    return segments, (segments[-1]["endMinute"] if segments else max(0, parse_int(start_minute)))


def interval_load(intervals, start, end, field, phase_code=None):
    total = 0
    for interval in intervals:
        if phase_code and interval.get("phaseCode") != phase_code:
            continue
        if overlaps(start, end, interval["startMinute"], interval["endMinute"]):
            total += interval.get(field, 0)
    return total


def interval_load_for_segments(intervals, segments, field, phase_code=None):
    total = 0
    for interval in intervals:
        if phase_code and interval.get("phaseCode") != phase_code:
            continue
        if any(overlaps(segment["startMinute"], segment["endMinute"], interval["startMinute"], interval["endMinute"]) for segment in segments):
            total += interval.get(field, 0)
    return total


def find_site_start(task, earliest_start, site_intervals, constraints):
    day_start = parse_int(constraints.get("criticalWindowStartHour"), 6) * 60
    day_end = parse_int(constraints.get("criticalWindowEndHour"), 18) * 60
    max_concurrent = max(1, parse_int(constraints.get("maxConcurrentActivities"), 3))
    max_concurrent_rd = max(1, parse_int(constraints.get("maxConcurrentRigDownLoads"), 3))
    max_concurrent_ru = max(1, parse_int(constraints.get("maxConcurrentRigUpLoads"), 3))
    max_rd_workers = max(1, parse_int(constraints.get("maxRigDownWorkers"), 30))
    max_ru_workers = max(1, parse_int(constraints.get("maxRigUpWorkers"), 30))

    candidate = max(0, earliest_start)
    if requires_day_shift(task):
        candidate = fit_to_day_window(candidate, min(task["durationMinutes"], day_end - day_start), day_start, day_end)

    for _ in range(40000):
        if requires_day_shift(task):
            candidate = fit_to_day_window(candidate, min(task["durationMinutes"], day_end - day_start), day_start, day_end)
            work_segments, end_minute = build_day_shift_segments(candidate, task["durationMinutes"], day_start, day_end)
        else:
            end_minute = candidate + task["durationMinutes"]
            work_segments = [{"startMinute": candidate, "endMinute": end_minute}]

        active_tasks = interval_load_for_segments(site_intervals, work_segments, "activityLoad")
        if active_tasks >= max_concurrent:
            candidate += TIME_STEP_MINUTES
            continue

        if task["phaseCode"] == "RD":
            phase_load = interval_load_for_segments(site_intervals, work_segments, "activityLoad", "RD")
            if phase_load >= max_concurrent_rd:
                candidate += TIME_STEP_MINUTES
                continue
            worker_load = interval_load_for_segments(site_intervals, work_segments, "workerLoad", "RD")
            if worker_load + task["siteWorkers"] > max_rd_workers:
                candidate += TIME_STEP_MINUTES
                continue
        elif task["phaseCode"] == "RU":
            phase_load = interval_load_for_segments(site_intervals, work_segments, "activityLoad", "RU")
            if phase_load >= max_concurrent_ru:
                candidate += TIME_STEP_MINUTES
                continue
            worker_load = interval_load_for_segments(site_intervals, work_segments, "workerLoad", "RU")
            if worker_load + task["siteWorkers"] > max_ru_workers:
                candidate += TIME_STEP_MINUTES
                continue

        return candidate, end_minute, work_segments

    raise RuntimeError(f"Could not place site task {task['id']} within resource limits.")


def choose_truck_option(task, earliest_start, truck_state, objective):
    scored = []
    for option in task["candidateTruckOptions"]:
        truck_available = truck_state[option["truckId"]]
        start = max(earliest_start, truck_available)
        end = start + option["durationMinutes"]
        if objective == "cheapest":
            score = (option["transportCost"], end, option["durationMinutes"], option["truckType"])
        elif objective == "utilized":
            score = (start, option["transportCost"], option["durationMinutes"], option["truckType"])
        else:
            score = (end, option["transportCost"], option["durationMinutes"], option["truckType"])
        scored.append((score, start, option))
    scored.sort(key=lambda item: item[0])
    _, start_minute, option = scored[0]
    return start_minute, option


def schedule_tasks(tasks, fleet, constraints, objective):
    task_map = {task["id"]: task for task in tasks}
    truck_state = {truck["id"]: 0 for truck in fleet}
    scheduled = {}
    site_intervals = []
    successor_counts = build_successor_counts(tasks)
    remaining = set(task_map.keys())

    while remaining:
        ready = [
            task_map[task_id]
            for task_id in remaining
            if all(predecessor_id in scheduled for predecessor_id in task_map[task_id]["predecessorIds"])
        ]
        if not ready:
            unresolved = sorted(remaining)
            raise RuntimeError(f"Scheduling deadlock detected. Remaining tasks: {', '.join(unresolved[:10])}")

        ready.sort(key=lambda task: sort_ready_tasks(task, objective, successor_counts))
        best_candidate = None
        for task in ready:
            earliest_start = max([scheduled[predecessor]["endMinute"] for predecessor in task["predecessorIds"]] or [0])
            if task["phaseCode"] == "RM":
                start_minute, truck_option = choose_truck_option(task, earliest_start, truck_state, objective)
                end_minute = start_minute + truck_option["durationMinutes"]
                evaluation = {
                    "task": task,
                    "startMinute": start_minute,
                    "endMinute": end_minute,
                    "truckOption": truck_option,
                    "score": (
                        truck_option["transportCost"],
                        end_minute,
                        task["priority"],
                    ) if objective == "cheapest" else (
                        end_minute,
                        truck_option["transportCost"],
                        task["priority"],
                    ),
                }
            else:
                start_minute, end_minute, work_segments = find_site_start(task, earliest_start, site_intervals, constraints)
                load_balance_score = interval_load_for_segments(site_intervals, work_segments, "workerLoad", task["phaseCode"])
                evaluation = {
                    "task": task,
                    "startMinute": start_minute,
                    "endMinute": end_minute,
                    "workSegments": work_segments,
                    "truckOption": None,
                    "score": (
                        load_balance_score,
                        end_minute,
                        task["priority"],
                    ) if objective == "utilized" else (
                        end_minute,
                        load_balance_score,
                        task["priority"],
                    ),
                }

            if best_candidate is None or evaluation["score"] < best_candidate["score"]:
                best_candidate = evaluation

        task = best_candidate["task"]
        start_minute = best_candidate["startMinute"]
        end_minute = best_candidate["endMinute"]
        truck_option = best_candidate["truckOption"]
        scheduled_task = {
            **task,
            "startMinute": start_minute,
            "endMinute": end_minute,
        }
        if truck_option:
            scheduled_task.update(
                {
                    "truckId": truck_option["truckId"],
                    "truckType": truck_option["truckType"],
                    "transportCost": truck_option["transportCost"],
                    "returnDurationMinutes": truck_option["returnDurationMinutes"],
                    "returnStartMinute": end_minute,
                    "returnEndMinute": end_minute + truck_option["returnDurationMinutes"],
                }
            )
            truck_state[truck_option["truckId"]] = scheduled_task["returnEndMinute"]
        else:
            scheduled_task["workSegments"] = best_candidate.get("workSegments") or [{
                "startMinute": start_minute,
                "endMinute": end_minute,
            }]
            for segment in scheduled_task["workSegments"]:
                site_intervals.append(
                    {
                    "taskId": task["id"],
                    "phaseCode": task["phaseCode"],
                    "startMinute": segment["startMinute"],
                    "endMinute": segment["endMinute"],
                    "activityLoad": 1,
                    "workerLoad": task["siteWorkers"],
                }
                )

        scheduled[task["id"]] = scheduled_task
        remaining.remove(task["id"])

    return [scheduled[task["id"]] for task in tasks]


def validate_scheduled_tasks(tasks, constraints, fleet):
    max_concurrent = max(1, parse_int(constraints.get("maxConcurrentActivities"), 3))
    max_concurrent_rd = max(1, parse_int(constraints.get("maxConcurrentRigDownLoads"), 3))
    max_concurrent_ru = max(1, parse_int(constraints.get("maxConcurrentRigUpLoads"), 3))
    max_rd_workers = max(1, parse_int(constraints.get("maxRigDownWorkers"), 30))
    max_ru_workers = max(1, parse_int(constraints.get("maxRigUpWorkers"), 30))
    task_map = {task["id"]: task for task in tasks}

    for task in tasks:
        for predecessor_id in task.get("predecessorIds", []):
            predecessor = task_map.get(predecessor_id)
            if predecessor and predecessor["endMinute"] > task["startMinute"]:
                raise RuntimeError(f"Precedence violation: {predecessor_id} overlaps {task['id']}.")

    timeline = []
    for task in tasks:
        work_segments = task.get("workSegments") or [{
            "startMinute": task["startMinute"],
            "endMinute": task["endMinute"],
        }]
        for index, segment in enumerate(work_segments):
            timeline.append({"minute": segment["startMinute"], "type": "start", "task": task, "segmentKey": f"{task['id']}::{index}"})
            timeline.append({"minute": segment["endMinute"], "type": "end", "task": task, "segmentKey": f"{task['id']}::{index}"})

    timeline.sort(
        key=lambda event: (
            event["minute"],
            0 if event["type"] == "end" else 1,
            event["task"]["id"],
        )
    )

    active_task_ids = set()
    active_rd_count = 0
    active_ru_count = 0
    active_rd_workers = 0
    active_ru_workers = 0

    for event in timeline:
        task = event["task"]
        segment_key = event["segmentKey"]
        if event["type"] == "end":
            active_task_ids.discard(segment_key)
            if task["phaseCode"] == "RD":
                active_rd_count = max(0, active_rd_count - 1)
                active_rd_workers = max(0, active_rd_workers - parse_int(task.get("siteWorkers")))
            elif task["phaseCode"] == "RU":
                active_ru_count = max(0, active_ru_count - 1)
                active_ru_workers = max(0, active_ru_workers - parse_int(task.get("siteWorkers")))
            continue

        active_task_ids.add(segment_key)
        if task["phaseCode"] == "RD":
            active_rd_count += 1
            active_rd_workers += parse_int(task.get("siteWorkers"))
        elif task["phaseCode"] == "RU":
            active_ru_count += 1
            active_ru_workers += parse_int(task.get("siteWorkers"))

        if len(active_task_ids) > max_concurrent:
            raise RuntimeError(f"Concurrent activity cap exceeded while scheduling {task['id']}.")
        if active_rd_count > max_concurrent_rd:
            raise RuntimeError(f"Concurrent rig-down task cap exceeded while scheduling {task['id']}.")
        if active_ru_count > max_concurrent_ru:
            raise RuntimeError(f"Concurrent rig-up task cap exceeded while scheduling {task['id']}.")
        if active_rd_workers > max_rd_workers:
            raise RuntimeError(f"Rig-down worker cap exceeded while scheduling {task['id']}.")
        if active_ru_workers > max_ru_workers:
            raise RuntimeError(f"Rig-up worker cap exceeded while scheduling {task['id']}.")

    truck_tasks = defaultdict(list)
    for task in tasks:
        if task.get("phaseCode") == "RM" and normalize_text(task.get("truckId")):
            truck_tasks[task["truckId"]].append(task)

    for truck in fleet or []:
        truck_id = truck.get("id")
        intervals = sorted(
            truck_tasks.get(truck_id, []),
            key=lambda item: (item["startMinute"], item["endMinute"], item["id"]),
        )
        for index in range(1, len(intervals)):
            previous = intervals[index - 1]
            current = intervals[index]
            if overlaps(
                previous["startMinute"],
                previous.get("returnEndMinute", previous["endMinute"]),
                current["startMinute"],
                current["endMinute"],
            ):
                raise RuntimeError(
                    f"Truck assignment conflict on {truck_id} between {previous['id']} and {current['id']}."
                )


def build_critical_path(tasks):
    task_map = {task["id"]: task for task in tasks}
    successors = defaultdict(list)
    latest_finish = max((task["endMinute"] for task in tasks), default=0)
    for task in tasks:
        for predecessor_id in task["predecessorIds"]:
            successors[predecessor_id].append(task["id"])

    longest_to_finish = {}
    for task in sorted(tasks, key=lambda item: item["endMinute"], reverse=True):
        if not successors[task["id"]]:
            longest_to_finish[task["id"]] = task["durationMinutes"]
        else:
            longest_to_finish[task["id"]] = task["durationMinutes"] + max(longest_to_finish[succ] for succ in successors[task["id"]])

    critical = []
    current_candidates = [task for task in tasks if task["endMinute"] == latest_finish]
    if not current_candidates:
        return []
    current = max(current_candidates, key=lambda task: longest_to_finish.get(task["id"], 0))
    critical.append(current["id"])
    while current["predecessorIds"]:
        predecessors = [task_map[task_id] for task_id in current["predecessorIds"]]
        current = max(predecessors, key=lambda task: longest_to_finish.get(task["id"], 0))
        critical.append(current["id"])
    critical.reverse()
    return critical


def build_resource_usage_series(tasks, fleet, total_minutes):
    if total_minutes <= 0:
        return []
    series = []
    for minute in range(0, total_minutes + TIME_STEP_MINUTES, TIME_STEP_MINUTES):
        active_tasks = [task for task in tasks if task["phaseCode"] != "RM" and overlaps(minute, minute + TIME_STEP_MINUTES, task["startMinute"], task["endMinute"])]
        active_trips = [task for task in tasks if task["phaseCode"] == "RM" and overlaps(minute, minute + TIME_STEP_MINUTES, task["startMinute"], task.get("returnEndMinute", task["endMinute"]))]
        series.append(
            {
                "minute": minute,
                "activeActivities": len(active_tasks),
                "activeTrips": len(active_trips),
                "totalWorkers": sum(task["siteWorkers"] for task in active_tasks),
            }
        )
    return series


def summarize_metrics(tasks, fleet, worker_rates, constraints):
    total_minutes = max((task["endMinute"] for task in tasks), default=0)
    transport_cost = sum(parse_float(task.get("transportCost")) for task in tasks if task["phaseCode"] == "RM")
    labor_cost = sum(parse_float(task.get("laborCost")) for task in tasks if task["phaseCode"] != "RM")
    overhead_cost = math.ceil(max(1, total_minutes) / (24 * 60)) * OVERHEAD_SAR_PER_DAY if total_minutes else 0
    truck_active_minutes = sum(
        max(0, parse_int(task.get("returnEndMinute")) - parse_int(task.get("startMinute")))
        for task in tasks
        if task["phaseCode"] == "RM"
    )
    worker_active_minutes = sum(task["siteWorkers"] * task["durationMinutes"] for task in tasks if task["phaseCode"] != "RM")
    used_truck_ids = {
        normalize_text(task.get("truckId"))
        for task in tasks
        if task["phaseCode"] == "RM" and normalize_text(task.get("truckId"))
    }
    allocated_trucks = max(1, len(fleet))
    used_trucks = len(used_truck_ids)
    truck_capacity_minutes = allocated_trucks * max(1, total_minutes)
    truck_utilization = min(100, int(round((truck_active_minutes / max(1, truck_capacity_minutes)) * 100)))
    worker_capacity_minutes = (
        max(1, parse_int(constraints.get("maxRigDownWorkers"), 30)) +
        max(1, parse_int(constraints.get("maxRigUpWorkers"), 30))
    ) * max(1, total_minutes)
    worker_utilization = min(100, int(round((worker_active_minutes / max(1, worker_capacity_minutes)) * 100)))
    utilization = truck_utilization
    return {
        "totalMinutes": total_minutes,
        "transportCost": int(round(transport_cost)),
        "laborCost": int(round(labor_cost)),
        "overheadCost": int(round(overhead_cost)),
        "costEstimate": int(round(transport_cost + labor_cost + overhead_cost)),
        "truckUtilization": truck_utilization,
        "workerUtilization": worker_utilization,
        "utilization": utilization,
        "utilizationEfficiency": utilization,
        "idleMinutes": max(0, truck_capacity_minutes - truck_active_minutes),
        "allocatedTruckCountForUtilization": allocated_trucks,
        "usedTruckCount": used_trucks,
    }


def count_used_trucks(tasks):
    counts = defaultdict(int)
    seen = set()
    for task in tasks:
        truck_id = normalize_text(task.get("truckId"))
        if not truck_id or truck_id in seen:
            continue
        seen.add(truck_id)
        counts[normalize_truck_type_label(task.get("truckType"))] += 1
    return [{"type": truck_type, "count": count} for truck_type, count in sorted(counts.items())]


def build_playback(tasks, route_data, fleet):
    task_lookup = {
        (normalize_text(task.get("loadId")), task["phaseCode"]): task
        for task in tasks
    }
    trips = []
    for task in tasks:
        if task["phaseCode"] != "RM":
            continue
        load = task["load"]
        load_id = normalize_text(task.get("loadId"))
        rig_down_task = task_lookup.get((load_id, "RD"))
        rig_up_task = task_lookup.get((load_id, "RU"))
        move_start = task["startMinute"]
        move_finish = task["endMinute"]
        rig_down_start = rig_down_task["startMinute"] if rig_down_task else move_start
        rig_down_finish = rig_down_task["endMinute"] if rig_down_task else move_start
        rig_up_start = rig_up_task["startMinute"] if rig_up_task else move_finish
        rig_up_finish = rig_up_task["endMinute"] if rig_up_task else move_finish
        route_geometry = route_data.get("geometry")
        trips.append(
            {
                "taskId": task["id"],
                "loadId": task["loadId"],
                "loadCode": task["loadCode"],
                "description": task["description"],
                "truckId": task.get("truckId"),
                "truckType": task.get("truckType"),
                "loadStart": rig_down_start,
                "dispatchStart": move_start,
                "rigDownStart": rig_down_start,
                "rigDownFinish": rig_down_finish,
                "pickupLoadStart": rig_down_start,
                "pickupLoadFinish": rig_down_finish,
                "moveStart": move_start,
                "moveFinish": move_finish,
                "arrivalAtDestination": move_finish,
                "unloadDropStart": move_finish,
                "unloadDropFinish": move_finish,
                "rigUpStart": rig_up_start,
                "rigUpFinish": rig_up_finish,
                "returnStart": task.get("returnStartMinute"),
                "returnToSource": task.get("returnEndMinute"),
                "routeDistanceKm": get_load_distance_km(load, route_data, load.get("selected_source")),
                "routeGeometry": route_geometry,
                "sourceLabel": load.get("sourceLabel") or route_data.get("startLabel") or "Source",
                "destinationLabel": route_data.get("endLabel") or "Destination",
                "sourceKind": task.get("sourceKind"),
                "isCriticalLift": bool(load.get("is_critical") or load.get("critical_lift")),
            }
        )

    critical_task_ids = build_critical_path(tasks)
    total_minutes = max((task["endMinute"] for task in tasks), default=0)
    return {
        "totalMinutes": total_minutes,
        "tasks": tasks,
        "trips": trips,
        "usedTruckSetup": count_used_trucks(tasks),
        "planningAnalysis": {
            "projectFinish": total_minutes,
            "criticalTaskIds": critical_task_ids,
            "tasks": tasks,
        },
        "resourceUsage": build_resource_usage_series(tasks, fleet, total_minutes),
    }


def build_source_reservations(loads):
    reservations = {}
    for load in loads or []:
        if normalize_text(load.get("source_kind")) != "startup" and str(load.get("scope") or "").upper() != "STARTUP":
            continue
        selected_source = load.get("selected_source")
        if not selected_source:
            continue
        family_id = normalize_text(load.get("family_id") or load.get("id"))
        source_id = normalize_text(selected_source.get("source_id"))
        if not family_id or not source_id:
            continue
        key = (source_id, family_id)
        entry = reservations.setdefault(
            key,
            {
                "sourceId": source_id,
                "sourceLabel": selected_source.get("source_label") or source_id,
                "familyId": family_id,
                "loadCode": normalize_text(load.get("code")) or family_id,
                "description": normalize_text(load.get("description")) or family_id,
                "distanceKm": parse_float(selected_source.get("distance_km")),
                "availableUnits": max(0, parse_int(selected_source.get("available_units"))),
                "reservedUnitsBefore": max(0, parse_int(selected_source.get("reserved_units"))),
                "unitsReserved": 0,
                "selectionMode": selected_source.get("selection_mode"),
            },
        )
        entry["unitsReserved"] += 1
    return sorted(reservations.values(), key=lambda item: (item["familyId"], item["sourceLabel"]))


def score_scenario(result, objective, references):
    if objective == "cheapest":
        return (result["costEstimate"], result["totalMinutes"], result["truckCount"])
    if objective == "utilized":
        fastest = references.get("fastest")
        cheapest = references.get("cheapest")
        fastest_minutes = max(1, parse_int(fastest.get("totalMinutes") if fastest else result["totalMinutes"], result["totalMinutes"]))
        cheapest_cost = max(1, parse_int(cheapest.get("costEstimate") if cheapest else result["costEstimate"], result["costEstimate"]))
        allowed_minutes = int(round(fastest_minutes * 1.15))
        allowed_cost = int(round(cheapest_cost * 1.10))
        time_penalty = max(0, result["totalMinutes"] - allowed_minutes)
        cost_penalty = max(0, result["costEstimate"] - allowed_cost)
        is_within_targets = 1 if time_penalty == 0 and cost_penalty == 0 else 0
        return (
            -is_within_targets,
            time_penalty + cost_penalty,
            -result["truckUtilization"],
            result["totalMinutes"],
            result["costEstimate"],
            result["truckCount"],
        )
    return (result["totalMinutes"], result["costEstimate"], result["truckCount"])


def serialize_count_map(count_map):
    return "|".join(f"{key}:{count}" for key, count in sorted(count_map.items()))


def enumerate_count_maps(available):
    items = [(normalize_truck_type_key(item.get("type")), max(0, parse_int(item.get("count")))) for item in (available or [])]
    items = [(key, count) for key, count in items if key and count > 0]
    combinations = []

    def visit(index, current):
        if index >= len(items):
            if any(value > 0 for value in current.values()):
                combinations.append(dict(current))
            return
        key, max_count = items[index]
        for count in range(0, max_count + 1):
            current[key] = count
            visit(index + 1, current)

    visit(0, {})
    if len(combinations) > 4096:
        combinations = sorted(combinations, key=lambda row: (sum(row.values()), serialize_count_map(row)))[:4096]
    return combinations


def build_truck_setup_from_counts(available_setup, counts):
    results = []
    for truck in available_setup or []:
        key = normalize_truck_type_key(truck.get("type"))
        count = max(0, parse_int(counts.get(key)))
        if count <= 0:
            continue
        results.append(
            {
                **truck,
                "type": normalize_truck_type_label(truck.get("type")),
                "count": count,
            }
        )
    return results


def build_single_scenario(name, objective, crew_mode, loads, route_data, truck_setup, truck_specs, worker_rates, source_options, source_inventory, source_nodes, constraints):
    truck_spec_map = build_truck_spec_map(truck_specs, truck_setup)
    worker_rate_map = build_worker_rate_map(worker_rates)
    fleet = build_fleet(truck_setup, truck_spec_map)
    if not fleet:
        raise ValueError("No trucks are available for planning.")

    snapshot_loads = build_load_snapshot(loads, route_data, objective, source_options, source_inventory, source_nodes)
    tasks = build_task_graph(snapshot_loads, route_data, fleet, crew_mode, worker_rate_map, constraints)
    scheduled_tasks = schedule_tasks(tasks, fleet, constraints, objective)
    validate_scheduled_tasks(scheduled_tasks, constraints, fleet)
    playback = build_playback(scheduled_tasks, route_data, fleet)
    metrics = summarize_metrics(scheduled_tasks, fleet, worker_rate_map, constraints)
    variant = {
        "name": name,
        "routeMinutes": parse_int(route_data.get("minutes")),
        "processingMinutes": max(0, metrics["totalMinutes"] - parse_int(route_data.get("minutes"))),
        "totalMinutes": metrics["totalMinutes"],
        "playback": playback,
    }
    return {
        "name": name,
        "objective": objective,
        "crewMode": crew_mode,
        "workerCount": max((task["siteWorkers"] for task in scheduled_tasks if task["phaseCode"] != "RM"), default=0),
        "workerShifts": {
            "dayShift": max((task["siteWorkers"] for task in scheduled_tasks if task["phaseCode"] != "RM"), default=0),
            "nightShift": 0,
        },
        "truckCount": len(fleet),
        "allocatedTruckCount": len(fleet),
        "capacity": len(fleet),
        "routeMinutes": parse_int(route_data.get("minutes")),
        "routeDistanceKm": parse_float(route_data.get("distanceKm")),
        "routeSource": route_data.get("source") or "runtime",
        "routeGeometry": route_data.get("geometry"),
        "truckSetup": truck_setup,
        "allocatedTruckSetup": truck_setup,
        "usedTruckSetup": playback["usedTruckSetup"],
        "requestedTruckCount": len(fleet),
        "requestedTruckSetup": truck_setup,
        "variantPlans": [variant],
        "bestVariant": variant,
        "totalMinutes": metrics["totalMinutes"],
        "processingMinutes": max(0, metrics["totalMinutes"] - parse_int(route_data.get("minutes"))),
        "playback": playback,
        "planningAnalysis": playback["planningAnalysis"],
        "waves": [],
        "sourceReservations": build_source_reservations(snapshot_loads),
        **metrics,
        "network": {
            "nodes": [
                {
                    "id": task["id"],
                    "label": f"{task['loadCode']} {task['phaseCode']}",
                    "phaseCode": task["phaseCode"],
                    "startMinute": task["startMinute"],
                    "endMinute": task["endMinute"],
                }
                for task in scheduled_tasks
            ],
            "edges": [
                {
                    "from": predecessor_id,
                    "to": task["id"],
                }
                for task in scheduled_tasks
                for predecessor_id in task["predecessorIds"]
            ],
        },
    }


def optimize_scenario(name, objective, crew_mode, loads, route_data, available_truck_setup, truck_specs, worker_rates, source_options, source_inventory, source_nodes, constraints, references):
    results = []
    errors = []
    for count_map in enumerate_count_maps(available_truck_setup):
        candidate_setup = build_truck_setup_from_counts(available_truck_setup, count_map)
        if not candidate_setup:
            continue
        try:
            results.append(
                build_single_scenario(
                    name,
                    objective,
                    crew_mode,
                    loads,
                    route_data,
                    candidate_setup,
                    truck_specs,
                    worker_rates,
                    source_options,
                    source_inventory,
                    source_nodes,
                    constraints,
                )
            )
        except Exception as error:
            errors.append(f"{serialize_count_map(count_map)} -> {error}")

    if not results:
        sample_error = errors[0] if errors else "No feasible scenario."
        raise RuntimeError(f"Could not build a feasible {name} plan. {sample_error}")

    results.sort(key=lambda result: score_scenario(result, objective, references))
    return results[0]


def build_scenario_plans(
    loads,
    route_data,
    truck_setup,
    truck_specs,
    worker_rates,
    source_options,
    source_inventory,
    source_nodes,
    inputs,
    worker_shift_config=None,
):
    constraints = {
        "maxConcurrentActivities": worker_shift_config.get("maxConcurrentActivities") if worker_shift_config else inputs.get("max_concurrent_site_activities", 3),
        "maxConcurrentRigDownLoads": worker_shift_config.get("maxConcurrentRigDownLoads") if worker_shift_config else inputs.get("max_concurrent_rig_down_loads", 3),
        "maxConcurrentRigUpLoads": worker_shift_config.get("maxConcurrentRigUpLoads") if worker_shift_config else inputs.get("max_concurrent_rig_up_loads", 3),
        "maxRigDownWorkers": worker_shift_config.get("maxRigDownWorkers") if worker_shift_config else inputs.get("max_rd_workers", 30),
        "maxRigUpWorkers": worker_shift_config.get("maxRigUpWorkers") if worker_shift_config else inputs.get("max_ru_workers", 30),
        "criticalWindowStartHour": inputs.get("critical_window_start_hour", 6),
        "criticalWindowEndHour": inputs.get("critical_window_end_hour", 18),
        "startup_gate_policy": inputs.get("startup_gate_policy", "PRIMARY_COMPLETE_GATE"),
    }
    normalized_route = {
        "distanceKm": parse_float(route_data.get("distanceKm")),
        "minutes": parse_int(route_data.get("minutes")),
        "source": route_data.get("source") or "runtime",
        "geometry": route_data.get("geometry"),
        "startLabel": route_data.get("startLabel"),
        "endLabel": route_data.get("endLabel"),
        "defaultStartupDistanceKm": parse_float(inputs.get("default_startup_distance_km"), parse_float(route_data.get("distanceKm"))),
    }
    normalized_trucks = [
        {
            **truck,
            "type": normalize_truck_type_label(truck.get("type")),
            "count": max(0, parse_int(truck.get("count"))),
            "hourlyCost": max(0, parse_float(truck.get("hourlyCost"))),
        }
        for truck in (truck_setup or [])
        if max(0, parse_int(truck.get("count"))) > 0
    ]
    if not normalized_trucks:
        raise ValueError("At least one truck type with positive availability is required.")

    scenario_defs = [
        ("Fastest", "fastest", "optimal"),
        ("Cheapest", "cheapest", "minimum"),
        ("Utilized", "utilized", "midpoint"),
    ]

    references = {}
    scenarios = []
    for name, objective, crew_mode in scenario_defs:
        scenario = optimize_scenario(
            name,
            objective,
            crew_mode,
            loads,
            normalized_route,
            normalized_trucks,
            truck_specs,
            worker_rates,
            source_options,
            source_inventory,
            source_nodes,
            constraints,
            references,
        )
        references[objective] = scenario
        scenarios.append(scenario)

    baseline_setup = [
        {
            **truck,
            "count": max(1, int(math.ceil(parse_int(truck["count"]) * 1.2))),
        }
        for truck in normalized_trucks
    ]
    baseline = build_single_scenario(
        "Manual Baseline",
        "baseline",
        "optimal",
        loads,
        normalized_route,
        baseline_setup,
        truck_specs,
        worker_rates,
        source_options,
        source_inventory,
        source_nodes,
        constraints,
    )
    for scenario in scenarios:
        scenario["manualBaseline"] = {
            "truckSetup": baseline_setup,
            "costEstimate": baseline["costEstimate"],
            "totalMinutes": baseline["totalMinutes"],
        }
        baseline_cost = max(1, baseline["costEstimate"])
        scenario["savingsVsBaselinePercent"] = round(((baseline["costEstimate"] - scenario["costEstimate"]) / baseline_cost) * 100, 1)
    return scenarios
