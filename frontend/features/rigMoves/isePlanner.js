const SHIFT_MINUTES = 12 * 60;
const OVERHEAD_SAR_PER_DAY = 5000;
const MAX_CONCURRENT_ACTIVITIES = 3;
const MAX_RIG_DOWN_WORKERS = 30;
const MAX_RIG_UP_WORKERS = 30;

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

  if (normalized.includes("flatbed")) {
    return "flatbed";
  }
  if (normalized.includes("lowbed") || normalized.includes("support")) {
    return "lowbed";
  }
  if (normalized.includes("heavyhaul")) {
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
  const adjusted = baseDuration * Math.max(0.75, minimumWorkers / Math.max(assignedWorkers, 1));

  return Math.max(1, Math.round(adjusted));
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

function getEligibleTruckIds(load, fleet) {
  const allowed = new Set(
    (load?.truck_options || load?.truckTypes || load?.truck_types || [load?.truck_type || ""])
      .map((type) => normalizeTruckTypeKey(type))
      .filter(Boolean),
  );

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
  const allPrimaryRmIds = [];
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
      eligibleTruckIds: [],
      predecessorIds: [`${loadCode} (RM)`],
    });

    return tasks;
  }).flat();

  preliminary.forEach((task) => {
    if (task.phaseCode === "RM" && task.sourceKind !== "startup") {
      allPrimaryRmIds.push(task.id);
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
      task.predecessorIds.push(...allPrimaryRmIds);
    }

    task.predecessorIds = [...new Set(task.predecessorIds)];
  });

  preliminary.forEach((task) => {
    if (task.phaseCode !== "RM") {
      return;
    }

    const candidateTrucks = (task.eligibleTruckIds.length
      ? task.eligibleTruckIds.map((truckId) => fleet.find((truck) => truck.id === truckId))
      : fleet
    ).filter(Boolean);
    if (!candidateTrucks.length) {
      throw new Error(`No compatible truck is available for ${task.loadCode}.`);
    }

    task.truckOptions = candidateTrucks.map((truck) => ({
      truckId: truck.id,
      truckType: truck.type,
      hourlyCost: Math.max(0, Number(truck.spec?.hourlyCost) || 0),
      averageSpeedKmh: Math.max(0, Number(truck.spec?.average_speed_kmh) || 0),
      durationMinutes: computeRmDurationMinutes(task.load, truck.spec, routeData?.distanceKm),
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

function findEarliestStart(task, earliestStartMinute, scheduledIntervals, truckSchedules) {
  return findEarliestStartWithConstraints(
    task,
    earliestStartMinute,
    scheduledIntervals,
    truckSchedules,
    {
      maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
      maxRigDownWorkers: MAX_RIG_DOWN_WORKERS,
      maxRigUpWorkers: MAX_RIG_UP_WORKERS,
    },
  );
}

function findEarliestStartWithConstraints(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints) {
  let minute = Math.max(0, Math.round(earliestStartMinute));
  let guard = 0;
  const maxConcurrentActivities = Math.max(1, Number(constraints?.maxConcurrentActivities) || MAX_CONCURRENT_ACTIVITIES);
  const maxRigDownWorkers = Math.max(1, Number(constraints?.maxRigDownWorkers) || MAX_RIG_DOWN_WORKERS);
  const maxRigUpWorkers = Math.max(1, Number(constraints?.maxRigUpWorkers) || MAX_RIG_UP_WORKERS);

  while (guard < 200000) {
    guard += 1;
    const endMinute = minute + task.durationMinutes;
    const activeCount = intervalLoad(scheduledIntervals, minute, endMinute, null, "activityLoad");
    if (activeCount >= maxConcurrentActivities) {
      minute += 15;
      continue;
    }

    if (task.phaseCode === "RD") {
      const rdWorkers = intervalLoad(
        scheduledIntervals,
        minute,
        endMinute,
        (interval) => interval.phaseCode === "RD",
      );
      if (rdWorkers + task.siteWorkers > maxRigDownWorkers) {
        minute += 15;
        continue;
      }
    }

    if (task.phaseCode === "RU") {
      const ruWorkers = intervalLoad(
        scheduledIntervals,
        minute,
        endMinute,
        (interval) => interval.phaseCode === "RU",
      );
      if (ruWorkers + task.siteWorkers > maxRigUpWorkers) {
        minute += 15;
        continue;
      }
    }

    if (task.phaseCode === "RM" && task.assignedTruckId) {
      const truckId = task.assignedTruckId;
      const truckBusy = (truckSchedules.get(truckId) || []).some((interval) =>
        overlaps(minute, endMinute, interval.startMinute, interval.endMinute),
      );
      if (truckBusy) {
        minute += 15;
        continue;
      }
    }

    return minute;
  }

  throw new Error(`Could not find a feasible start time for ${task.id}.`);
}

function chooseTruckAssignment(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints, objective = "fastest") {
  const truckOptions = task.truckOptions || [];
  if (!truckOptions.length) {
    throw new Error(`No truck options are available for ${task.id}.`);
  }

  const rankedAssignments = truckOptions.map((option) => {
    const candidateTask = {
      ...task,
      assignedTruckId: option.truckId,
      assignedTruckType: option.truckType,
      durationMinutes: option.durationMinutes,
    };
    const startMinute = findEarliestStartWithConstraints(
      candidateTask,
      earliestStartMinute,
      scheduledIntervals,
      truckSchedules,
      constraints,
    );
    return {
      ...option,
      startMinute,
      endMinute: startMinute + option.durationMinutes,
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
        startMinute: assignment.startMinute,
        endMinute: assignment.endMinute,
      };
    } else {
      const startMinute = findEarliestStartWithConstraints(task, earliestStartMinute, scheduledIntervals, truckSchedules, constraints);
      const endMinute = startMinute + task.durationMinutes;
      scheduledTask = {
        ...task,
        startMinute,
        endMinute,
      };
    }

    scheduled.set(task.id, scheduledTask);
    scheduledIntervals.push({
      startMinute: scheduledTask.startMinute,
      endMinute: scheduledTask.endMinute,
      load: task.phaseCode === "RM" ? 1 : task.siteWorkers,
      phaseCode: task.phaseCode,
      activityLoad: 1,
    });

    if (task.phaseCode === "RM") {
      const intervals = truckSchedules.get(task.assignedTruckId) || [];
      intervals.push({ startMinute: scheduledTask.startMinute, endMinute: scheduledTask.endMinute });
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
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));

  tasks.forEach((task) => {
    task.predecessorIds.forEach((predecessorId) => {
      if (dependents.has(predecessorId)) {
        dependents.get(predecessorId).push(task.id);
      }
    });
  });

  const topo = [...tasks].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  const earliest = new Map();
  topo.forEach((task) => {
    const earliestStart = Math.max(
      0,
      ...task.predecessorIds.map((predecessorId) => earliest.get(predecessorId)?.finish || 0),
    );
    earliest.set(task.id, {
      start: earliestStart,
      finish: earliestStart + task.durationMinutes,
    });
  });

  const projectFinish = Math.max(...topo.map((task) => earliest.get(task.id)?.finish || 0), 0);
  const latest = new Map();
  [...topo].reverse().forEach((task) => {
    const taskDependents = dependents.get(task.id) || [];
    const latestFinish = taskDependents.length
      ? Math.min(...taskDependents.map((dependentId) => latest.get(dependentId)?.start || projectFinish))
      : projectFinish;
    latest.set(task.id, {
      finish: latestFinish,
      start: latestFinish - task.durationMinutes,
    });
  });

  const enrichedTasks = topo.map((task) => {
    const earliestWindow = earliest.get(task.id);
    const latestWindow = latest.get(task.id);
    const slack = Math.max(0, (latestWindow?.start || 0) - (earliestWindow?.start || 0));
    return {
      ...task,
      earliestStart: earliestWindow?.start || 0,
      earliestFinish: earliestWindow?.finish || task.durationMinutes,
      latestStart: latestWindow?.start || 0,
      latestFinish: latestWindow?.finish || task.durationMinutes,
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
      returnStart: null,
      returnToSource: null,
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
      returnStart: null,
      returnToSource: null,
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
      activityCode: task.phaseCode,
      activityLabel: task.activityLabel,
      sourceKind: task.sourceKind,
      predecessorIds: [...task.predecessorIds],
      startMinute: task.startMinute,
      endMinute: task.endMinute,
      earliestStart: task.earliestStart,
      earliestFinish: task.earliestFinish,
      latestStart: task.latestStart,
      latestFinish: task.latestFinish,
      durationMinutes: task.durationMinutes,
      roleCounts: task.roleCounts,
      siteWorkers: task.siteWorkers,
      slack: task.slack,
      isCritical: task.isCritical,
    })),
    planningAnalysis: {
      projectFinish: planningAnalysis.projectFinish,
      criticalTaskIds: [...planningAnalysis.criticalTaskIds],
    },
    usedTruckSetup,
    workerAssignments: [],
  };
}

function summarizePlaybackMetrics(playback, scenarioName, truckSpecMap) {
  return summarizePlaybackMetricsWithConstraints(playback, scenarioName, truckSpecMap, {
    maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
  });
}

function summarizePlaybackMetricsWithConstraints(playback, scenarioName, truckSpecMap, constraints) {
  const totalMinutes = Math.max(1, playback.totalMinutes || 1);
  const maxConcurrentActivities = Math.max(1, Number(constraints?.maxConcurrentActivities) || MAX_CONCURRENT_ACTIVITIES);
  const truckActiveMinutes = (playback.trips || []).reduce(
    (sum, trip) => sum + Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || 0)),
    0,
  );
  const workerActiveMinutes = (playback.trips || []).reduce(
    (sum, trip) =>
      sum +
      (Math.max(0, (trip.rigDownFinish || 0) - (trip.rigDownStart || 0)) * Math.max(0, Number(trip.rigDownWorkerCount) || 0)) +
      (Math.max(0, (trip.rigUpFinish || 0) - (trip.rigUpStart || 0)) * Math.max(0, Number(trip.rigUpWorkerCount) || 0)),
    0,
  );
  const truckCost = (playback.trips || []).reduce((sum, trip) => {
    const rate = truckSpecMap.get(normalizeTruckTypeKey(trip.truckType))?.hourlyCost || 0;
    return sum + ((Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || 0)) / 60) * rate);
  }, 0);
  const laborCost = (playback.tasks || []).reduce((sum, task) => sum + getTaskLaborCost(task), 0);
  const overheadCost = Math.ceil(totalMinutes / (24 * 60)) * OVERHEAD_SAR_PER_DAY;
  const usedTruckCount = new Set((playback.trips || []).map((trip) => trip.truckId).filter(Boolean)).size || 1;
  const truckCapacityMinutes = usedTruckCount * totalMinutes;

  return {
    scenarioName,
    truckUtilization: Math.min(100, Math.round((truckActiveMinutes / Math.max(1, truckCapacityMinutes)) * 100)),
    workerUtilization: Math.min(100, Math.round((workerActiveMinutes / Math.max(1, maxConcurrentActivities * totalMinutes)) * 100)),
    utilization: Math.min(100, Math.round(((truckActiveMinutes + workerActiveMinutes) / Math.max(1, truckCapacityMinutes + (maxConcurrentActivities * totalMinutes))) * 100)),
    idleMinutes: Math.max(0, truckCapacityMinutes - truckActiveMinutes),
    workerIdleMinutes: Math.max(0, (maxConcurrentActivities * totalMinutes) - workerActiveMinutes),
    costEstimate: Math.round(truckCost + laborCost + overheadCost),
    laborCost: Math.round(laborCost),
    transportCost: Math.round(truckCost),
    overheadCost: Math.round(overheadCost),
  };
}

function buildScenario(loads, routeData, truckSetup, truckSpecs, scenarioDefinition, constraints = null) {
  const truckSpecMap = buildTruckSpecMap(truckSpecs, truckSetup);
  const fleet = buildFleet(truckSetup, truckSpecMap);
  const taskGraph = buildTaskGraph(loads, routeData, fleet, truckSpecMap, scenarioDefinition.crewMode);
  const effectiveConstraints = constraints || {
    maxConcurrentActivities: MAX_CONCURRENT_ACTIVITIES,
    maxRigDownWorkers: MAX_RIG_DOWN_WORKERS,
    maxRigUpWorkers: MAX_RIG_UP_WORKERS,
  };
  const scheduledTasks = scheduleTasks(taskGraph, fleet, effectiveConstraints, scenarioDefinition.objective);
  const planningAnalysis = buildPlanningAnalysis(scheduledTasks);
  const playback = buildPlayback(loads, scheduledTasks, planningAnalysis, routeData, fleet, truckSpecMap);
  const metrics = summarizePlaybackMetricsWithConstraints(playback, scenarioDefinition.name, truckSpecMap, effectiveConstraints);
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
    workerCount: MAX_CONCURRENT_ACTIVITIES,
    workerShifts: {
      dayShift: MAX_CONCURRENT_ACTIVITIES,
      nightShift: MAX_CONCURRENT_ACTIVITIES,
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
  void workerShiftConfig;

  const onProgress = typeof progressOptions.onProgress === "function" ? progressOptions.onProgress : null;
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
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    onProgress?.({
      stage: "scenario",
      percent: 40 + Math.round(((index + 1) / scenarios.length) * 50),
      message: `Scheduling ${scenario.name} scenario`,
      detail: `Stage 7 of 8. Building the ${scenario.name} plan with ISE activity and resource rules.`,
      completedStages: 7,
      totalStages: 8,
    });
    results.push(buildScenario(loads, routeData, normalizedTruckSetup, truckSpecs, scenario));
  }

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
