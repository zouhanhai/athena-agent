import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "@/stores/auth";

const verification = {
  session_token: "ses123",
  employee: {
    id: "e1",
    email: "carol@caleo.com",
    display_name: "Carol",
    logo_url: "/logos/fox.png",
    role: "member" as const,
    created_at: "x",
    updated_at: "x",
  },
};

describe("auth store", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("starts unauthenticated with no session", () => {
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.sessionToken).toBeNull();
  });

  it("setSession stores the token + employee and persists to localStorage", () => {
    const auth = useAuthStore();
    auth.setSession(verification);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.sessionToken).toBe("ses123");
    expect(auth.employee?.email).toBe("carol@caleo.com");
    expect(localStorage.getItem("athena.session_token")).toBe("ses123");
  });

  it("setEmployee refreshes the profile without touching the token", () => {
    const auth = useAuthStore();
    auth.setSession(verification);
    auth.setEmployee({ ...verification.employee, display_name: "Carol C." });
    expect(auth.employee?.display_name).toBe("Carol C.");
    expect(auth.sessionToken).toBe("ses123");
  });

  it("restores the session token from localStorage on startup", () => {
    localStorage.setItem("athena.session_token", "ses_persisted");
    const auth = useAuthStore();
    expect(auth.sessionToken).toBe("ses_persisted");
    expect(auth.isAuthenticated).toBe(true);
  });

  it("logout clears the token, employee and localStorage", () => {
    const auth = useAuthStore();
    auth.setSession(verification);
    auth.logout();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.sessionToken).toBeNull();
    expect(auth.employee).toBeNull();
    expect(localStorage.getItem("athena.session_token")).toBeNull();
  });
});
