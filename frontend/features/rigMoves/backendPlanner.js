import { requestScenarioPlans } from "./api.js";

export async function buildScenarioPlans(
  loads,
  routeData,
  workerCount,
  truckCount,
  truckSetup = [],
  truckSpecs = [],
  workerShiftConfig = null,
  progressOptions = {},
) {
  void workerCount;
  void truckCount;

  const onProgress = typeof progressOptions?.onProgress === "function" ? progressOptions.onProgress : null;
  const sourceInventorySnapshot = progressOptions?.sourceInventorySnapshot || null;
  onProgress?.({
    stage: "scenario",
    percent: 60,
    message: "Submitting planning scenario request",
    detail: "Building scenario schedules in the backend engine.",
    completedStages: 6,
    totalStages: 8,
  });

  const scenarios = await requestScenarioPlans({
    loads,
    routeData,
    truckSetup,
    truckSpecs,
    workerShiftConfig,
    sourceInventorySnapshot,
  });

  onProgress?.({
    stage: "scenario",
    percent: 100,
    message: "Scenario plans ready",
    detail: "Three optimized rig-move plans were generated.",
    completedStages: 8,
    totalStages: 8,
  });

  return scenarios;
}
