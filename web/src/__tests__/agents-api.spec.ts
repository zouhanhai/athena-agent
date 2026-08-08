import { describe, expect, it, vi, afterEach } from "vitest";

import {
  submitSelfDeclaration,
  listDeclarations,
  registerDeclaration,
  listAgents,
  listLogos,
} from "@/api/agents";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const caps = {
  system: "opencode",
  mcp: ["lightrag"],
  tools: ["bash"],
  skills: ["code_review"],
  specialty: "software-engineering",
};

describe("submitSelfDeclaration", () => {
  it("POSTs the agent's own capabilities + runtime without alias/logo", async () => {
    const declaration = { id: "d1", agent_id: "opencode-ses_x", capabilities: caps, runtime: "local", declared_at: "now" };
    stubFetch(jsonResponse({ declaration }));
    const result = await submitSelfDeclaration("opencode-ses_x", caps, "local");

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/self-declare",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "opencode-ses_x", capabilities: caps, runtime: "local" }),
      }),
    );
    expect(result).toEqual(declaration);
  });
});

describe("listDeclarations", () => {
  it("GETs the pending declarations", async () => {
    const declarations = [{ id: "d1", agent_id: "opencode-ses_x", capabilities: caps, runtime: "local", declared_at: "now" }];
    stubFetch(jsonResponse({ declarations }));
    const result = await listDeclarations();
    expect(fetchMock()).toHaveBeenCalledWith("/api/agents/declarations", undefined);
    expect(result).toEqual(declarations);
  });
});

describe("registerDeclaration", () => {
  it("POSTs the employee-chosen alias + owner + logo for a declaration", async () => {
    const agent = { id: "a1", alias: "Hermes", owner_employee_id: "zhang.wei", logo_url: "/logos/fox-clean.png", capabilities: caps, runtime: "local", created_at: "x", updated_at: "x" };
    stubFetch(jsonResponse(agent, 201));
    const result = await registerDeclaration("d1", {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      logo_url: "/logos/fox-clean.png",
    });

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/register-declaration/d1",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: "Hermes", owner_employee_id: "zhang.wei", logo_url: "/logos/fox-clean.png" }),
      }),
    );
    expect(result).toEqual(agent);
  });
});

describe("listAgents", () => {
  it("GETs the registered agents", async () => {
    const agents = [{ alias: "Athena" }];
    stubFetch(jsonResponse({ agents }));
    const result = await listAgents();
    expect(fetchMock()).toHaveBeenCalledWith("/api/agents", undefined);
    expect(result).toEqual(agents);
  });
});

describe("listLogos", () => {
  it("GETs the logo set for the employee to pick from", async () => {
    const logos = [{ id: "l1", name: "fox", url: "/logos/fox-clean.png", filename: "fox-clean.png", source: "generated", created_at: "x" }];
    stubFetch(jsonResponse({ logos }));
    const result = await listLogos();
    expect(fetchMock()).toHaveBeenCalledWith("/api/logos", undefined);
    expect(result).toEqual(logos);
  });
});

describe("shared error handling", () => {
  it("throws with the status when a request is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 409));
    await expect(listDeclarations()).rejects.toThrow("409");
  });
});
