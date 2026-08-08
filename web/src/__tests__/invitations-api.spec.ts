import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  resolveInvitation,
  registerInvitedEmployee,
  sendInvite,
  requestMagicLink,
  verifyMagicLink,
  listEmployees,
  fetchMe,
} from "@/api/invitations";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("invitations API", () => {
  it("resolveInvitation GETs the token and returns the invited email", async () => {
    fetchMock.mockResolvedValue(ok({ email: "carol@caleo.com" }));
    const email = await resolveInvitation("abc123");
    expect(email).toBe("carol@caleo.com");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invitations/resolve?token=abc123",
      undefined,
    );
  });

  it("resolveInvitation throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "bad token" }), { status: 401 }));
    await expect(resolveInvitation("bad")).rejects.toThrow();
  });

  it("registerInvitedEmployee POSTs the token, profile and github credential", async () => {
    const verification = {
      session_token: "ses123",
      employee: { id: "e1", email: "carol@caleo.com", display_name: "Carol", role: "member" },
    };
    fetchMock.mockResolvedValue(ok(verification));
    const result = await registerInvitedEmployee("tok", {
      display_name: "Carol",
      logo_url: "/logos/fox-clean.png",
      github_credential: { type: "token", value: "ghp_x" },
    });
    expect(result.session_token).toBe("ses123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/invitations/register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      token: "tok",
      display_name: "Carol",
      logo_url: "/logos/fox-clean.png",
      github_credential: { type: "token", value: "ghp_x" },
    });
  });

  it("sendInvite POSTs the email to /api/invitations", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await sendInvite("carol@caleo.com");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/invitations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "carol@caleo.com" });
  });

  it("requestMagicLink POSTs the email to /api/auth/login", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await requestMagicLink("carol@caleo.com");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "carol@caleo.com" });
  });

  it("verifyMagicLink POSTs the token to /api/auth/verify", async () => {
    const verification = { session_token: "ses1", employee: { id: "e1", email: "a@b.com" } };
    fetchMock.mockResolvedValue(ok(verification));
    const result = await verifyMagicLink("login-token");
    expect(result.session_token).toBe("ses1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/verify");
    expect(JSON.parse(init.body)).toEqual({ token: "login-token" });
  });

  it("listEmployees GETs employees with the Bearer session token", async () => {
    const employees = [
      { id: "e1", email: "carol@caleo.com", display_name: "Carol", logo_url: "/logos/fox-clean.png", role: "member" },
    ];
    fetchMock.mockResolvedValue(ok({ employees }));
    const result = await listEmployees("ses123");
    expect(result).toEqual(employees);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/employees");
    expect(init.headers).toEqual({ Authorization: "Bearer ses123" });
  });

  it("fetchMe returns null on 401 and the employee on 200", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    expect(await fetchMe("bad")).toBeNull();

    fetchMock.mockResolvedValue(ok({ id: "e1", email: "a@b.com" }));
    expect(await fetchMe("good")).toMatchObject({ id: "e1" });
  });
});
