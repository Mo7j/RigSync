import { AUTH_STORAGE_KEY } from "../../lib/constants.js";
import {
  FIREBASE_USER_ROLES,
  createFirebaseUserAccount,
  deleteUserProfile,
  getUserProfileByEmail,
  getUserProfileById,
  signInFirebaseUser,
  upsertUserProfile,
} from "../../lib/firebaseOperations.js";
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
    isDemo: Boolean(user.isDemo),
    teamForemanIds: user.teamForemanIds || [],
    assignedRig: user.assignedRig || null,
    truckId: user.truckId || null,
    truckType: user.truckType || null,
  };
}

export async function authenticateUser(email, password) {
  try {
    const { profile } = await signInFirebaseUser(email, password);
    if (profile) {
      if (profile.active === false) {
        throw new Error("This account is inactive.");
      }
      return buildSessionFromUser(profile);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "This account is inactive.") {
      throw error;
    }
  }
  throw new Error("Invalid credentials. Please check your email and password.");
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

export async function createForemanAccount({ name, email, password, managerId, assignedRig = null }) {
  const result = await createFirebaseUserAccount({
    email,
    password,
    profile: {
      name,
      role: FIREBASE_USER_ROLES.foreman,
      managerId,
      assignedRig,
      active: true,
    },
  });

  return {
    id: result.uid,
    name,
    email: String(email || "").trim().toLowerCase(),
    role: FIREBASE_USER_ROLES.foreman,
    managerId,
    assignedRig,
  };
}

export async function updateForemanAccount({ id, name, email, managerId, assignedRig = null }) {
  if (!id) {
    throw new Error("Foreman id is required.");
  }

  const payload = {
    id,
    name,
    email: String(email || "").trim().toLowerCase(),
    role: FIREBASE_USER_ROLES.foreman,
    managerId,
    assignedRig,
    active: true,
  };

  await upsertUserProfile(payload);
  return payload;
}

export async function deleteForemanAccount(foremanId) {
  if (!foremanId) {
    return;
  }

  await deleteUserProfile(foremanId);
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

  const remoteProfile =
    await getUserProfileById(storedSession.id) ||
    await getUserProfileByEmail(storedSession.email);

  if (!remoteProfile) {
    clearSession();
    return null;
  }

  if (remoteProfile.active === false) {
    clearSession();
    return null;
  }

  currentSession = buildSessionFromUser(remoteProfile);
  persistSession(currentSession);
  return currentSession;
}

export function createSession(user) {
  currentSession = buildSessionFromUser(user);
  persistSession(currentSession);
  return currentSession;
}

export function clearSession() {
  currentSession = null;
  persistSession(null);
}
