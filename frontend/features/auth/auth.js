import { AUTH_STORAGE_KEY } from "../../lib/constants.js";

export const TEST_USER = {
  email: "test@a.com",
  password: "123123",
  name: "Test User",
  role: "Manager",
};

export function getSession() {
  try {
    const raw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createSession() {
  const session = {
    name: TEST_USER.name,
    email: TEST_USER.email,
    role: TEST_USER.role,
  };
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearSession() {
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
}
