import { deleteApp, initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { firebaseApp, firebaseAuth, firebaseConfig, firebaseDb, firebaseServerTimestamp } from "./firebase.js";
import { FIREBASE_USER_ROLES, FIRESTORE_COLLECTIONS } from "./firebaseSchema.js";

function normalizeDocSnapshot(snapshot) {
  if (!snapshot.exists()) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
}

function isCoordinatePair(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function isSerializedPoint(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.__rigsyncType === "point" &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng),
  );
}

function isSerializedArray(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.__rigsyncType === "array" &&
    Array.isArray(value.items),
  );
}

function serializeMoveValue(value, { nestedInArray = false } = {}) {
  if (isCoordinatePair(value)) {
    return {
      __rigsyncType: "point",
      lat: value[0],
      lng: value[1],
    };
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => serializeMoveValue(item, { nestedInArray: true }));
    return nestedInArray
      ? {
          __rigsyncType: "array",
          items,
        }
      : items;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, serializeMoveValue(entryValue)]),
    );
  }

  return value;
}

function restoreFirestoreSafeArrays(value) {
  if (Array.isArray(value)) {
    return value.map((item) => restoreFirestoreSafeArrays(item));
  }

  if (isSerializedPoint(value)) {
    return [value.lat, value.lng];
  }

  if (isSerializedArray(value)) {
    return value.items.map((item) => restoreFirestoreSafeArrays(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, restoreFirestoreSafeArrays(entryValue)]),
    );
  }

  return value;
}

function findFirstNestedArrayPath(value, path = "root", insideArray = false) {
  if (Array.isArray(value)) {
    if (insideArray) {
      return path;
    }

    for (let index = 0; index < value.length; index += 1) {
      const nestedPath = findFirstNestedArrayPath(value[index], `${path}[${index}]`, true);
      if (nestedPath) {
        return nestedPath;
      }
    }

    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, entryValue] of Object.entries(value)) {
      const nestedPath = findFirstNestedArrayPath(entryValue, `${path}.${key}`, false);
      if (nestedPath) {
        return nestedPath;
      }
    }
  }

  return null;
}

function serializeMovePayload(move) {
  const payload = serializeMoveValue(move);
  const nestedArrayPath = findFirstNestedArrayPath(payload);
  if (nestedArrayPath) {
    throw new Error(`Move payload still contains nested arrays at ${nestedArrayPath}`);
  }

  return payload;
}

function deserializeMovePayload(move) {
  return restoreFirestoreSafeArrays(move);
}

export async function getUserProfileById(userId) {
  if (!userId) {
    return null;
  }

  const snapshot = await getDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.users, userId));
  return normalizeDocSnapshot(snapshot);
}

export async function getUserProfileByEmail(email) {
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!safeEmail) {
    return null;
  }

  const snapshot = await getDocs(query(collection(firebaseDb, FIRESTORE_COLLECTIONS.users), where("email", "==", safeEmail)));
  return snapshot.docs.length ? normalizeDocSnapshot(snapshot.docs[0]) : null;
}

export async function upsertUserProfile(user) {
  const payload = {
    ...user,
    email: String(user.email || "").trim().toLowerCase(),
    updatedAt: firebaseServerTimestamp(),
  };

  await setDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.users, user.id), payload, { merge: true });
  return payload;
}

export async function signInFirebaseUser(email, password) {
  const credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
  const profile = await getUserProfileById(credential.user.uid) || await getUserProfileByEmail(email);
  return {
    credential,
    profile,
  };
}

export async function createFirebaseUserAccount({ email, password, profile }) {
  const appName = `rigsync-secondary-${Date.now()}`;
  const secondaryApp = initializeApp(firebaseConfig, appName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const userProfile = {
      ...profile,
      id: credential.user.uid,
      email: String(email || "").trim().toLowerCase(),
      updatedAt: firebaseServerTimestamp(),
    };
    await setDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.users, credential.user.uid), userProfile, { merge: true });
    await signOut(secondaryAuth);
    return {
      uid: credential.user.uid,
      profile: userProfile,
    };
  } finally {
    await deleteApp(secondaryApp);
  }
}

export async function ensureSeedUsers(users = []) {
  for (const user of users) {
    await upsertUserProfile({
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      managerId: user.managerId || null,
      teamForemanIds: user.teamForemanIds || [],
      assignedRig: user.assignedRig || null,
      active: true,
    });
  }
}

export function subscribeManagerMoves(managerId, callback) {
  const ref = query(collection(firebaseDb, FIRESTORE_COLLECTIONS.moves), where("managerId", "==", managerId));
  return onSnapshot(ref, (snapshot) => {
    callback(snapshot.docs.map(normalizeDocSnapshot).filter(Boolean).map(deserializeMovePayload));
  });
}

export async function fetchMoveDoc(moveId) {
  const snapshot = await getDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.moves, moveId));
  return deserializeMovePayload(normalizeDocSnapshot(snapshot));
}

export async function saveMoveDoc(move) {
  const payload = serializeMovePayload({
    ...move,
    updatedAt: new Date().toISOString(),
  });
  await setDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.moves, move.id), payload, { merge: true });
  return move;
}

export async function deleteMoveDoc(moveId) {
  await deleteDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.moves, moveId));
}

export function subscribeManagerResources(managerId, callback) {
  return onSnapshot(doc(firebaseDb, FIRESTORE_COLLECTIONS.managerResources, managerId), (snapshot) => {
    callback(normalizeDocSnapshot(snapshot));
  });
}

export async function fetchManagerResourcesDoc(managerId) {
  const snapshot = await getDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.managerResources, managerId));
  return normalizeDocSnapshot(snapshot);
}

export async function saveManagerResourcesDoc(managerId, resources) {
  const payload = {
    ...resources,
    managerId,
    updatedAt: firebaseServerTimestamp(),
  };
  await setDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.managerResources, managerId), payload, { merge: true });
  return payload;
}

export function subscribeRigInventoryDoc(rigId, callback) {
  return onSnapshot(doc(firebaseDb, FIRESTORE_COLLECTIONS.rigInventory, rigId), (snapshot) => {
    callback(normalizeDocSnapshot(snapshot));
  });
}

export async function fetchRigInventoryDoc(rigId) {
  const snapshot = await getDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.rigInventory, rigId));
  return normalizeDocSnapshot(snapshot);
}

export async function saveRigInventoryDoc(rigId, adjustments) {
  const payload = {
    rigId,
    adjustments,
    updatedAt: firebaseServerTimestamp(),
  };
  await setDoc(doc(firebaseDb, FIRESTORE_COLLECTIONS.rigInventory, rigId), payload, { merge: true });
  return payload;
}

export { firebaseAuth, FIREBASE_USER_ROLES };
