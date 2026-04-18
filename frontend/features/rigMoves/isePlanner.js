const SHIFT_MINUTES = 12 * 60;
const OVERHEAD_SAR_PER_DAY = 5000;
const MAX_CONCURRENT_ACTIVITIES = 3;
const MAX_RIG_DOWN_WORKERS = 30;
const MAX_RIG_UP_WORKERS = 30;
const SCHEDULER_TIME_STEP_MINUTES = 15;
const UTILIZED_LOOKAHEAD_STEPS = 48;
const UTILIZATION_BUCKET_MINUTES = 60;

const DEFAULT_TRUCK_SPECS = [
  {
    type: "Flat-bed",
    max_weight_tons: 25,
    average_speed_kmh: 50,
    alpha: 0.35,
    hourlyCost: 150,
  },
  {
    type: "Low-bed",
    max_weight_tons: 40,
    average_speed_kmh: 40,
    alpha: 0.3,
    hourlyCost: 220,
  },
  {
    type: "Heavy Hauler",
    max_weight_tons: 60,
    average_speed_kmh: 30,
    alpha: 0.425,
    hourlyCost: 320,
  },
];

const PHASE_DEPENDENCY_PATTERN = /^((?:RL|CL|SU)-\d+(?:-L\d+)?)\s*\((RD|RM|RU)\)$/i;

const WORKER_ROLE_RATES = {
  driller: 70,
  bop_tech: 60,
  assistant_driller: 55,
  forklift_crane_operator: 50,
  derrickman: 55,
  operator: 50,
  floorman: 50,
  camp_foreman: 48,
  crane_operator: 60,
  yard_foreman: 48,
  rigger: 45,
  roustabout: 38,
  mechanic: 50,
  truck_driver: 40,
  welder: 48,
  electrician: 50,
  pumpman_mechanic: 50,
};

function normalizeTruckTypeKey(type) {
  const normalized = String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (normalized === "fb" || normalized.includes("flatbed")) {
    return "flatbed";
  }
  if (normalized === "lb" || normalized.includes("lowbed") || normalized.includes("support")) {
    return "lowbed";
  }
  if (normalized === "hh" || normalized.includes("heavyhaul")) {
    return "heavyhauler";
  }

  return normalized;
}

function normalizeTruckTypeLabel(type) {
  const normalized = normalizeTruckTypeKey(type);

  if (normalized === "flatbed") {
    return "Flat-bed";
  }
  if (normalized === "lowbed" || normalized === "support") {
    return "Low-bed";
  }
  if (normalized === "heavyhauler") {
    return "Heavy Hauler";
  }

  return String(type || "").trim() || "Flat-bed";
}

function buildTruckSpecMap(truckSpecs = [], configuredTruckSetup = []) {
  const configuredRates = new Map(
    (configuredTruckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck.type),
      Math.max(0, Number(truck.hourlyCost) || 0),
    ]),
  );
  const allSpecs = [...DEFAULT_TRUCK_SPECS, ...(truckSpecs || [])];
  const map = new Map();

  allSpecs.forEach((spec) => {
    const key = normalizeTruckTypeKey(spec.type);
    if (!key) {
      return;
    }

    const existing = map.get(key) || {};
    map.set(key, {
      ...existing,
      ...spec,
      type: normalizeTruckTypeLabel(spec.type),
      max_weight_tons: Number(spec.max_weight_tons) || existing.max_weight_tons || 0,
      average_speed_kmh: Number(spec.average_speed_kmh) || existing.average_speed_kmh || 0,
      alpha: Number(spec.alpha) || existing.alpha || 0.3,
      hourlyCost:
        configuredRates.get(key) ||
        Math.max(0, Number(spec.hourlyCost) || 0) ||
        existing.hourlyCost ||
        0,
    });
  });

  return map;
}

function buildFleet(truckSetup = [], truckSpecMap) {
  const fleet = [];

  (truckSetup || []).forEach((truck) => {
    const type = normalizeTruckTypeLabel(truck.type);
    const key = normalizeTruckTypeKey(type);
    const count = Math.max(0, Number.parseInt(truck.count, 10) || 0);
    const spec = truckSpecMap.get(key);

    for (let index = 0; index < count; index += 1) {
      fleet.push({
        id: `${key}-${index + 1}`,
        type,
        spec,
      });
    }
  });

  return fleet;
}

function getLoadUnitCode(load) {
  const code = String(load?.code || load?.loadCode || load?.id || "").trim();
  if (!code) {
    return `LOAD-${load?.id ?? "X"}`;
  }
  if (/-L\d+$/i.test(code)) {
    return code;
  }

  const key = String(load?.key || "");
  const match = key.match(/::(\d+)$/);
  if (match) {
    return `${code}-L${Number.parseInt(match[1], 10) + 1}`;
  }

  return code;
}

function parsePhaseDependencyRef(value) {
  const text = String(value || "").trim();
  const match = text.match(PHASE_DEPENDENCY_PATTERN);
  if (!match) {
    return null;
  }

  return {
    code: match[1].toUpperCase(),
    phaseCode: match[2].toUpperCase(),
  };
}

function getScenarioRoleCounts(load, phaseKey, crewMode) {
  const minimumRoles = { ...(load?.minimum_crew_roles?.[phaseKey] || {}) };
  const optimalRoles = { ...(load?.optimal_crew_roles?.[phaseKey] || {}) };

  if (crewMode === "minimum") {
    return minimumRoles;
  }
  if (crewMode === "optimal") {
    return Object.keys(optimalRoles).length ? optimalRoles : minimumRoles;
  }

  const roleIds = new Set([...Object.keys(minimumRoles), ...Object.keys(optimalRoles)]);
  const midpoint = {};
  roleIds.forEach((roleId) => {
    const minimum = Math.max(0, Number.parseInt(minimumRoles[roleId], 10) || 0);
    const optimal = Math.max(minimum, Number.parseInt(optimalRoles[roleId], 10) || minimum);
    midpoint[roleId] = Math.ceil((minimum + optimal) / 2);
  });

  return midpoint;
}

function countSiteWorkers(roleCounts = {}) {
  return Object.entries(roleCounts).reduce((sum, [roleId, count]) => {
    if (roleId === "truck_driver") {
      return sum;
    }
    return sum + Math.max(0, Number.parseInt(count, 10) || 0);
  }, 0);
}

function getPhaseBaseDurationMinutes(load, phaseCode) {
  if (phaseCode === "RD") {
    return Math.max(1, Number(load?.rig_down_duration) || Number(load?.avg_rig_down_minutes) || 0);
  }
  if (phaseCode === "RU") {
    return Math.max(1, Number(load?.rig_up_duration) || Number(load?.avg_rig_up_minutes) || 0);
  }

  return 0;
}

function getPhaseDurationMinutes(load, phaseCode, crewMode) {
  const phaseKey = phaseCode === "RD" ? "rig_down" : "rig_up";
  const baseDuration = getPhaseBaseDurationMinutes(load, phaseCode);
  if (!baseDuration) {
    return 0;
  }

  const minimumRoles = getScenarioRoleCounts(load, phaseKey, "minimum");
  const assignedRoles = getScenarioRoleCounts(load, phaseKey, crewMode);
  const minimumWorkers = Math.max(1, countSiteWorkers(minimumRoles) || Number(load?.min_worker_count) || 1);
  const assignedWorkers = Math.max(minimumWorkers, countSiteWorkers(assignedRoles) || minimumWorkers);
  const productivityExponent = crewMode === "optimal" ? 0.2 : crewMode === "midpoint" ? 0.45 : 1;
  const lowerBound = crewMode === "optimal" ? 0.78 : crewMode === "midpoint" ? 0.88 : 1;
  const durationRatio = Math.pow(minimumWorkers / Math.max(assignedWorkers, 1), productivityExponent);
  const adjusted = baseDuration * Math.max(lowerBound, durationRatio);

  return Math.max(1, Math.round(adjusted));
}

function getShiftWindow(shiftType, minute, startClockMinutes = 360) {
  const safeMinute = Math.max(0, Math.floor(minute || 0));
  const cycleIndex = Math.floor(safeMinute / 1440);

  for (let offset = -1; offset <= 2; offset += 1) {
    const cycleStart = (cycleIndex + offset) * 1440;
    const windowStart = cycleStart + startClockMinutes + (shiftType === "night" ? 720 : 0);
    const windowEnd = windowStart + 720;

    if (safeMinute >= windowStart && safeMinute < windowEnd) {
      return { start: windowStart, end: windowEnd };
    }

    if (safeMinute < windowStart) {
      return { start: windowStart, end: windowEnd };
    }
  }

  const fallbackStart = cycleIndex * 1440 + startClockMinutes + (shiftType === "night" ? 720 : 0);
  return {
    start: fallbackStart,
    end: fallbackStart + 720,
  };
}

function fitMinuteToDayShift(minute, durationMinutes, startClockMinutes = 360) {
  let candidate = Math.max(0, Math.round(minute || 0));
  let guard = 0;

  while (guard < 10000) {
    guard += 1;
    const dayWindow = getShiftWindow("day", candidate, startClockMinutes);
    if (candidate < dayWindow.start) {
      candidate = dayWindow.start;
      continue;
    }
    if ((candidate + durationMinutes) > dayWindow.end) {
      candidate = getShiftWindow("day", dayWindow.end + 1, startClockMinutes).start;
      continue;
    }
    return candidate;
  }

  throw new Error("Could not fit transport into the day shift window.");
}

function getTaskLaborCost(task) {
  if (task.phaseCode === "RM") {
    return 0;
  }

  return Object.entries(task.roleCounts || {}).reduce((sum, [roleId, count]) => {
    const rate = WORKER_ROLE_RATES[roleId] || 0;
    return sum + (Math.max(0, Number.parseInt(count, 10) || 0) * rate * (task.durationMinutes / 60));
  }, 0);
}

function computeRmDurationMinutes(load, truckSpec, fallbackDistanceKm) {
  const distanceKm = Math.max(
    0,
    Number(load?.routeDistanceKm) ||
      Number(load?.distanceKm) ||
      Number(fallbackDistanceKm) ||
      0,
  );
  if (!distanceKm) {
    return Math.max(1, Number(load?.routeMinutes) || 1);
  }

  const averageSpeed = Math.max(1, Number(truckSpec?.average_speed_kmh) || 1);
  const alpha = Math.max(0, Number(truckSpec?.alpha) || 0.3);
  const maxWeight = Math.max(1, Number(truckSpec?.max_weight_tons) || 1);
  const loadWeight = Math.max(0, Number(load?.weight_tons) || 0);
  const loadedSpeed = Math.max(5, averageSpeed * (1 - (alpha * loadWeight) / maxWeight));

  return Math.max(1, Math.round((distanceKm / loadedSpeed) * 60));
}

function getLoadRequiredTruckTypeKeys(load) {
  const directType = String(load?.truck_type || "").trim();
  const normalizedDirectType = normalizeTruckTypeKey(directType);
  const optionTypes = (load?.truck_options || load?.truckTypes || load?.truck_types || [])
    .map((type) => normalizeTruckTypeKey(type))
    .filter(Boolean);

  if (normalizedDirectType && !/[\/,|]/.test(directType)) {
    return [normalizedDirectType];
  }

  if (optionTypes.length) {
    return [...new Set(optionTypes)];
  }

  return normalizedDirectType ? [normalizedDirectType] : [];
}

function getEligibleTruckIds(load, fleet) {
  const allowed = new Set(getLoadRequiredTruckTypeKeys(load));

  return fleet
    .filter((truck) => !allowed.size || allowed.has(normalizeTruckTypeKey(truck.type)))
    .filter((truck) => {
      const maxWeight = Number(truck.spec?.max_weight_tons) || 0;
      const loadWeight = Math.max(0, Number(load?.weight_tons) || 0);
      return !maxWeight || !loadWeight || loadWeight <= maxWeight;
    })
    .map((truck) => truck.id);
}

function buildTaskGraph(loads, routeData, fleet, truckSpecMap, crewMode) {
  const allPrimaryTaskIds = [];
  const loadUnitCodeById = new Map();

  loads.forEach((load) => {
    loadUnitCodeById.set(load.id, getLoadUnitCode(load));
  });

  const preliminary = loads.map((load, order) => {
    const sourceKind = load?.source_kind || "rig";
    const loadCode = getLoadUnitCode(load);
    const base = {
      load,
      loadId: load.id,
      loadCode,
      description: load.description || loadCode,
      sourceKind,
      priority: Number.parseInt(load.priority, 10) || 0,
      isCritical: Boolean(load.is_critical),
      order,
    };

    const tasks = [];
    if (sourceKind !== "startup") {
      const roleCounts = getScenarioRoleCounts(load, "rig_down", crewMode);
      tasks.push({
        ...base,
        id: `${loadCode} (RD)`,
        phaseCode: "RD",
        phase: "rig_down",
        activityLabel: "Rig Down",
        durationMinutes: getPhaseDurationMinutes(load, "RD", crewMode),
        roleCounts,
        siteWorkers: countSiteWorkers(roleCounts),
        allowedShiftTypes: Boolean(load.is_critical) ? ["day"] : null,
        eligibleTruckIds: [],
        predecessorIds: [],
      });
    }

    const eligibleTruckIds = getEligibleTruckIds(load, fleet);
    tasks.push({
      ...base,
      id: `${loadCode} (RM)`,
      phaseCode: "RM",
      phase: "move",
      activityLabel: "Rig Moving",
      durationMinutes: 0,
      roleCounts: {},
      siteWorkers: 0,
      allowedShiftTypes: ["day"],
      eligibleTruckIds,
      predecessorIds: sourceKind === "startup" ? [] : [`${loadCode} (RD)`],
    });

    const rigUpRoleCounts = getScenarioRoleCounts(load, "rig_up", crewMode);
    tasks.push({
      ...base,
      id: `${loadCode} (RU)`,
      phaseCode: "RU",
      phase: "rig_up",
      activityLabel: "Rig Up",
      durationMinutes: getPhaseDurationMinutes(load, "RU", crewMode),
      roleCounts: rigUpRoleCounts,
      siteWorkers: countSiteWorkers(rigUpRoleCounts),
      allowedShiftTypes: Boolean(load.is_critical) ? ["day"] : null,
      eligibleTruckIds: [],
      predecessorIds: [`${loadCode} (RM)`],
    });

    return tasks;
  }).flat();

  preliminary.forEach((task) => {
    if (task.sourceKind !== "startup") {
      allPrimaryTaskIds.push(task.id);
    }
  });

  preliminary.forEach((task) => {
    const load = task.load;
    const phaseDependencyRefs = task.phaseCode === "RU"
      ? (load?.rig_up_dependency_phase_codes || [])
      : task.phaseCode === "RM"
        ? (load?.rig_move_dependency_phase_codes || [])
        : (load?.rig_down_dependency_phase_codes || []);
    const dependencyIds = phaseDependencyRefs.length
      ? []
      : task.phaseCode === "RU"
        ? (load?.rig_up_dependency_ids || [])
        : task.phaseCode === "RM"
          ? (load?.rig_move_dependency_ids || [])
          : (load?.rig_down_dependency_ids || load?.dependency_ids || []);

    phaseDependencyRefs.forEach((dependencyRef) => {
      const parsed = parsePhaseDependencyRef(dependencyRef);
      if (!parsed || parsed.code === loadUnitCodeById.get(load.id)) {
        return;
      }
      task.predecessorIds.push(`${parsed.code} (${parsed.phaseCode})`);
    });

    dependencyIds.forEach((dependencyId) => {
      const dependencyLoadCode = loadUnitCodeById.get(dependencyId);
      if (!dependencyLoadCode) {
        return;
      }

      const predecessorPhase = task.phaseCode === "RU" ? "RU" : task.phaseCode === "RM" ? "RM" : "RD";
      task.predecessorIds.push(`${dependencyLoadCode} (${predecessorPhase})`);
    });

    if (task.sourceKind === "startup" && task.phaseCode === "RM") {
      task.predecessorIds.push(...allPrimaryTaskIds);
    }

    task.predecessorIds = [...new Set(task.predecessorIds)];
  });

  preliminary.forEach((task) => {
    if (task.phaseCode !== "RM") {
      return;
    }

    const candidateTrucks = task.eligibleTruckIds.map((truckId) => fleet.find((truck) => truck.id === truckId)).filter(Boolean);
    if (!candidateTrucks.length) {
      const requiredTypes = getLoadRequiredTruckTypeKeys(task.load)
        .map((type) => normalizeTruckTypeLabel(type))
        .join(" / ");
      const availableTypes = [...new Set((fleet || []).map((truck) => truck.type).filter(Boolean))].join(" / ");
      throw new Error(
        `No compatible truck is available for ${task.loadCode}. Required: ${requiredTypes || "Any compatible type in dataset"}. Available in candidate fleet: ${availableTypes || "None"}.`,
      );
    }

    task.truckOptions = candidateTrucks.map((truck) => ({
      truckId: truck.id,
      truckType: truck.type,
      hourlyCost: Math.max(0, Number(truck.spec?.hourlyCost) || 0),
      averageSpeedKmh: Math.max(0, Number(truck.spec?.average_speed_kmh) || 0),
      durationMinutes: computeRmDurationMinutes(task.load, truck.spec, routeData?.distanceKm),
      returnDurationMinutes: computeRmDurationMinutes(task.load, truck.spec, routeData?.distanceKm),
    }));
    task.durationMinutes = Math.min(...task.truckOptions.map((option) => option.durationMinutes));
  });

  return preliminary;
}

function sortReadyTasks(left, right) {
  return (
    (left.priority - right.priority) ||
    (Number(right.isCritical) - Number(left.isCritical)) ||
    (left.phaseCode === "RD" ? -1 : left.phaseCode === "RM" ? 0 : 1) - (right.phaseCode === "RD" ? -1 : right.phaseCode === "RM" ? 0 : 1) ||
    (left.order - right.order) ||
    left.id.localeCompare(right.id)
  );
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function intervalLoad(intervals, startMinute, endMinute, filter = null, field = "load") {
  return intervals.reduce((sum, interval) => {
    if (filter && !filter(interval)) {
      return sum;
    }
    return sum + (overlaps(startMinute, endMinute, interval.startMinute, interval.endMinute) ? interval[field] : 0);
  }, 0);
}

function getIntervalsOverlapping(intervals, startMinute, endMinute, filter = null) {
  return intervals.filter((interval) => (!filter || filter(interval)) && overlaps(startMinute, endMinute, interval.startMinute, interval.endMinute));
}

function collectBlockingTaskIds(intervals = []) {
  return [...new Set(
    intervals
      .flatMap((interval) => interval.taskIds || (interval.taskId ? [interval.taskId] : []))
      .filter(Boolean),
  )];
}

function scoreUtilizedCandidate(task, startMinute, endMinute, scheduledIntervals, constraints) {
  const maxConcurrentActivities = Math.max(1, Number(constraints?.maxConcurrentActivities) || MAX_CONCURRENT_ACTIVITIES);
  const workerCap = task.phaseCode === "RD"
    ? Math.max(1, Number(constraints?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS)
    : task.phaseCode === "RU"
      ? Math.max(1, Number(constraints?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS)
      : 0;
  const bucketStart = Math.floor(startMinute / UTILIZATION_BUCKET_MINUTES) * UTILIZATION_BUCKET_MINUTES;
  const bucketEnd = Math.max(endMinute, bucketStart + UTILIZATION_BUCKET_MINUTES);
  let peakActivities = 0;
  let peakWorkers = 0;
  let sampledActivities = 0;
  let sampledWorkers = 0;
  let samples = 0;

  for (let minute = bucketStart; minute < bucketEnd; minute += SCHEDULER_TIME_STEP_MINUTES) {
    const sampleEnd = minute + SCHEDULER_TIME_STEP_MINUTES;
    const activeIntervals = getIntervalsOverlapping(scheduledIntervals, minute, sampleEnd);
    const activityLoad = activeIntervals.reduce((sum, interval) => sum + (interval.activityLoad || 0), 0);
    const workerLoad = task.phaseCode === "RM"
      ? 0
      : activeIntervals
        .filter((interval) => interval.phaseCode === task.phaseCode)
        .reduce((sum, interval) => sum + (interval.load || 0), 0);
    const candidateActive = overlaps(startMinute, endMinute, minute, sampleEnd) ? 1 : 0;
    const candidateWorkers = candidateActive && task.phaseCode !== "RM" ? task.siteWorkers : 0;
    const totalActivities = activityLoad + candidateActive;
    const totalWorkers = workerLoad + candidateWorkers;

    peakActivities = Math.max(peakActivities, totalActivities);
    peakWorkers = Math.max(peakWorkers, totalWorkers);
    sampledActivities += totalActivities;
    sampledWorkers += totalWorkers;
    samples += 1;
  }

  const avgActivities = sampledActivities / Math.max(samples, 1);
  const avgWorkers = sampledWorkers / Math.max(samples, 1);
  const activityPenalty = (peakActivities / maxConcurrentActivities) * 1000;
  const workerPenalty = workerCap > 0 ? (peakWorkers / workerCap) * 1000 : 0;
  const smoothingPenalty = ((peakActivities - avgActivities) * 220) + ((peakWorkers - avgWorkers) * 80);

  return activityPenalty + workerPenalty + smoothingPenalty + (startMinute * 0.01);
}

function findEarliestStartWithConstraints(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints, options = {}) {
  let minute = Math.max(0, Math.round(earliestStartMinute));
  let guard = 0;
  const rawMaxConcurrentActivities = Number(constraints?.maxConcurrentActivities);
  const maxConcurrentActivities = Number.isFinite(rawMaxConcurrentActivities) && rawMaxConcurrentActivities > 0
    ? Math.max(1, Math.round(rawMaxConcurrentActivities))
    : null;
  const maxRigDownWorkers = Math.max(1, Number(constraints?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS);
  const maxRigUpWorkers = Math.max(1, Number(constraints?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS);
  const startClockMinutes =
    ((Number.parseInt(constraints?.startHour, 10) || 6) * 60) +
    (Number.parseInt(constraints?.startMinute, 10) || 0);
  const objective = options?.objective || "fastest";
  const candidateStarts = [];
  let lastBlockingTaskIds = [];

  while (guard < 200000) {
    guard += 1;
    if (task.allowedShiftTypes?.length === 1 && task.allowedShiftTypes[0] === "day") {
      const fittedMinute = fitMinuteToDayShift(minute, task.durationMinutes, startClockMinutes);
      if (fittedMinute !== minute) {
        minute = fittedMinute;
        continue;
      }
    }

    const endMinute = minute + task.durationMinutes;
    if (maxConcurrentActivities != null) {
      const activeIntervals = getIntervalsOverlapping(scheduledIntervals, minute, endMinute);
      const activeCount = activeIntervals.reduce((sum, interval) => sum + (interval.activityLoad || 0), 0);
      if (activeCount >= maxConcurrentActivities) {
        lastBlockingTaskIds = collectBlockingTaskIds(activeIntervals);
        minute += SCHEDULER_TIME_STEP_MINUTES;
        continue;
      }
    }

    if (task.phaseCode === "RD") {
      const blockingIntervals = getIntervalsOverlapping(
        scheduledIntervals,
        minute,
        endMinute,
        (interval) => interval.phaseCode === "RD",
      );
      const rdWorkers = blockingIntervals.reduce((sum, interval) => sum + (interval.load || 0), 0);
      if (rdWorkers + task.siteWorkers > maxRigDownWorkers) {
        lastBlockingTaskIds = collectBlockingTaskIds(blockingIntervals);
        minute += SCHEDULER_TIME_STEP_MINUTES;
        continue;
      }
    }

    if (task.phaseCode === "RU") {
      const blockingIntervals = getIntervalsOverlapping(
        scheduledIntervals,
        minute,
        endMinute,
        (interval) => interval.phaseCode === "RU",
      );
      const ruWorkers = blockingIntervals.reduce((sum, interval) => sum + (interval.load || 0), 0);
      if (ruWorkers + task.siteWorkers > maxRigUpWorkers) {
        lastBlockingTaskIds = collectBlockingTaskIds(blockingIntervals);
        minute += SCHEDULER_TIME_STEP_MINUTES;
        continue;
      }
    }

    if (task.phaseCode === "RM" && task.assignedTruckId) {
      const truckId = task.assignedTruckId;
      const blockingIntervals = (truckSchedules.get(truckId) || []).filter((interval) =>
        overlaps(minute, endMinute, interval.startMinute, interval.endMinute),
      );
      if (blockingIntervals.length) {
        lastBlockingTaskIds = collectBlockingTaskIds(blockingIntervals);
        minute += SCHEDULER_TIME_STEP_MINUTES;
        continue;
      }
    }

    const blockingTaskIds = [...new Set(lastBlockingTaskIds.filter((taskId) => !task.predecessorIds.includes(taskId)))];
    if (objective === "utilized") {
      candidateStarts.push({
        startMinute: minute,
        blockingTaskIds,
        score: scoreUtilizedCandidate(task, minute, endMinute, scheduledIntervals, constraints),
      });
      if (candidateStarts.length >= UTILIZED_LOOKAHEAD_STEPS) {
        break;
      }
      minute += SCHEDULER_TIME_STEP_MINUTES;
      continue;
    }

    return {
      startMinute: minute,
      blockingTaskIds,
    };
  }

  if (objective === "utilized" && candidateStarts.length) {
    candidateStarts.sort((left, right) =>
      (left.score - right.score) ||
      (left.startMinute - right.startMinute),
    );
    return {
      startMinute: candidateStarts[0].startMinute,
      blockingTaskIds: candidateStarts[0].blockingTaskIds,
    };
  }

  throw new Error(`Could not find a feasible start time for ${task.id}.`);
}

function chooseTruckAssignment(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints, objective = "fastest") {
  const truckOptions = task.truckOptions || [];
  if (!truckOptions.length) {
    throw new Error(`No truck options are available for ${task.id}.`);
  }
  const startClockMinutes =
    ((Number.parseInt(constraints?.startHour, 10) || 6) * 60) +
    (Number.parseInt(constraints?.startMinute, 10) || 0);

  const rankedAssignments = truckOptions.map((option) => {
    const candidateTask = {
      ...task,
      assignedTruckId: option.truckId,
      assignedTruckType: option.truckType,
      durationMinutes: option.durationMinutes,
    };
    const startCandidate = findEarliestStartWithConstraints(
      candidateTask,
      earliestStartMinute,
      scheduledIntervals,
      truckSchedules,
      constraints,
      { objective },
    );
    const startMinute = startCandidate.startMinute;
    const transportStartMinute = task.allowedShiftTypes?.includes("day")
      ? fitMinuteToDayShift(startMinute, option.durationMinutes, startClockMinutes)
      : startMinute;
    const transportEndMinute = transportStartMinute + option.durationMinutes;
    const releaseMinute = task.allowedShiftTypes?.includes("day")
      ? fitMinuteToDayShift(transportEndMinute, option.returnDurationMinutes || 0, startClockMinutes) + (option.returnDurationMinutes || 0)
      : transportEndMinute + (option.returnDurationMinutes || 0);
    return {
      ...option,
      startMinute: transportStartMinute,
      endMinute: transportEndMinute,
      releaseMinute,
      blockingTaskIds: startCandidate.blockingTaskIds || [],
    };
  });

  rankedAssignments.sort((left, right) => {
    if (objective === "cheapest") {
      return (
        (left.hourlyCost - right.hourlyCost) ||
        (left.endMinute - right.endMinute) ||
        (right.averageSpeedKmh - left.averageSpeedKmh) ||
        left.truckId.localeCompare(right.truckId)
      );
    }

    if (objective === "utilized") {
      return (
        (left.startMinute - right.startMinute) ||
        (left.endMinute - right.endMinute) ||
        (left.hourlyCost - right.hourlyCost) ||
        left.truckId.localeCompare(right.truckId)
      );
    }

    return (
      (left.endMinute - right.endMinute) ||
      (left.startMinute - right.startMinute) ||
      (left.hourlyCost - right.hourlyCost) ||
      left.truckId.localeCompare(right.truckId)
    );
  });

  return rankedAssignments[0];
}

function scheduleTasks(taskGraph, fleet, constraints = null, objective = "fastest") {
  const taskById = new Map(taskGraph.map((task) => [task.id, task]));
  const indegree = new Map(taskGraph.map((task) => [task.id, task.predecessorIds.length]));
  const dependents = new Map(taskGraph.map((task) => [task.id, []]));
  const scheduled = new Map();
  const scheduledIntervals = [];
  const truckSchedules = new Map(fleet.map((truck) => [truck.id, []]));
  const ready = taskGraph.filter((task) => task.predecessorIds.length === 0).sort(sortReadyTasks);

  taskGraph.forEach((task) => {
    task.predecessorIds.forEach((predecessorId) => {
      if (!dependents.has(predecessorId)) {
        dependents.set(predecessorId, []);
      }
      dependents.get(predecessorId).push(task.id);
    });
  });

  while (ready.length) {
    ready.sort(sortReadyTasks);
    const task = ready.shift();
    const earliestStartMinute = Math.max(
      0,
      ...task.predecessorIds.map((predecessorId) => scheduled.get(predecessorId)?.endMinute || 0),
    );
    let scheduledTask;

    if (task.phaseCode === "RM") {
      const assignment = chooseTruckAssignment(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints, objective);
      scheduledTask = {
        ...task,
        assignedTruckId: assignment.truckId,
        assignedTruckType: assignment.truckType,
        durationMinutes: assignment.durationMinutes,
        returnDurationMinutes: assignment.returnDurationMinutes || 0,
        truckReleaseMinute: assignment.releaseMinute || assignment.endMinute,
        startMinute: assignment.startMinute,
        endMinute: assignment.endMinute,
        resourceBlockingTaskIds: [...new Set((assignment.blockingTaskIds || []).filter((taskId) => !task.predecessorIds.includes(taskId)))],
      };
    } else {
      const startCandidate = findEarliestStartWithConstraints(
        task,
        earliestStartMinute,
        scheduledIntervals,
        truckSchedules,
        constraints,
        { objective },
      );
      const startMinute = startCandidate.startMinute;
      const endMinute = startMinute + task.durationMinutes;
      scheduledTask = {
        ...task,
        startMinute,
        endMinute,
        resourceBlockingTaskIds: [...new Set((startCandidate.blockingTaskIds || []).filter((taskId) => !task.predecessorIds.includes(taskId)))],
      };
    }

    scheduled.set(task.id, scheduledTask);
    scheduledIntervals.push({
      taskId: scheduledTask.id,
      taskIds: [scheduledTask.id],
      startMinute: scheduledTask.startMinute,
      endMinute: scheduledTask.endMinute,
      load: task.phaseCode === "RM" ? 1 : task.siteWorkers,
      phaseCode: task.phaseCode,
      activityLoad: 1,
    });

    if (task.phaseCode === "RM") {
      // RM tasks receive their truck assignment during scheduling, so use the
      // resolved scheduled task id when reserving the truck timeline.
      const intervals = truckSchedules.get(scheduledTask.assignedTruckId) || [];
      intervals.push({
        taskId: scheduledTask.id,
        taskIds: [scheduledTask.id],
        startMinute: scheduledTask.startMinute,
        endMinute: scheduledTask.truckReleaseMinute || scheduledTask.endMinute,
      });
      truckSchedules.set(scheduledTask.assignedTruckId, intervals);
    }

    (dependents.get(task.id) || []).forEach((dependentId) => {
      const nextDegree = (indegree.get(dependentId) || 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        const dependentTask = taskById.get(dependentId);
        if (dependentTask) {
          ready.push(dependentTask);
        }
      }
    });
  }

  if (scheduled.size !== taskGraph.length) {
    throw new Error("The activity graph could not be fully scheduled.");
  }

  return [...scheduled.values()].sort((left, right) =>
    left.startMinute - right.startMinute || left.endMinute - right.endMinute || sortReadyTasks(left, right),
  );
}

function buildPlanningAnalysis(tasks) {
  const topo = [...tasks].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute || left.id.localeCompare(right.id));
  const augmentedPredecessors = new Map(
    topo.map((task) => [
      task.id,
      [...new Set([...(task.predecessorIds || []), ...(task.resourceBlockingTaskIds || [])])],
    ]),
  );
  const dependents = new Map(topo.map((task) => [task.id, []]));

  topo.forEach((task) => {
    (augmentedPredecessors.get(task.id) || []).forEach((predecessorId) => {
      if (!dependents.has(predecessorId)) {
        dependents.set(predecessorId, []);
      }
      dependents.get(predecessorId).push(task.id);
    });
  });

  const projectFinish = Math.max(...topo.map((task) => task.endMinute || 0), 0);
  const latest = new Map();
  [...topo].reverse().forEach((task) => {
    const taskDependents = dependents.get(task.id) || [];
    const latestFinish = taskDependents.length
      ? Math.min(...taskDependents.map((dependentId) => latest.get(dependentId)?.start ?? projectFinish))
      : projectFinish;
    latest.set(task.id, {
      finish: latestFinish,
      start: latestFinish - task.durationMinutes,
    });
  });

  const enrichedTasks = topo.map((task) => {
    const latestWindow = latest.get(task.id);
    const slack = Math.max(0, (latestWindow?.start ?? task.startMinute) - task.startMinute);
    return {
      ...task,
      resourceBlockingTaskIds: [...(task.resourceBlockingTaskIds || [])],
      criticalPredecessorIds: augmentedPredecessors.get(task.id) || [],
      earliestStart: task.startMinute,
      earliestFinish: task.endMinute,
      latestStart: latestWindow?.start ?? task.startMinute,
      latestFinish: latestWindow?.finish ?? task.endMinute,
      slack,
      isCritical: slack === 0,
    };
  });

  return {
    tasks: enrichedTasks,
    projectFinish,
    criticalTaskIds: enrichedTasks.filter((task) => task.isCritical).map((task) => task.id),
  };
}

function buildResourceUsageSeries(tasks = [], fleet = [], totalMinutes = 0, constraints = {}) {
  const horizon = Math.max(totalMinutes, ...tasks.map((task) => task.endMinute || 0), 0);
  const bucketCount = Math.max(1, Math.ceil(horizon / UTILIZATION_BUCKET_MINUTES));
  const truckCapacity = Math.max(1, fleet.length || 1);
  const crewCapacity = Math.max(
    1,
    Number(constraints?.maxRigDownWorkers) || 0,
    Number(constraints?.maxRigUpWorkers) || 0,
    MAX_RIG_DOWN_WORKERS,
    MAX_RIG_UP_WORKERS,
  );
  const series = [];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const startMinute = bucketIndex * UTILIZATION_BUCKET_MINUTES;
    const endMinute = startMinute + UTILIZATION_BUCKET_MINUTES;
    const activeTasks = tasks.filter((task) => overlaps(startMinute, endMinute, task.startMinute, task.endMinute));
    const activeTrucks = new Set(activeTasks.filter((task) => task.phaseCode === "RM").map((task) => task.assignedTruckId).filter(Boolean));
    const rdWorkers = activeTasks
      .filter((task) => task.phaseCode === "RD")
      .reduce((sum, task) => sum + (task.siteWorkers || 0), 0);
    const ruWorkers = activeTasks
      .filter((task) => task.phaseCode === "RU")
      .reduce((sum, task) => sum + (task.siteWorkers || 0), 0);
    const totalWorkers = rdWorkers + ruWorkers;

    series.push({
      startMinute,
      endMinute,
      activeActivities: activeTasks.length,
      activeTrucks: activeTrucks.size,
      rdWorkers,
      ruWorkers,
      totalWorkers,
      truckUtilizationPercent: Math.round((activeTrucks.size / truckCapacity) * 100),
      crewUtilizationPercent: Math.round((totalWorkers / crewCapacity) * 100),
    });
  }

  return series;
}

function validateScheduledTasks(tasks, constraints, fleet) {
  const maxConcurrentActivities = Number(constraints?.maxConcurrentActivities) || MAX_CONCURRENT_ACTIVITIES;
  const maxRigDownWorkers = Number(constraints?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS;
  const maxRigUpWorkers = Number(constraints?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS;
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  tasks.forEach((task) => {
    (task.predecessorIds || []).forEach((predecessorId) => {
      const predecessor = taskById.get(predecessorId);
      if (predecessor && predecessor.endMinute > task.startMinute) {
        throw new Error(`Precedence violation: ${predecessor.id} overlaps successor ${task.id}.`);
      }
    });
  });

  tasks.forEach((task) => {
    const overlappingTasks = tasks.filter((otherTask) =>
      overlaps(task.startMinute, task.endMinute, otherTask.startMinute, otherTask.endMinute));
    const concurrentActivities = overlappingTasks.length;
    const rdWorkers = overlappingTasks
      .filter((otherTask) => otherTask.phaseCode === "RD")
      .reduce((sum, otherTask) => sum + (otherTask.siteWorkers || 0), 0);
    const ruWorkers = overlappingTasks
      .filter((otherTask) => otherTask.phaseCode === "RU")
      .reduce((sum, otherTask) => sum + (otherTask.siteWorkers || 0), 0);

    if (concurrentActivities > maxConcurrentActivities) {
      throw new Error(`Concurrent activity cap exceeded while scheduling ${task.id}.`);
    }
    if (rdWorkers > maxRigDownWorkers) {
      throw new Error(`Rig-down worker cap exceeded while scheduling ${task.id}.`);
    }
    if (ruWorkers > maxRigUpWorkers) {
      throw new Error(`Rig-up worker cap exceeded while scheduling ${task.id}.`);
    }
  });

  (fleet || []).forEach((truck) => {
    const truckTasks = tasks
      .filter((task) => task.phaseCode === "RM" && task.assignedTruckId === truck.id)
      .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);

    for (let index = 1; index < truckTasks.length; index += 1) {
      const previous = truckTasks[index - 1];
      const current = truckTasks[index];
      if (overlaps(previous.startMinute, previous.truckReleaseMinute || previous.endMinute, current.startMinute, current.endMinute)) {
        throw new Error(`Truck assignment conflict on ${truck.id} between ${previous.id} and ${current.id}.`);
      }
    }
  });
}

function buildPlayback(loads, scheduledTasks, planningAnalysis, routeData, fleet, truckSpecMap) {
  const taskById = new Map(planningAnalysis.tasks.map((task) => [task.id, task]));
  const loadsById = new Map(loads.map((load) => [load.id, load]));
  const trips = [];
  const journeys = [];
  const steps = [];

  loads.forEach((load) => {
    const loadCode = getLoadUnitCode(load);
    const rigDownTask = taskById.get(`${loadCode} (RD)`) || null;
    const moveTask = taskById.get(`${loadCode} (RM)`) || null;
    const rigUpTask = taskById.get(`${loadCode} (RU)`) || null;
    if (!moveTask || !rigUpTask) {
      return;
    }

    const truckId = moveTask.assignedTruckId;
    const truck = fleet.find((item) => item.id === truckId) || null;
    const truckType = truck?.type || moveTask.assignedTruckType || normalizeTruckTypeLabel(load.truck_type);
    const routeMinutes = moveTask.durationMinutes;
    const routeDistanceKm = Math.max(0, Number(load?.routeDistanceKm) || Number(routeData?.distanceKm) || 0);
    const geometry = load?.routeGeometry?.length ? load.routeGeometry : routeData?.geometry || [];
    const trip = {
      truckId,
      truckType,
      journeyId: `${loadCode}-journey`,
      loadId: load.id,
      loadCode,
      description: load.description || loadCode,
      sourceLabel: load?.sourceLabel || (load?.source_kind === "startup" ? "Warehouse / Idle Rig" : "Rig A"),
      destinationLabel: load?.destinationLabel || "Rig B",
      dispatchStart: moveTask.startMinute,
      pickupRouteMinutes: null,
      pickupRouteGeometry: [],
      routeMinutes,
      routeDistanceKm,
      routeGeometry: geometry,
      moveStart: moveTask.startMinute,
      loadStart: rigDownTask?.startMinute ?? moveTask.startMinute,
      rigDownStart: rigDownTask?.startMinute ?? null,
      rigDownFinish: rigDownTask?.endMinute ?? moveTask.startMinute,
      pickupLoadStart: moveTask.startMinute,
      pickupLoadFinish: moveTask.startMinute,
      arrivalAtDestination: moveTask.endMinute,
      unloadDropStart: moveTask.endMinute,
      unloadDropFinish: moveTask.endMinute,
      rigUpStart: rigUpTask.startMinute,
      rigUpFinish: rigUpTask.endMinute,
      returnStart: moveTask.endMinute,
      returnToSource: moveTask.truckReleaseMinute ?? moveTask.endMinute,
      rigDownWorkerCount: rigDownTask?.siteWorkers || 0,
      pickupLoadWorkerCount: 0,
      unloadDropWorkerCount: 0,
      rigUpWorkerCount: rigUpTask.siteWorkers || 0,
    };

    trips.push(trip);
    journeys.push({
      id: trip.journeyId,
      truckId,
      truckType,
      loadIds: [load.id],
      loadCodes: [loadCode],
      description: trip.description,
      dispatchStart: trip.dispatchStart,
      moveStart: trip.moveStart,
      arrivalAtDestination: trip.arrivalAtDestination,
      returnStart: trip.returnStart,
      returnToSource: trip.returnToSource,
      routeMinutes,
      routeDistanceKm,
      routeGeometry: geometry,
    });

    if (rigDownTask) {
      steps.push({
        type: "rig-down-start",
        minute: rigDownTask.startMinute,
        title: `${loadCode} rig down starts`,
        description: `${trip.description} begins rig down at Rig A.`,
      });
    }
    steps.push({
      type: "move-start",
      minute: moveTask.startMinute,
      title: `${truckType} departs with ${loadCode}`,
      description: `${trip.description} begins rig moving.`,
    });
    steps.push({
      type: "rig-up-start",
      minute: rigUpTask.startMinute,
      title: `${loadCode} rig up starts`,
      description: `${trip.description} begins rig up at Rig B.`,
    });
  });

  const usedTruckSetup = [...new Map(
    trips.map((trip) => [trip.truckId, trip.truckType])
  ).values()].reduce((result, truckType) => {
    const existing = result.find((item) => item.type === truckType);
    if (existing) {
      existing.count += 1;
    } else {
      result.push({
        id: normalizeTruckTypeKey(truckType),
        type: truckType,
        count: 1,
        hourlyCost: truckSpecMap.get(normalizeTruckTypeKey(truckType))?.hourlyCost || 0,
      });
    }
    return result;
  }, []);

  return {
    totalMinutes: Math.max(...planningAnalysis.tasks.map((task) => task.endMinute), 0),
    trips: trips.sort((left, right) => left.moveStart - right.moveStart || left.loadCode.localeCompare(right.loadCode)),
    journeys: journeys.sort((left, right) => left.moveStart - right.moveStart || left.id.localeCompare(right.id)),
    steps: steps.sort((left, right) => left.minute - right.minute || left.title.localeCompare(right.title)),
    tasks: planningAnalysis.tasks.map((task) => ({
      id: task.id,
      loadId: task.loadId,
      loadCode: task.loadCode,
      description: task.description,
      phase: task.phase,
      phaseCode: task.phaseCode,
      activityCode: task.phaseCode,
      activityLabel: task.activityLabel,
      sourceKind: task.sourceKind,
      predecessorIds: [...task.predecessorIds],
      startMinute: task.startMinute,
      endMinute: task.endMinute,
      truckReleaseMinute: task.truckReleaseMinute,
      earliestStart: task.earliestStart,
      earliestFinish: task.earliestFinish,
      latestStart: task.latestStart,
      latestFinish: task.latestFinish,
      durationMinutes: task.durationMinutes,
      roleCounts: task.roleCounts,
      siteWorkers: task.siteWorkers,
      slack: task.slack,
      isCritical: task.isCritical,
      resourceBlockingTaskIds: [...(task.resourceBlockingTaskIds || [])],
      criticalPredecessorIds: [...(task.criticalPredecessorIds || task.predecessorIds || [])],
      assignedTruckId: task.assignedTruckId || null,
      assignedTruckType: task.assignedTruckType || null,
    })),
    planningAnalysis: {
      projectFinish: planningAnalysis.projectFinish,
      criticalTaskIds: [...planningAnalysis.criticalTaskIds],
    },
    usedTruckSetup,
    workerAssignments: [],
    resourceUsage: [],
  };
}

function summarizePlaybackMetrics(playback, scenarioName, truckSpecMap) {
  return summarizePlaybackMetricsWithConstraints(playback, scenarioName, truckSpecMap, {
    maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
  });
}

function buildPeakRoleCapacity(tasks = []) {
  const eventsByRole = new Map();
  const workerEvents = [];

  (tasks || []).forEach((task) => {
    if (task?.phaseCode === "RM") {
      return;
    }

    let totalWorkersForTask = 0;
    Object.entries(task?.roleCounts || {}).forEach(([roleId, count]) => {
      if (roleId === "truck_driver") {
        return;
      }

      const workerCount = Math.max(0, Number.parseInt(count, 10) || 0);
      if (!workerCount) {
        return;
      }

      totalWorkersForTask += workerCount;
      const events = eventsByRole.get(roleId) || [];
      events.push({ minute: Math.max(0, Number(task?.startMinute) || 0), change: workerCount });
      events.push({ minute: Math.max(0, Number(task?.endMinute) || 0), change: -workerCount });
      eventsByRole.set(roleId, events);
    });

    if (totalWorkersForTask > 0) {
      workerEvents.push({ minute: Math.max(0, Number(task?.startMinute) || 0), change: totalWorkersForTask });
      workerEvents.push({ minute: Math.max(0, Number(task?.endMinute) || 0), change: -totalWorkersForTask });
    }
  });

  const peakByRole = new Map();

  eventsByRole.forEach((events, roleId) => {
    let current = 0;
    let peak = 0;
    events
      .sort((left, right) => left.minute - right.minute || left.change - right.change)
      .forEach((event) => {
        current += event.change;
        peak = Math.max(peak, current);
      });
    peakByRole.set(roleId, peak);
  });

  let concurrentWorkers = 0;
  let totalPeakWorkers = 0;
  workerEvents
    .sort((left, right) => left.minute - right.minute || left.change - right.change)
    .forEach((event) => {
      concurrentWorkers += event.change;
      totalPeakWorkers = Math.max(totalPeakWorkers, concurrentWorkers);
    });

  return {
    peakByRole,
    totalPeakWorkers: Math.max(1, totalPeakWorkers),
  };
}

function summarizePlaybackMetricsWithConstraints(playback, scenarioName, truckSpecMap, constraints, fleet = []) {
  const totalMinutes = Math.max(1, playback.totalMinutes || 1);
  const truckActiveMinutes = (playback.trips || []).reduce(
    (sum, trip) => sum + Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || 0)),
    0,
  );
  const workerActiveMinutes = (playback.tasks || []).reduce(
    (sum, task) =>
      sum +
      Object.entries(task?.roleCounts || {}).reduce((roleSum, [roleId, count]) => {
        if (roleId === "truck_driver") {
          return roleSum;
        }
        return roleSum + (Math.max(0, Number.parseInt(count, 10) || 0) * Math.max(0, Number(task?.durationMinutes) || 0));
      }, 0),
    0,
  );
  const truckCost = (playback.trips || []).reduce((sum, trip) => {
    const rate = truckSpecMap.get(normalizeTruckTypeKey(trip.truckType))?.hourlyCost || 0;
    return sum + ((Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || 0)) / 60) * rate);
  }, 0);
  const laborCost = (playback.tasks || []).reduce((sum, task) => sum + getTaskLaborCost(task), 0);
  const overheadCost = Math.ceil(totalMinutes / (24 * 60)) * OVERHEAD_SAR_PER_DAY;
  const allocatedTruckCount = Math.max(1, fleet.length || new Set((playback.trips || []).map((trip) => trip.truckId).filter(Boolean)).size || 1);
  const truckCapacityMinutes = allocatedTruckCount * totalMinutes;
  const roleCapacity = buildPeakRoleCapacity(playback.tasks || []);
  const workerCapacityMinutes = Math.max(
    1,
    ((Number(constraints?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS) + (Number(constraints?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS)) * totalMinutes,
  );
  const resourceUsageSeries = playback.resourceUsage || [];
  const activitySamples = resourceUsageSeries.map((sample) => sample.activeActivities);
  const workerSamples = resourceUsageSeries.map((sample) => sample.totalWorkers);
  const meanActivity = activitySamples.length ? activitySamples.reduce((sum, value) => sum + value, 0) / activitySamples.length : 0;
  const meanWorkers = workerSamples.length ? workerSamples.reduce((sum, value) => sum + value, 0) / workerSamples.length : 0;
  const activityVariance = activitySamples.length
    ? activitySamples.reduce((sum, value) => sum + ((value - meanActivity) ** 2), 0) / activitySamples.length
    : 0;
  const workerVariance = workerSamples.length
    ? workerSamples.reduce((sum, value) => sum + ((value - meanWorkers) ** 2), 0) / workerSamples.length
    : 0;
  const utilizationEfficiency = Math.max(0, Math.round(100 - (Math.sqrt(activityVariance) * 10) - (Math.sqrt(workerVariance) * 2.5)));
  const truckUtilization = Math.min(100, Math.round((truckActiveMinutes / Math.max(1, truckCapacityMinutes)) * 100));
  const workerUtilization = Math.min(100, Math.round((workerActiveMinutes / workerCapacityMinutes) * 100));

  return {
    scenarioName,
    truckUtilization,
    workerUtilization,
    utilization: Math.min(100, Math.round(((truckUtilization + workerUtilization + utilizationEfficiency) / 3))),
    utilizationEfficiency,
    idleMinutes: Math.max(0, truckCapacityMinutes - truckActiveMinutes),
    workerIdleMinutes: Math.max(0, workerCapacityMinutes - workerActiveMinutes),
    costEstimate: Math.round(truckCost + laborCost + overheadCost),
    laborCost: Math.round(laborCost),
    transportCost: Math.round(truckCost),
    overheadCost: Math.round(overheadCost),
    allocatedTruckCount,
    requiredCrewCount: Math.max(1, roleCapacity.totalPeakWorkers || 0),
  };
}

function buildTruckSetupFromCountMap(baseTruckSetup = [], countMap = new Map()) {
  return (baseTruckSetup || [])
    .map((truck) => {
      const type = normalizeTruckTypeLabel(truck.type);
      const key = normalizeTruckTypeKey(type);
      return {
        ...truck,
        type,
        count: Math.max(0, Number(countMap.get(key)) || 0),
      };
    })
    .filter((truck) => truck.count > 0);
}

function getCompatibleTruckTypeKeysForLoad(load, availableTruckSetup, truckSpecMap) {
  const allowed = new Set(getLoadRequiredTruckTypeKeys(load));
  const loadWeight = Math.max(0, Number(load?.weight_tons) || 0);

  return (availableTruckSetup || [])
    .map((truck) => normalizeTruckTypeKey(truck?.type))
    .filter(Boolean)
    .filter((key, index, values) => values.indexOf(key) === index)
    .filter((key) => !allowed.size || allowed.has(key))
    .filter((key) => {
      const spec = truckSpecMap.get(key);
      const maxWeight = Number(spec?.max_weight_tons) || 0;
      return !maxWeight || !loadWeight || loadWeight <= maxWeight;
    });
}

function buildInitialFleetSeed(loads, availableTruckSetup, truckSpecMap, objective = "fastest") {
  const availableByType = new Map(
    (availableTruckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck.type),
      Math.max(0, Number.parseInt(truck.count, 10) || 0),
    ]),
  );
  const seed = new Map([...availableByType.keys()].map((key) => [key, 0]));
  const uncoveredLoads = new Set((loads || []).map((load) => load.id));
  const compatibility = new Map(
    (loads || []).map((load) => [load.id, getCompatibleTruckTypeKeysForLoad(load, availableTruckSetup, truckSpecMap)]),
  );

  while (uncoveredLoads.size) {
    let bestType = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    availableByType.forEach((maxCount, typeKey) => {
      if ((seed.get(typeKey) || 0) >= maxCount) {
        return;
      }

      let covered = 0;
      let weightedCoverage = 0;
      uncoveredLoads.forEach((loadId) => {
        const load = (loads || []).find((item) => item.id === loadId);
        const compatible = compatibility.get(loadId) || [];
        if (!compatible.includes(typeKey)) {
          return;
        }
        covered += 1;
        const spec = truckSpecMap.get(typeKey);
        const speed = Math.max(1, Number(spec?.average_speed_kmh) || 1);
        const cost = Math.max(1, Number(spec?.hourlyCost) || 1);
        weightedCoverage += objective === "cheapest" ? (1000 / cost) : speed;
        if (compatible.length === 1 && load) {
          weightedCoverage += objective === "cheapest" ? 500 : 800;
        }
      });

      if (!covered) {
        return;
      }

      const score = weightedCoverage + (covered * 100);
      if (score > bestScore) {
        bestScore = score;
        bestType = typeKey;
      }
    });

    if (!bestType) {
      throw new Error("No feasible truck mix can cover every load with the available fleet.");
    }

    seed.set(bestType, (seed.get(bestType) || 0) + 1);
    uncoveredLoads.forEach((loadId) => {
      const compatible = compatibility.get(loadId) || [];
      if (compatible.includes(bestType)) {
        uncoveredLoads.delete(loadId);
      }
    });
  }

  return seed;
}

function scoreScenarioResult(result, objective = "fastest", references = {}) {
  if (!result) {
    return Number.POSITIVE_INFINITY;
  }

  if (objective === "cheapest") {
    return (result.costEstimate * 1e9) + (result.totalMinutes * 1e4) + (result.allocatedTruckCount * 10) - result.truckUtilization;
  }

  if (objective === "utilized") {
    const fastestMinutes = Math.max(1, Number(references?.fastest?.totalMinutes) || result.totalMinutes || 1);
    const cheapestCost = Math.max(1, Number(references?.cheapest?.costEstimate) || result.costEstimate || 1);
    const timePenalty = Math.max(0, ((result.totalMinutes - (fastestMinutes * 1.15)) / fastestMinutes) * 1000);
    const costPenalty = Math.max(0, ((result.costEstimate - (cheapestCost * 1.1)) / cheapestCost) * 1000);
    return ((100 - (result.utilizationEfficiency || result.utilization || 0)) * 1e6) + (timePenalty * 1e5) + (costPenalty * 1e5) + (result.totalMinutes * 10) + result.costEstimate;
  }

  return (result.totalMinutes * 1e9) + (result.costEstimate * 1e4) + (result.allocatedTruckCount * 10) - result.truckUtilization;
}

function serializeTruckCountMap(countMap) {
  return [...countMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

function enumerateTruckCountMaps(maxCountByType = new Map()) {
  const entries = [...maxCountByType.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  const combinations = [];

  function visit(index, current) {
    if (index >= entries.length) {
      if ([...current.values()].some((value) => value > 0)) {
        combinations.push(new Map(current));
      }
      return;
    }

    const [typeKey, maxCount] = entries[index];
    for (let count = 0; count <= maxCount; count += 1) {
      current.set(typeKey, count);
      visit(index + 1, current);
    }
  }

  visit(0, new Map());
  return combinations;
}

function dominatesScenario(left, right) {
  if (!left || !right) {
    return false;
  }

  const noWorseOnTime = left.totalMinutes <= right.totalMinutes;
  const noWorseOnCost = left.costEstimate <= right.costEstimate;
  const noWorseOnUtilization = left.truckUtilization >= right.truckUtilization;
  const strictlyBetter =
    left.totalMinutes < right.totalMinutes ||
    left.costEstimate < right.costEstimate ||
    left.truckUtilization > right.truckUtilization;

  return noWorseOnTime && noWorseOnCost && noWorseOnUtilization && strictlyBetter;
}

function buildParetoFrontier(candidates = []) {
  return candidates.filter((candidate, index) =>
    !candidates.some((other, otherIndex) => otherIndex !== index && dominatesScenario(other, candidate)),
  );
}

function optimizeTruckMixForScenario(loads, routeData, availableTruckSetup, truckSpecs, scenarioDefinition, constraints = null, references = null) {
  const truckSpecMap = buildTruckSpecMap(truckSpecs, availableTruckSetup);
  const maxCountByType = new Map(
    (availableTruckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck.type),
      Math.max(0, Number.parseInt(truck.count, 10) || 0),
    ]),
  );
  const evaluationCache = new Map();
  const evaluationErrors = [];

  function evaluateCountMap(countMap) {
    const serialized = serializeTruckCountMap(countMap);
    if (evaluationCache.has(serialized)) {
      return evaluationCache.get(serialized);
    }

    const candidateSetup = buildTruckSetupFromCountMap(availableTruckSetup, countMap);
    if (!candidateSetup.length) {
      evaluationCache.set(serialized, null);
      return null;
    }

    try {
      const scenario = buildScenario(loads, routeData, candidateSetup, truckSpecs, scenarioDefinition, constraints);
      evaluationCache.set(serialized, scenario);
      return scenario;
    } catch (error) {
      evaluationErrors.push({
        truckSetup: candidateSetup,
        message: error?.message || "Unknown scheduling error",
      });
      evaluationCache.set(serialized, null);
      return null;
    }
  }

  const countMaps = enumerateTruckCountMaps(maxCountByType);
  const candidates = countMaps
    .map((countMap) => evaluateCountMap(countMap))
    .filter(Boolean);

  if (!candidates.length) {
    const firstFailure = evaluationErrors[0];
    const setupSummary = (firstFailure?.truckSetup || [])
      .map((truck) => `${truck.type} x${truck.count}`)
      .join(", ");
    const detail = firstFailure?.message ? ` ${firstFailure.message}` : "";
    const setupText = setupSummary ? ` Tried: ${setupSummary}.` : "";
    throw new Error(`Could not build a feasible ${scenarioDefinition.name} schedule with the available resources.${setupText}${detail}`.trim());
  }

  if (scenarioDefinition.objective === "utilized") {
    const fastestMinutes = Math.max(1, Number(references?.fastest?.totalMinutes) || 0);
    const cheapestCost = Math.max(1, Number(references?.cheapest?.costEstimate) || 0);
    const boundedCandidates = candidates.filter((candidate) => {
      const withinTimeBound = !fastestMinutes || candidate.totalMinutes <= fastestMinutes * 1.15;
      const withinCostBound = !cheapestCost || candidate.costEstimate <= cheapestCost * 1.1;
      return withinTimeBound && withinCostBound;
    });
    const optimizationPool = boundedCandidates.length ? boundedCandidates : candidates;
    const frontier = buildParetoFrontier(optimizationPool);

    frontier.sort((left, right) =>
      ((right.utilizationEfficiency || right.utilization) - (left.utilizationEfficiency || left.utilization)) ||
      (right.truckUtilization - left.truckUtilization) ||
      (right.utilization - left.utilization) ||
      (left.totalMinutes - right.totalMinutes) ||
      (left.costEstimate - right.costEstimate) ||
      (left.allocatedTruckCount - right.allocatedTruckCount)
    );
    return frontier[0];
  }

  candidates.sort((left, right) =>
    scoreScenarioResult(left, scenarioDefinition.objective, references) - scoreScenarioResult(right, scenarioDefinition.objective, references),
  );
  return candidates[0];
}

function buildScenario(loads, routeData, truckSetup, truckSpecs, scenarioDefinition, constraints = null) {
  const truckSpecMap = buildTruckSpecMap(truckSpecs, truckSetup);
  const fleet = buildFleet(truckSetup, truckSpecMap);
  const taskGraph = buildTaskGraph(loads, routeData, fleet, truckSpecMap, scenarioDefinition.crewMode);
  const effectiveConstraints = constraints || {
    maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
    maxRigDownWorkers: MAX_RIG_DOWN_WORKERS,
    maxRigUpWorkers: MAX_RIG_UP_WORKERS,
    startHour: 6,
    startMinute: 0,
  };
  const scheduledTasks = scheduleTasks(taskGraph, fleet, effectiveConstraints, scenarioDefinition.objective);
  validateScheduledTasks(scheduledTasks, effectiveConstraints, fleet);
  const planningAnalysis = buildPlanningAnalysis(scheduledTasks);
  const playback = buildPlayback(loads, scheduledTasks, planningAnalysis, routeData, fleet, truckSpecMap);
  playback.resourceUsage = buildResourceUsageSeries(scheduledTasks, fleet, playback.totalMinutes, effectiveConstraints);
  const metrics = summarizePlaybackMetricsWithConstraints(playback, scenarioDefinition.name, truckSpecMap, effectiveConstraints, fleet);
  const bestVariant = {
    name: scenarioDefinition.name,
    routeMinutes: routeData.minutes,
    processingMinutes: Math.max(0, playback.totalMinutes - (routeData.minutes || 0)),
    totalMinutes: playback.totalMinutes,
    playback,
  };

  return {
    name: scenarioDefinition.name,
    objective: scenarioDefinition.objective,
    crewMode: scenarioDefinition.crewMode,
    workerCount: metrics.requiredCrewCount,
    workerShifts: {
      dayShift: metrics.requiredCrewCount,
      nightShift: metrics.requiredCrewCount,
    },
    truckCount: fleet.length,
    allocatedTruckCount: fleet.length,
    capacity: fleet.length,
    routeMinutes: routeData.minutes,
    routeDistanceKm: routeData.distanceKm,
    routeSource: routeData.source,
    routeGeometry: routeData.geometry,
    truckSetup,
    allocatedTruckSetup: truckSetup,
    usedTruckSetup: playback.usedTruckSetup,
    requestedTruckCount: fleet.length,
    requestedTruckSetup: truckSetup,
    variantPlans: [bestVariant],
    bestVariant,
    totalMinutes: playback.totalMinutes,
    processingMinutes: Math.max(0, playback.totalMinutes - (routeData.minutes || 0)),
    playback,
    planningAnalysis: playback.planningAnalysis,
    waves: [],
    utilization: metrics.utilization,
    truckUtilization: metrics.truckUtilization,
    workerUtilization: metrics.workerUtilization,
    utilizationEfficiency: metrics.utilizationEfficiency,
    idleMinutes: metrics.idleMinutes,
    workerIdleMinutes: metrics.workerIdleMinutes,
    costEstimate: metrics.costEstimate,
    laborCost: metrics.laborCost,
    transportCost: metrics.transportCost,
    overheadCost: metrics.overheadCost,
  };
}

function buildManualBaselineScenario(loads, routeData, truckSetup, truckSpecs) {
  const expandedTruckSetup = (truckSetup || []).map((truck) => ({
    ...truck,
    count: Math.max(1, Math.ceil((Math.max(1, Number.parseInt(truck.count, 10) || 1)) * 1.2)),
  }));

  const baseline = buildScenario(
    loads,
    routeData,
    expandedTruckSetup,
    truckSpecs,
    { name: "Manual Baseline", objective: "baseline", crewMode: "optimal" },
    {
      maxConcurrentActivities: 1,
      maxRigDownWorkers: MAX_RIG_DOWN_WORKERS,
      maxRigUpWorkers: MAX_RIG_UP_WORKERS,
    },
  );

  return {
    truckSetup: expandedTruckSetup,
    costEstimate: baseline.costEstimate,
    totalMinutes: baseline.totalMinutes,
  };
}

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

  const onProgress = typeof progressOptions.onProgress === "function" ? progressOptions.onProgress : null;
  const scenarioConstraints = {
    maxConcurrentActivities: Math.max(1, Number(workerShiftConfig?.maxConcurrentActivities) || MAX_CONCURRENT_ACTIVITIES),
    maxRigDownWorkers: Math.max(1, Number(workerShiftConfig?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS),
    maxRigUpWorkers: Math.max(1, Number(workerShiftConfig?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS),
    startHour: Number.parseInt(workerShiftConfig?.startHour, 10) || 6,
    startMinute: Number.parseInt(workerShiftConfig?.startMinute, 10) || 0,
  };
  const normalizedTruckSetup = (truckSetup || [])
    .map((truck) => ({
      ...truck,
      type: normalizeTruckTypeLabel(truck.type),
      count: Math.max(0, Number.parseInt(truck.count, 10) || 0),
      hourlyCost: Math.max(0, Number(truck.hourlyCost) || 0),
    }))
    .filter((truck) => truck.type && truck.count > 0);

  if (!normalizedTruckSetup.length) {
    throw new Error("At least one truck must be configured to build the ISE schedule.");
  }

  const scenarios = [
    { name: "Fastest", objective: "fastest", crewMode: "optimal" },
    { name: "Cheapest", objective: "cheapest", crewMode: "minimum" },
    { name: "Utilized", objective: "utilized", crewMode: "midpoint" },
  ];

  const results = [];
  const fastestDefinition = scenarios[0];
  const cheapestDefinition = scenarios[1];
  const utilizedDefinition = scenarios[2];

  onProgress?.({
    stage: "scenario",
    percent: 56,
    message: `Scheduling ${fastestDefinition.name} scenario`,
    detail: `Stage 7 of 8. Optimizing the ${fastestDefinition.name} truck mix and schedule.`,
    completedStages: 7,
    totalStages: 8,
  });
  const fastestScenario = optimizeTruckMixForScenario(loads, routeData, normalizedTruckSetup, truckSpecs, fastestDefinition, scenarioConstraints);
  results.push(fastestScenario);

  onProgress?.({
    stage: "scenario",
    percent: 72,
    message: `Scheduling ${cheapestDefinition.name} scenario`,
    detail: `Stage 7 of 8. Optimizing the ${cheapestDefinition.name} truck mix and schedule.`,
    completedStages: 7,
    totalStages: 8,
  });
  const cheapestScenario = optimizeTruckMixForScenario(loads, routeData, normalizedTruckSetup, truckSpecs, cheapestDefinition, scenarioConstraints);
  results.push(cheapestScenario);

  onProgress?.({
    stage: "scenario",
    percent: 88,
    message: `Scheduling ${utilizedDefinition.name} scenario`,
    detail: `Stage 7 of 8. Optimizing the ${utilizedDefinition.name} truck mix and schedule.`,
    completedStages: 7,
    totalStages: 8,
  });
  const utilizedScenario = optimizeTruckMixForScenario(
    loads,
    routeData,
    normalizedTruckSetup,
    truckSpecs,
    utilizedDefinition,
    scenarioConstraints,
    {
      fastest: fastestScenario,
      cheapest: cheapestScenario,
    },
  );
  results.push(utilizedScenario);

  const baseline = buildManualBaselineScenario(loads, routeData, normalizedTruckSetup, truckSpecs);
  results.forEach((scenario) => {
    scenario.manualBaseline = baseline;
    scenario.savingsVsBaselinePercent = baseline.costEstimate > 0
      ? Math.round((((baseline.costEstimate - scenario.costEstimate) / baseline.costEstimate) * 1000)) / 10
      : 0;
  });

  results.debug = {
    scenarioFailures: [],
  };

  return results;
}
