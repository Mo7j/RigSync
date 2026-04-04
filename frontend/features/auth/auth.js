import { AUTH_STORAGE_KEY } from "../../lib/constants.js";

export const TEST_USERS = [
  {
    id: "manager-nasser",
    email: "manager@rigsync.com",
    password: "123123",
    name: "Nasser Al-Harbi",
    role: "Manager",
    teamForemanIds: ["foreman-fahad", "foreman-salem"],
  },
  {
    id: "foreman-fahad",
    email: "fahad@rigsync.com",
    password: "123123",
    name: "Fahad Al-Qahtani",
    role: "Foreman",
    managerId: "manager-nasser",
    assignedRig: {
      id: "rig-286",
      name: "Rig 286",
      field: "Shaybah",
      currentWell: "SBH-411",
      startPoint: { lat: 22.4862, lng: 53.9124 },
      startLabel: "Shaybah Pad 411",
      drillingCompletion: 64,
      dailyTargetHours: 18,
    },
  },
  {
    id: "foreman-salem",
    email: "salem@rigsync.com",
    password: "123123",
    name: "Salem Al-Mutairi",
    role: "Foreman",
    managerId: "manager-nasser",
    assignedRig: {
      id: "rig-194",
      name: "Rig 194",
      field: "Jafurah",
      currentWell: "JFR-208",
      startPoint: { lat: 25.2541, lng: 49.2853 },
      startLabel: "Jafurah Pad 208",
      drillingCompletion: 49,
      dailyTargetHours: 16,
    },
  },
];

export const TEST_USER = TEST_USERS[0];
let currentSession = null;

function readStoredSession() {
  try {
    const stored = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function persistSession(session) {
  try {
    if (!session) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage errors and keep in-memory session.
  }
}

export function findUserByCredentials(email, password) {
  return (
    TEST_USERS.find(
      (user) => user.email.toLowerCase() === String(email || "").trim().toLowerCase() && user.password === password,
    ) || null
  );
}

export function getManagedForemen(managerId) {
  return TEST_USERS.filter((user) => user.role === "Foreman" && user.managerId === managerId);
}

export function getSession() {
  if (!currentSession) {
    currentSession = readStoredSession();
  }

  if (!currentSession) {
    return null;
  }

  const matchedUser = TEST_USERS.find((user) => user.id === currentSession?.id);

  if (!matchedUser) {
    return currentSession;
  }

  currentSession = {
    ...currentSession,
    name: matchedUser.name,
    email: matchedUser.email,
    role: matchedUser.role,
    managerId: matchedUser.managerId || null,
    teamForemanIds: matchedUser.teamForemanIds || [],
    assignedRig: matchedUser.assignedRig || currentSession?.assignedRig || null,
  };
  persistSession(currentSession);

  return currentSession;
}

export function createSession(user = TEST_USER) {
  currentSession = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    managerId: user.managerId || null,
    teamForemanIds: user.teamForemanIds || [],
    assignedRig: user.assignedRig || null,
  };
  persistSession(currentSession);
  return currentSession;
}

export function clearSession() {
  currentSession = null;
  persistSession(null);
}
