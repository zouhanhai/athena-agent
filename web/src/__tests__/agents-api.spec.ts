import { describe, expect, it, vi, afterEach } from "vitest";

import {
  submitSelfDeclaration,
  listDeclarations,
  registerDeclaration,
  listAgents,
  getAgent,
  updateAgent,
  confirmAgent,
  createAgent,
  inviteAgent,
  registerAgent,
  listLogos,
  uploadLogo,
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
  mcp: ["athena"],
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
  it("GETs the registered agents with their status", async () => {
    const agents = [
      {
        id: "a1",
        alias: "Hermes",
        agent_id: "agent-hermes",
        owner_employee_id: "zhang.wei",
        logo_url: "/logos/fox-clean.png",
        capabilities: caps,
        runtime: "local",
        api_url: "http://hermes.local:3001",
        status: "reachable",
        has_token: true,
        created_at: "x",
        updated_at: "x",
      },
    ];
    stubFetch(jsonResponse({ agents }));
    const result = await listAgents();
    expect(fetchMock()).toHaveBeenCalledWith("/api/agents", undefined);
    expect(result).toEqual(agents);
  });
});

describe("getAgent", () => {
  it("GETs a single agent's full detail by alias", async () => {
    const agent = {
      id: "a1",
      alias: "Hermes",
      agent_id: "agent-hermes",
      owner_employee_id: "zhang.wei",
      logo_url: "/logos/fox-clean.png",
      capabilities: caps,
      runtime: "local",
      api_url: "http://hermes.local:3001",
      status: "reachable" as const,
      has_token: true,
      capabilities_pending_review: false,
      connected: true,
      created_at: "x",
      updated_at: "x",
    };
    stubFetch(jsonResponse(agent));
    const result = await getAgent("Hermes");
    expect(fetchMock()).toHaveBeenCalledWith("/api/agents/Hermes", undefined);
    expect(result).toEqual(agent);
  });
});

describe("updateAgent", () => {
  it("PUTs alias + logo edits to the agent detail", async () => {
    const agent = { id: "a1", alias: "Hermes-2", logo_url: "/logos/wolf-indigo.png" };
    stubFetch(jsonResponse(agent));
    const result = await updateAgent("Hermes", {
      alias: "Hermes-2",
      logo_url: "/logos/wolf-indigo.png",
    });
    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/Hermes",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: "Hermes-2", logo_url: "/logos/wolf-indigo.png" }),
      }),
    );
    expect(result).toEqual(agent);
  });

  it("sends capabilities, which re-opens the pending-review state", async () => {
    const agent = { id: "a1", alias: "Hermes", capabilities: { ...caps, specialty: "deploy" } };
    stubFetch(jsonResponse(agent));
    await updateAgent("Hermes", { capabilities: { ...caps, specialty: "deploy" } });
    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/Hermes",
      expect.objectContaining({
        body: JSON.stringify({ capabilities: { ...caps, specialty: "deploy" } }),
      }),
    );
  });
});

describe("confirmAgent", () => {
  it("POSTs the owner review/approval with a Bearer session token", async () => {
    const agent = { id: "a1", alias: "Hermes", capabilities_pending_review: false };
    stubFetch(jsonResponse(agent));
    const result = await confirmAgent("agent-hermes", "ses123");
    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/agent-hermes/confirm",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer ses123" },
      }),
    );
    expect(result).toEqual(agent);
  });
});

describe("createAgent", () => {
  it("POSTs a manual registration with capabilities + remote fields", async () => {
    const agent = {
      id: "a1",
      alias: "Hermes",
      agent_id: "agent-hermes",
      owner_employee_id: "zhang.wei",
      logo_url: "",
      capabilities: caps,
      runtime: "local",
      api_url: "http://hermes.local:3001",
      status: "registered" as const,
      has_token: false,
      created_at: "x",
      updated_at: "x",
    };
    stubFetch(jsonResponse(agent, 201));
    const result = await createAgent({
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      capabilities: caps,
      runtime: "local",
      api_url: "http://hermes.local:3001",
      agent_id: "agent-hermes",
    });

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias: "Hermes",
          owner_employee_id: "zhang.wei",
          capabilities: caps,
          runtime: "local",
          api_url: "http://hermes.local:3001",
          agent_id: "agent-hermes",
        }),
      }),
    );
    expect(result).toEqual(agent);
  });
});

describe("inviteAgent", () => {
  it("POSTs the admin invitation with a Bearer session token", async () => {
    const result = {
      agent: { id: "a1", alias: "wts", status: "invited" },
      invite: { agent_id: "agent-wts", api_url: "http://wts.local:3001", token: "tok_abc" },
    };
    stubFetch(jsonResponse(result, 201));
    const value = await inviteAgent("ses123", {
      alias: "wts",
      owner_employee_id: "zhang.wei",
      api_url: "http://wts.local:3001",
    });

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/invite",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer ses123",
        },
        body: JSON.stringify({
          alias: "wts",
          owner_employee_id: "zhang.wei",
          api_url: "http://wts.local:3001",
        }),
      }),
    );
    expect(value).toEqual(result);
  });
});

describe("registerAgent", () => {
  it("POSTs the agent's token + reachability to accept an invitation", async () => {
    const agent = { id: "a1", alias: "Hermes", status: "reachable" as const };
    stubFetch(jsonResponse(agent));
    const result = await registerAgent({
      agent_id: "agent-hermes",
      api_url: "http://hermes.local:3002",
      token: "tok_abc",
    });

    expect(fetchMock()).toHaveBeenCalledWith(
      "/api/agents/register",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent-hermes",
          api_url: "http://hermes.local:3002",
          token: "tok_abc",
        }),
      }),
    );
    expect(result).toEqual(agent);
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

describe("listLogos exclude-in-use", () => {
  it("requests only available logos when excludeInUse is set", async () => {
    stubFetch(jsonResponse({ logos: [] }));
    await listLogos({ excludeInUse: true });
    expect(fetchMock()).toHaveBeenCalledWith("/api/logos?exclude-in-use=1", undefined);
  });
});

describe("uploadLogo", () => {
  it("POSTs the file as multipart form data and returns the created logo", async () => {
    const logo = {
      id: "u1",
      name: "custom",
      url: "/logos/uploads/1-custom.png",
      filename: "1-custom.png",
      source: "upload" as const,
      created_at: "x",
    };
    stubFetch(jsonResponse({ logo }, 201));
    const file = new File([new Uint8Array([1, 2, 3])], "custom.png", { type: "image/png" });
    const result = await uploadLogo(file);

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("/api/logos");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
    expect(result).toEqual(logo);
  });

  it("throws with the status when the upload is rejected", async () => {
    stubFetch(jsonResponse({ error: "file is empty" }, 400));
    const file = new File([new Uint8Array([0])], "empty.png", { type: "image/png" });
    await expect(uploadLogo(file)).rejects.toThrow("400");
  });
});

describe("shared error handling", () => {
  it("throws with the status when a request is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 409));
    await expect(listDeclarations()).rejects.toThrow("409");
  });
});
