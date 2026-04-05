import { AUTH_STORAGE_KEY } from "../../lib/constants.js";
import {
  FIREBASE_USER_ROLES,
  createFirebaseUserAccount,
  getUserProfileById,
  signInFirebaseUser,
  upsertUserProfile,
} from "../../lib/firebaseOperations.js";

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

function buildSessionFromUser(user = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    managerId: user.managerId || null,
    teamForemanIds: user.teamForemanIds || [],
    assignedRig: user.assignedRig || null,
    truckId: user.truckId || null,
    truckType: user.truckType || null,
  };
}

export async function authenticateUser(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const staticUser = TEST_USERS.find(
    (user) => user.email.toLowerCase() === normalizedEmail && user.password === password,
  );

  if (staticUser) {
    await upsertUserProfile({
      id: staticUser.id,
      role: staticUser.role,
      name: staticUser.name,
      email: staticUser.email,
      managerId: staticUser.managerId || null,
      teamForemanIds: staticUser.teamForemanIds || [],
      assignedRig: staticUser.assignedRig || null,
      active: true,
    });

    return buildSessionFromUser(staticUser);
  }

  try {
    const { profile } = await signInFirebaseUser(email, password);
    if (profile) {
      return buildSessionFromUser(profile);
    }
  } catch {
    // Fall through to invalid credentials.
  }

  if (!staticUser) {
    throw new Error("Invalid credentials. Please check your email and password.");
  }
}

export async function createDriverAccount({ name, email, password, managerId, truckId, truckType }) {
  const result = await createFirebaseUserAccount({
    email,
    password,
    profile: {
      name,
      role: FIREBASE_USER_ROLES.driver,
      managerId,
      truckId: truckId || null,
      truckType: truckType || null,
      active: true,
    },
  });

  return {
    id: result.uid,
    name,
    email: String(email || "").trim().toLowerCase(),
    role: FIREBASE_USER_ROLES.driver,
    managerId,
    truckId: truckId || null,
    truckType: truckType || null,
  };
}

export function getManagedForemen(managerId) {
  return TEST_USERS.filter((user) => user.role === "Foreman" && user.managerId === managerId);
}

export function getSession() {
  if (!currentSession) {
    currentSession = readStoredSession();
  }

  return currentSession;
}

export async function refreshSession() {
  const storedSession = getSession();
  if (!storedSession?.id) {
    return null;
  }

  const remoteProfile = await getUserProfileById(storedSession.id);
  if (!remoteProfile) {
    return storedSession;
  }

  currentSession = buildSessionFromUser(remoteProfile);
  persistSession(currentSession);
  return currentSession;
}

export function createSession(user = TEST_USER) {
  currentSession = buildSessionFromUser(user);
  persistSession(currentSession);
  return currentSession;
}

export function clearSession() {
  currentSession = null;
  persistSession(null);
}
