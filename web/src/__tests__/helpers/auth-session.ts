import { vi } from "vitest";
import type { Pinia } from "pinia";
import type { EmployeeRecord } from "@/api/invitations";
import { useAuthStore } from "@/stores/auth";

export const MEMBER_EMPLOYEE: EmployeeRecord = {
  id: "e1",
  email: "member@caleo.com",
  display_name: "Member User",
  logo_url: "/logos/fox-clean.png",
  role: "member",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

/**
 * Seed a signed-in session on the given pinia so the global auth guard lets
 * navigation tests pass through protected pages. Tests that mount App also
 * trigger auth.bootstrap() (GET /api/me); jsdom fetch cannot resolve the
 * relative URL, so stub it to return the same employee (else bootstrap logs
 * the session out). Call vi.unstubAllGlobals() in afterEach.
 */
export function installAuthSession(
  pinia: Pinia,
  employee: EmployeeRecord = MEMBER_EMPLOYEE,
  token = "test-session-token",
): void {
  const auth = useAuthStore(pinia);
  auth.setSession({ session_token: token, employee });
  // Serve GET /api/me so App's bootstrap() keeps the session. Every other
  // request REJECTS: the views fetch in try/catch (KnowledgeView/WikiView/
  // WorkbenchView/SettingsView/GlobalChatPanel) and fall back to empty state —
  // returning garbage shapes instead would make their computed/render throw.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) {
        return new Response(JSON.stringify(employee), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new TypeError("Network request failed (test stub)");
    }),
  );
}
