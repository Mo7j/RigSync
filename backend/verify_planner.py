from app import get_active_dataset
from import_dataset import import_dataset
from planning_engine import build_scenario_plans


def main():
    import_result = import_dataset()
    dataset = get_active_dataset()

    sample_loads = dataset["rig_loads"][:8] + dataset["startup_loads"][:2]
    sample_truck_setup = [
        {"type": "Flat-bed", "count": 4, "hourlyCost": 150},
        {"type": "Low-bed", "count": 4, "hourlyCost": 220},
        {"type": "Heavy Hauler", "count": 3, "hourlyCost": 320},
    ]
    route_data = {
        "distanceKm": 20,
        "minutes": 30,
        "startLabel": "Current Rig",
        "endLabel": "Destination",
    }
    source_options = {
        row["startup_family_id"]: row
        for row in dataset["startup_source_options"]
    }
    source_inventory = {
        (row["source_id"], row["family_id"]): row
        for row in dataset["source_inventory"]
    }
    source_nodes = {
        row["source_id"]: row
        for row in dataset["source_nodes"]
    }
    scenarios = build_scenario_plans(
        loads=sample_loads,
        route_data=route_data,
        truck_setup=sample_truck_setup,
        truck_specs=dataset["truck_specs"],
        worker_rates=dataset["worker_rates"],
        source_options=source_options,
        source_inventory=source_inventory,
        source_nodes=source_nodes,
        inputs=dataset["inputs"],
    )

    print("Import source:", import_result["source"])
    print("Rig loads:", len(dataset["rig_loads"]))
    print("Startup loads:", len(dataset["startup_loads"]))
    print("Truck specs:", len(dataset["truck_specs"]))
    print("Scenario summaries:")
    for scenario in scenarios:
        print(
            f"- {scenario['name']}: "
            f"time={scenario['totalMinutes']} min, "
            f"cost={scenario['costEstimate']} SAR, "
            f"mix={scenario['usedTruckSetup']}"
        )


if __name__ == "__main__":
    main()
