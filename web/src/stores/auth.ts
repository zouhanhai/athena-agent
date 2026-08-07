import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  type EmployeeRecord,
  type LoginVerification,
  fetchMe,
} from "@/api/invitations";

const SESSION_KEY = "athena.session_token";

/** Session + current employee (G3.S2). The raw session token is never stored server-side; only its SHA-256 hash is. */
export const useAuthStore = defineStore("auth", () => {
  const sessionToken = ref<string | null>(localStorage.getItem(SESSION_KEY));
  const employee = ref<EmployeeRecord | null>(null);

  const isAuthenticated = computed(() => !!sessionToken.value);

  /** Adopt a fresh session (login verify or invitation registration). */
  function setSession(verification: LoginVerification): void {
    sessionToken.value = verification.session_token;
    employee.value = verification.employee;
    localStorage.setItem(SESSION_KEY, verification.session_token);
  }

  /** Refresh the cached profile (e.g. after editing display_name / logo). */
  function setEmployee(record: EmployeeRecord): void {
    employee.value = record;
  }

  /** Re-hydrate the employee from GET /api/me using a persisted session token. */
  async function bootstrap(): Promise<boolean> {
    if (!sessionToken.value) {
      return false;
    }
    const record = await fetchMe(sessionToken.value);
    if (!record) {
      logout();
      return false;
    }
    employee.value = record;
    return true;
  }

  function logout(): void {
    sessionToken.value = null;
    employee.value = null;
    localStorage.removeItem(SESSION_KEY);
  }

  return {
    sessionToken,
    employee,
    isAuthenticated,
    setSession,
    setEmployee,
    bootstrap,
    logout,
  };
});
