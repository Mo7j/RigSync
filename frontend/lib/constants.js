export const BASE_PLAYBACK_SECONDS = 40;
export const DEFAULT_CENTER = [24.7136, 46.6753];
export const HISTORY_STORAGE_KEY = "rigsync-plan-history";
export const MOVES_STORAGE_KEY = "rigsync-rig-moves-v2";
export const AUTH_STORAGE_KEY = "rigsync-auth-session";
export const MANAGER_RESOURCES_STORAGE_KEY = "rigsync-manager-resources";
export const RIG_INVENTORY_STORAGE_KEY = "rigsync-rig-inventory";
export const MIN_LOAD_DURATION_MINUTES = 30;
export const MAX_LOAD_DURATION_MINUTES = 120;
export const DEFAULT_MOVE_SETTINGS = {
  workerCount: 6,
  truckCount: 4,
};

export const DEFAULT_TRUCK_SETUP = [
  { id: "heavy-haul", type: "Heavy Hauler", count: 2 },
  { id: "flatbed", type: "Flat-bed", count: 1 },
  { id: "support", type: "Low-bed", count: 1 },
];
