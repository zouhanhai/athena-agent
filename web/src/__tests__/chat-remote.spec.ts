import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import { useChatStore } from "@/stores/chat";
import { streamChat } from "@/api/chat";
import { listAgents } from "@/api/agents";
import { listEmployees } from "@/api/invitations";
import { sendFeedback } from "@/api/feedback";
import GlobalChatPanel from "@/components/GlobalChatPanel.vue";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
}));

vi.mock("@/api/feedback", () => ({
  sendFeedback: vi.fn(),
  listQaPairs: vi.fn(),
}));

vi.mock("@/api/agents", () => ({
  listAgents: vi.fn(),
}));

vi.mock("@/api/invitations", () => ({
  listEmployees: vi.fn(),
}));

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;
const sendFeedbackMock = sendFeedback as unknown as ReturnType<typeof vi.fn>;

const REMOTE_AGENT = {
  id: "a2",
  alias: "RemoteHermes",
  agent_id: "agent-hermes-1",
  owner_employee_id: "e1",
  logo_url: "/logos/fox-clean.png",
  runtime: "hermes",
  api_url: "http://127.0.0.1:8642",
  status: "reachable",
  has_token: true,
  created_at: "",
  updated_at: "",
  capabilities: {
    system: "hermes",
    mcp: [],
    tools: ["shell"],
    skills: [],
    specialty: "coding",
    description: "",
  },
};

interface StreamArgs {
  onDelta: (delta: string) => void;
  onTool?: (tool: { state: string; name: string; detail?: string }) => void;
  onThinking?: (text: string) => void;
  onError?: (m: string) => void;
}

afterEach(() => {
  streamChatMock.mockReset();
  listAgentsMock.mockReset();
  listEmployeesMock.mockReset();
  sendFeedbackMock.mockReset();
});

describe("chat store remote-agent routing (G4.S7.T4)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function lastRemoteCall(): [string, string, StreamArgs, string, undefined, string] {
    return streamChatMock.mock.calls.at(-1) as [string, string, StreamArgs, string, undefined, string];
  }

  it("routes a message to a remote agent over its reverse tunnel agent_id", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const store = useChatStore();
    store.onAgentJoined({
      id: REMOTE_AGENT.alias,
      kind: "agent",
      name: REMOTE_AGENT.alias,
      logoUrl: REMOTE_AGENT.logo_url,
      agentId: REMOTE_AGENT.agent_id,
      capabilities: ["shell"],
    });

    await store.send("deploy the app");

    const [userId, message, , , , targetAgentId] = lastRemoteCall();
    expect(userId).toBe("hermes");
    expect(message).toBe("deploy the app");
    expect(targetAgentId).toBe("agent-hermes-1");
    expect(store.messages[store.messages.length - 1]!.speaker).toMatchObject({ id: "RemoteHermes", name: "RemoteHermes" });
  });

  it("appends tool-started rows and resolves them to completed on the assistant bubble", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const store = useChatStore();
    store.onAgentJoined({
      id: REMOTE_AGENT.alias,
      kind: "agent",
      name: REMOTE_AGENT.alias,
      logoUrl: REMOTE_AGENT.logo_url,
      agentId: REMOTE_AGENT.agent_id,
      capabilities: ["shell"],
    });

    const promise = store.send("deploy");
    const [, , handlers] = lastRemoteCall();
    handlers.onTool?.({ state: "started", name: "shell", detail: "npm run" });
    handlers.onTool?.({ state: "completed", name: "shell" });
    handlers.onDelta("done.");
    handlers.onThinking?.("let me think");
    await promise;

    const assistant = store.messages[store.messages.length - 1]!;
    expect(assistant.content).toBe("done.");
    expect(assistant.thinking).toBe("let me think");
    expect(assistant.progress).toEqual([
      { name: "shell", state: "completed" },
    ]);
  });

  it("records failed tools on the progress row when the agent reports an error", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const store = useChatStore();
    store.onAgentJoined({
      id: REMOTE_AGENT.alias,
      kind: "agent",
      name: REMOTE_AGENT.alias,
      logoUrl: REMOTE_AGENT.logo_url,
      agentId: REMOTE_AGENT.agent_id,
      capabilities: ["shell"],
    });

    const promise = store.send("deploy");
    const [, , handlers] = lastRemoteCall();
    handlers.onTool?.({ state: "started", name: "git", detail: "push" });
    handlers.onTool?.({ state: "failed", name: "git", detail: "push", ...{ error: "auth" } as { error: string } });
    await promise;

    expect(store.messages[store.messages.length - 1]!.progress).toEqual([
      { name: "git", state: "failed", detail: "push", error: "auth" },
    ]);
  });
});

const LOCAL_ATHENA = {
  id: "a1",
  alias: "Athena",
  agent_id: "agent-athena-local",
  owner_employee_id: "system",
  logo_url: "/athena-logo-ai.png",
  runtime: "server",
  api_url: "",
  status: "local",
  has_token: false,
  created_at: "",
  updated_at: "",
  capabilities: {
    system: "athena",
    mcp: ["llm_wiki"],
    tools: [],
    skills: [],
    specialty: "knowledge",
  },
};

describe("GlobalChatPanel add-agent picker (G4.S8.T13)", () => {
  function mountChat() {
    const pinia = createPinia();
    setActivePinia(pinia);
    return mount(GlobalChatPanel, {
      global: { plugins: [pinia, TDesign] },
    });
  }

  async function openAgentPicker(wrapper: ReturnType<typeof mountChat>) {
    await wrapper.find(".add-agent-entry").trigger("click");
    await flushPromises();
  }

  it("excludes an agent already in the chat, keyed canonically on agent_id", async () => {
    listAgentsMock.mockResolvedValue([
      LOCAL_ATHENA,
      { ...REMOTE_AGENT },
    ]);
    const wrapper = mountChat();
    const store = useChatStore();
    // A joined participant whose id does NOT match the registry alias (e.g.
    // restored from a persisted session) — only the canonical agent_id key
    // catches this; the old alias-vs-id comparison let the agent reappear.
    store.onAgentJoined({
      id: "athena-restored-session",
      kind: "agent",
      name: LOCAL_ATHENA.alias,
      logoUrl: LOCAL_ATHENA.logo_url,
      agentId: LOCAL_ATHENA.agent_id,
      capabilities: [],
    });

    await openAgentPicker(wrapper);
    const options = wrapper.findAll(".add-agent-picker .picker-option");
    expect(options).toHaveLength(1);
    expect(options[0]!.text()).toContain("RemoteHermes");

    // Add the remaining agent, close the picker, reopen — must not be listed again.
    await wrapper.find(".add-agent-picker .picker-option").trigger("click");
    await flushPromises();
    expect(store.participants.some((p) => p.agentId === "agent-hermes-1")).toBe(true);

    await openAgentPicker(wrapper);
    expect(wrapper.find(".add-agent-picker .picker-empty").exists()).toBe(true);
    wrapper.unmount();
  });

  it("still excludes a legacy participant that only carries the alias as its id", async () => {
    listAgentsMock.mockResolvedValue([LOCAL_ATHENA]);
    const wrapper = mountChat();
    const store = useChatStore();
    // Pre-agentId participants used the alias as their participant id.
    store.onAgentJoined({
      id: LOCAL_ATHENA.alias,
      kind: "agent",
      name: LOCAL_ATHENA.alias,
      logoUrl: LOCAL_ATHENA.logo_url,
      capabilities: [],
    });

    await openAgentPicker(wrapper);
    expect(wrapper.find(".add-agent-picker .picker-empty").exists()).toBe(true);
    wrapper.unmount();
  });

  it("refetches availableAgents on EVERY picker open (no load-once cache)", async () => {
    listAgentsMock.mockResolvedValue([REMOTE_AGENT]);
    const wrapper = mountChat();

    await openAgentPicker(wrapper);
    await wrapper.find(".add-agent-entry").trigger("click"); // close
    await openAgentPicker(wrapper);
    expect(listAgentsMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("refetches availableEmployees on EVERY employee picker open", async () => {
    listEmployeesMock.mockResolvedValue([
      { id: "e1", email: "a@caleo.com", display_name: "Ada", role: "member" },
    ]);
    const wrapper = mountChat();

    await wrapper.find(".add-employee-entry").trigger("click");
    await flushPromises();
    await wrapper.find(".add-employee-entry").trigger("click"); // close
    await wrapper.find(".add-employee-entry").trigger("click");
    await flushPromises();
    expect(listEmployeesMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("renders the seeded local Athena as online/local, not offline", async () => {
    listAgentsMock.mockResolvedValue([LOCAL_ATHENA]);
    const wrapper = mountChat();

    await openAgentPicker(wrapper);
    const option = wrapper.find(".add-agent-picker .picker-option");
    expect(option.exists()).toBe(true);
    expect(option.find(".picker-connectivity.is-live").exists()).toBe(true);
    expect(option.text()).toContain("Local");
    expect(option.text()).not.toContain("Offline");
    wrapper.unmount();
  });
});

describe("GlobalChatPanel remote agent (G4.S7.T4)", () => {
  function mountChat() {
    const pinia = createPinia();
    setActivePinia(pinia);
    return mount(GlobalChatPanel, {
      global: { plugins: [pinia, TDesign] },
    });
  }

  it("shows Live/Offline connectivity in the agent picker from the registry", async () => {
    listAgentsMock.mockResolvedValue([
      { ...REMOTE_AGENT, connected: true },
      { ...REMOTE_AGENT, id: "a3", alias: "IdleAgent", agent_id: "agent-idle", connected: false },
    ]);
    const wrapper = mountChat();
    await wrapper.find(".add-agent-entry").trigger("click");
    await flushPromises();

    const options = wrapper.findAll(".add-agent-picker .picker-option");
    expect(options).toHaveLength(2);
    expect(options[0]!.find(".picker-connectivity.is-live").exists()).toBe(true);
    expect(options[0]!.text()).toContain("Live");
    expect(options[1]!.text()).toContain("Offline");
    wrapper.unmount();
  });

  it("renders tool progress rows + thinking under the remote assistant bubble", async () => {
    streamChatMock.mockImplementation(
      async (_userId: string, _message: string, args: StreamArgs) => {
        args.onThinking?.("computing");
        args.onTool?.({ state: "started", name: "shell", detail: "build" });
        args.onTool?.({ state: "completed", name: "shell" });
        args.onDelta("built.");
        args.onTool?.({ state: "started", name: "deploy" });
      },
    );
    listAgentsMock.mockResolvedValue([{ ...REMOTE_AGENT, connected: true }]);
    const wrapper = mountChat();
    const store = useChatStore();

    await wrapper.find(".add-agent-entry").trigger("click");
    await flushPromises();
    await wrapper.find(".add-agent-picker .picker-option").trigger("click");
    await flushPromises();

    await wrapper.find(".composer-input textarea").setValue("deploy it");
    await wrapper.find(".send-button").trigger("click");
    await flushPromises();

    const assistant = wrapper.find(".message-row.assistant");
    expect(assistant.find(".tool-progress-row").exists()).toBe(true);
    expect(assistant.text()).toContain("shell");
    expect(assistant.text()).toContain("deploy");
    expect(assistant.find(".thinking-block").exists()).toBe(true);
    expect(assistant.find(".thinking-text").text()).toBe("computing");
    expect(store.messages[store.messages.length - 1]!.progress?.find((r) => r.name === "deploy")?.state).toBe("started");
    wrapper.unmount();
  });
});