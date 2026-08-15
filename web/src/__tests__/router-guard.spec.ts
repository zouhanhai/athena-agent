import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import router from "@/router";
import { useAuthStore } from "@/stores/auth";
import type { EmployeeRecord } from "@/api/invitations";

const member: EmployeeRecord = {
  id: "e1",
  email: "member@caleo.com",
  display_name: "Member User",
  logo_url: "/logos/fox-clean.png",
  role: "member",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const admin: EmployeeRecord = {
  ...member,
  id: "e2",
  email: "admin@caleo.com",
  role: "admin",
};

async function navigate(path: string) {
  await router.push(path);
  await router.isReady();
}

beforeEach(async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  // The router singleton keeps its route across tests — start each test from a
  // known public route so a target push is never mistaken for a duplicate nav.
  await router.push("/login");
});

describe("global auth guard (G4.S7.T7)", () => {
  it("redirects a signed-out user from /knowledge to /login with a redirect query", async () => {
    await navigate("/knowledge");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(router.currentRoute.value.query.redirect).toBe("/knowledge");
  });

  it("redirects a signed-out user deep-linking to /uploads to /login with a redirect query", async () => {
    await navigate("/uploads");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(router.currentRoute.value.query.redirect).toBe("/uploads");
  });

  it("keeps /login public for signed-out users", async () => {
    await navigate("/login");
    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("keeps /register public for signed-out users", async () => {
    await navigate("/register");
    expect(router.currentRoute.value.path).toBe("/register");
  });

  it("keeps /auth/verify public for signed-out users", async () => {
    await navigate("/auth/verify?token=abc");
    expect(router.currentRoute.value.path).toBe("/auth/verify");
  });

  it("lets a signed-in member visit protected pages", async () => {
    useAuthStore().setSession({ session_token: "ses123", employee: member });
    await navigate("/knowledge");
    expect(router.currentRoute.value.path).toBe("/knowledge");
  });

  it("redirects a signed-in member away from /admin to /knowledge", async () => {
    useAuthStore().setSession({ session_token: "ses123", employee: member });
    await navigate("/admin");
    expect(router.currentRoute.value.path).toBe("/knowledge");
  });

  it("lets an admin visit /admin", async () => {
    useAuthStore().setSession({ session_token: "ses123", employee: admin });
    await navigate("/admin");
    expect(router.currentRoute.value.path).toBe("/admin");
  });

  it("redirects a signed-out user away from /admin to /login (auth before admin check)", async () => {
    await navigate("/admin");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(router.currentRoute.value.query.redirect).toBe("/admin");
  });
});
