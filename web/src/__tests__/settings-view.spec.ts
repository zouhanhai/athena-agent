import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import SettingsView from "@/views/SettingsView.vue";
import { updateMe } from "@/api/invitations";
import {
  listLogos,
  listDeclarations,
  listAgents,
  getAgent,
  confirmAgent,
  updateAgent,
  registerDeclaration,
  createAgent,
  inviteAgent,
  uploadLogo,
} from "@/api/agents";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  updateMe: vi.fn(),
}));
vi.mock("@/api/agents", () => ({
  listLogos: vi.fn(),
  listDeclarations: vi.fn(),
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  confirmAgent: vi.fn(),
  updateAgent: vi.fn(),
  registerDeclaration: vi.fn(),
  createAgent: vi.fn(),
  inviteAgent: vi.fn(),
  uploadLogo: vi.fn(),
}));

const updateMeMock = updateMe as unknown as ReturnType<typeof vi.fn>;
const listLogosMock = listLogos as unknown as ReturnType<typeof vi.fn>;
const listDeclarationsMock = listDeclarations as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const getAgentMock = getAgent as unknown as ReturnType<typeof vi.fn>;
const confirmAgentMock = confirmAgent as unknown as ReturnType<typeof vi.fn>;
const updateAgentMock = updateAgent as unknown as ReturnType<typeof vi.fn>;
const registerDeclarationMock = registerDeclaration as unknown as ReturnType<typeof vi.fn>;
const createAgentMock = createAgent as unknown as ReturnType<typeof vi.fn>;
const inviteAgentMock = inviteAgent as unknown as ReturnType<typeof vi.fn>;
const uploadLogoMock = uploadLogo as unknown as ReturnType<typeof vi.fn>;

const employee = {
  id: "e1",
  email: "carol@caleo.com",
  display_name: "Carol",
  logo_url: "/logos/fox-clean.png",
  role: "member" as const,
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const adminEmployee = {
  ...employee,
  id: "a1",
  role: "admin" as const,
};

const logos = [
  { id: "l1", name: "fox", animal: "fox", color: "teal", url: "/logos/fox-clean.png", filename: "fox-clean.png", source: "generated" as const, created_at: "x" },
  { id: "l2", name: "wolf", animal: "wolf", color: "indigo", url: "/logos/wolf-indigo.png", filename: "wolf-indigo.png", source: "generated" as const, created_at: "x" },
];

const declaration = {
  id: "d1",
  agent_id: "opencode-ses_xyz",
  runtime: "local",
  capabilities: {
    system: "opencode",
    mcp: ["github"],
    tools: ["bash"],
    skills: ["code_review"],
    specialty: "software-engineering",
  },
  declared_at: "2026-08-08T00:00:00.000Z",
};

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.setSession({ session_token: "ses123", employee });
  const wrapper = mount(SettingsView, {
    global: { plugins: [pinia, TDesign] },
  });
  await flushPromises();
  return { wrapper, auth };
}

beforeEach(() => {
  listLogosMock.mockReset().mockResolvedValue(logos);
  listDeclarationsMock.mockReset().mockResolvedValue([]);
  listAgentsMock.mockReset().mockResolvedValue([]);
  getAgentMock.mockReset();
  confirmAgentMock.mockReset();
  updateAgentMock.mockReset();
  updateMeMock.mockReset();
  registerDeclarationMock.mockReset();
  createAgentMock.mockReset();
  inviteAgentMock.mockReset();
  uploadLogoMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SettingsView page", () => {
  it("renders a full page with Profile and Agents sections and no Theme section", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find(".settings-page").exists()).toBe(true);
    expect(wrapper.find(".settings-header").exists()).toBe(true);
    expect(wrapper.find(".settings-title").text()).toBe("Settings");
    expect(wrapper.find(".settings-section.profile").exists()).toBe(true);
    expect(wrapper.find(".settings-section.agents").exists()).toBe(true);
    // Theme settings live only in the sidebar ThemeToggle — never on the Settings page.
    expect(wrapper.find(".theme-option").exists()).toBe(false);
    expect(wrapper.find(".theme-options").exists()).toBe(false);
    // The page is not a dialog — no trigger button.
    expect(wrapper.find(".settings-trigger").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not render a page dialog wrapper (the delete dialog stays hidden)", async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find(".settings-trigger").exists()).toBe(false);
    // The agent-delete confirm dialog exists in the DOM but is NOT visible.
    expect(wrapper.find(".t-dialog--visible").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("SettingsView profile", () => {
  it("pre-fills the display name and selected logo from the signed-in employee", async () => {
    const { wrapper } = await mountView();

    expect(
      (wrapper.find(".settings-name").element as HTMLInputElement).value,
    ).toBe("Carol");
    const selected = wrapper.find(".logo-option.is-selected");
    expect(selected.attributes("data-url")).toBe("/logos/fox-clean.png");
    wrapper.unmount();
  });

  it("saves display name, logo and github credential via updateMe and refreshes the auth store", async () => {
    const { wrapper, auth } = await mountView();
    updateMeMock.mockResolvedValue({
      ...employee,
      display_name: "Carol C.",
      logo_url: "/logos/wolf-indigo.png",
    });

    await wrapper.find(".settings-name").setValue("Carol C.");
    const wolf = wrapper
      .findAll(".logo-option")
      .find((el) => el.attributes("data-url") === "/logos/wolf-indigo.png");
    await wolf!.trigger("click");
    await wrapper.find(".settings-github-value").setValue("ghp_supersecret");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol C.",
      logo_url: "/logos/wolf-indigo.png",
      github_credential: { type: "token", value: "ghp_supersecret" },
    });
    expect(auth.employee?.display_name).toBe("Carol C.");
    expect(auth.employee?.logo_url).toBe("/logos/wolf-indigo.png");
    wrapper.unmount();
  });

  it("offers only a personal access token for GitHub (no SSH option)", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find(".settings-github-type").exists()).toBe(false);
    expect(wrapper.findAll('option[value="ssh"]')).toHaveLength(0);
    const valueInput = wrapper.find(".settings-github-value");
    expect(valueInput.exists()).toBe(true);
    expect(valueInput.attributes("type")).toBe("password");
    wrapper.unmount();
  });

  it("always keeps the employee's current logo in the picker, selected, even when it is in-use", async () => {
    listLogosMock.mockResolvedValue([logos[1]]); // fox (current) is in-use; only wolf is available
    const { wrapper } = await mountView();

    expect(listLogosMock).toHaveBeenCalledWith({ excludeInUse: true });
    const urls = wrapper.findAll(".logo-option").map((el) => el.attributes("data-url"));
    expect(urls).toContain("/logos/fox-clean.png"); // current logo is kept despite being in-use
    expect(urls).toContain("/logos/wolf-indigo.png");
    const selected = wrapper.find(".logo-option.is-selected");
    expect(selected.attributes("data-url")).toBe("/logos/fox-clean.png");
    wrapper.unmount();
  });

  it("shows a partial github credential mask when a token is stored", async () => {
    const withCred = {
      ...employee,
      github_has_credential: true,
      github_credential_type: "token" as const,
      github_credential_masked: "ghp_abcd****wxyz",
    };
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: withCred });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();

    const valueInput = wrapper.find(".settings-github-value");
    expect((valueInput.element as HTMLInputElement).value).toBe("ghp_abcd****wxyz");
    wrapper.unmount();
  });

  it("replaces a stored credential when the user types a new token", async () => {
    const withCred = {
      ...employee,
      github_has_credential: true,
      github_credential_type: "token" as const,
      github_credential_masked: "ghp_abcd****wxyz",
    };
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: withCred });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();
    updateMeMock.mockResolvedValue(withCred);

    await wrapper.find(".settings-github-value").setValue("ghp_freshnewtok");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol",
      logo_url: "/logos/fox-clean.png",
      github_credential: { type: "token", value: "ghp_freshnewtok" },
    });
    wrapper.unmount();
  });

  it("does not overwrite a stored credential when the masked field is left untouched", async () => {
    const withCred = {
      ...employee,
      github_has_credential: true,
      github_credential_type: "token" as const,
      github_credential_masked: "ghp_abcd****wxyz",
    };
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: withCred });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();
    updateMeMock.mockResolvedValue(withCred);

    await wrapper.find(".settings-name").setValue("Carol C.");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol C.",
      logo_url: "/logos/fox-clean.png",
      github_credential: undefined,
    });
    wrapper.unmount();
  });

  it("uploads a custom logo via POST /api/logos and refreshes the picker", async () => {
    const newLogo = {
      id: "u1",
      name: "hermes",
      url: "/logos/uploads/1-hermes.png",
      filename: "1-hermes.png",
      source: "upload" as const,
      created_at: "x",
    };
    uploadLogoMock.mockResolvedValue(newLogo);
    const { wrapper } = await mountView();
    listLogosMock.mockResolvedValue([...logos, newLogo]);

    const input = wrapper.find("input.logo-upload-input");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "hermes.png", {
      type: "image/png",
    });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await flushPromises();

    expect(uploadLogoMock).toHaveBeenCalledWith(file);
    expect(listLogosMock).toHaveBeenLastCalledWith({ excludeInUse: true });
    const urls = wrapper.findAll(".logo-option").map((el) => el.attributes("data-url"));
    expect(urls).toContain("/logos/uploads/1-hermes.png");
    wrapper.unmount();
  });

  it("keeps the existing github credential when the field is left empty", async () => {
    const { wrapper } = await mountView();
    updateMeMock.mockResolvedValue(employee);

    await wrapper.find(".settings-name").setValue("Carol C.");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol C.",
      logo_url: "/logos/fox-clean.png",
      github_credential: undefined,
    });
    wrapper.unmount();
  });

  it("validates that a display name is required", async () => {
    const { wrapper } = await mountView();

    await wrapper.find(".settings-name").setValue("   ");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).not.toHaveBeenCalled();
    expect(wrapper.find(".settings-error").text()).toContain("Display name");
    wrapper.unmount();
  });

  it("surfaces the backend error when saving fails", async () => {
    const { wrapper } = await mountView();
    updateMeMock.mockRejectedValue(new Error("server down"));

    await wrapper.find(".settings-name").setValue("Carol C.");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(wrapper.find(".settings-error").text()).toContain("server down");
    wrapper.unmount();
  });

  it("hides the Profile section when there is no signed-in employee", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SettingsView, {
      global: { plugins: [pinia, TDesign] },
    });
    await flushPromises();

    expect(wrapper.find(".settings-name").exists()).toBe(false);
    expect(wrapper.find(".settings-section.profile").exists()).toBe(false);
    expect(wrapper.find(".agent-management").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("SettingsView agents", () => {
  it("renders pending agent declarations as rows that open the detail view", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    const { wrapper } = await mountView();

    expect(listDeclarationsMock).toHaveBeenCalled();
    // G4.S8.T13-era DOM: the accordion refactor moved the row toggle onto the
    // inner summary element.
    const row = wrapper.find(".agent-decl-row .agent-decl-summary");
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("opencode-ses_xyz");

    await row.trigger("click");
    await flushPromises();
    const detail = wrapper.find(".agent-detail");
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain("Review agent declaration");
    expect(detail.text()).toContain("opencode-ses_xyz");
    expect(detail.text()).toContain("software-engineering");
    expect(detail.text()).toContain("code_review");
    wrapper.unmount();
  });

  it("confirms a declaration registration from the detail view, closing it", async () => {
    listDeclarationsMock
      .mockResolvedValueOnce([declaration])
      .mockResolvedValue([]);
    registerDeclarationMock.mockResolvedValue({ id: "a1" });
    const { wrapper } = await mountView();

    await wrapper.find(".agent-decl-row .agent-decl-summary").trigger("click");
    await flushPromises();
    await wrapper.find(".decl-alias").setValue("Hermes");
    const fox = wrapper
      .findAll(".agent-detail .logo-option")
      .find((el) => el.attributes("data-url") === "/logos/fox-clean.png");
    await fox!.trigger("click");
    await wrapper.find(".detail-register").trigger("click");
    await flushPromises();

    // G4.S7.T9: the owner is an EMAIL (prefilled from the signed-in employee)
    // and api_url is no longer collected on the confirm page (reverse-WS).
    expect(registerDeclarationMock).toHaveBeenCalledWith("d1", {
      alias: "Hermes",
      owner_employee_id: "carol@caleo.com",
      logo_url: "/logos/fox-clean.png",
    });
    expect(wrapper.find(".agent-detail").exists()).toBe(false);
    expect(wrapper.findAll(".agent-decl-row")).toHaveLength(0);
    wrapper.unmount();
  });

  it("registers a declaration with alias, owner email and logo — no api_url (removed in G4.S7.T9)", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    registerDeclarationMock.mockResolvedValue({ id: "a1" });
    const { wrapper } = await mountView();

    await wrapper.find(".agent-decl-row .agent-decl-summary").trigger("click");
    await flushPromises();
    await wrapper.find(".decl-alias").setValue("Hermes");
    // The confirm form collects alias + owner + logo only; reachability is via
    // the reverse-WS tunnel, so there is no api_url input anymore.
    expect(wrapper.find(".decl-api-url").exists()).toBe(false);
    await wrapper.find(".detail-register").trigger("click");
    await flushPromises();

    expect(registerDeclarationMock).toHaveBeenCalledTimes(1);
    const [, payload] = registerDeclarationMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.alias).toBe("Hermes");
    expect(payload.owner_employee_id).toBe("carol@caleo.com");
    expect(payload.api_url).toBeUndefined();
    wrapper.unmount();
  });

  it("lists registered agents with their status badge", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        alias: "Hermes",
        agent_id: "agent-hermes",
        owner_employee_id: "e1",
        logo_url: "/logos/fox-clean.png",
        capabilities: { system: "opencode", mcp: [], tools: [], skills: [], specialty: "software-engineering" },
        runtime: "local",
        api_url: "http://hermes.local:3001",
        status: "reachable",
        has_token: true,
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
      },
    ]);
    const { wrapper } = await mountView();

    expect(listAgentsMock).toHaveBeenCalled();
    const row = wrapper.find(".agent-status-row");
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("Hermes");
    expect(wrapper.find(".status-badge.status-reachable").text()).toBe("reachable");
    expect(row.text()).toContain("http://hermes.local:3001");
    wrapper.unmount();
  });

  it("opens an agent detail view showing its declared capabilities", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        alias: "Hermes",
        agent_id: "agent-hermes",
        owner_employee_id: "e1",
        logo_url: "/logos/fox-clean.png",
        capabilities: {
          system: "hermes",
          mcp: ["sap", "github"],
          tools: ["code", "search"],
          skills: ["code_review"],
          specialty: "integration",
          tags: ["sap", "reporting"],
          examples: ["How is Q2 reporting structured?"],
        },
        runtime: "local",
        api_url: "http://hermes.local:3001",
        status: "reachable",
        has_token: true,
        capabilities_pending_review: false,
        connected: true,
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
      },
    ]);
    const { wrapper } = await mountView();

    await wrapper.find(".agent-status-row .agent-status-summary").trigger("click");
    await flushPromises();
    const detail = wrapper.find(".agent-detail");
    expect(detail.exists()).toBe(true);
    // Inline/accordion mode omits the identity block the summary row already
    // shows (alias, agent_id, connected chip) — capabilities + meta remain.
    expect(detail.text()).toContain("hermes");
    expect(detail.text()).toContain("sap");
    expect(detail.text()).toContain("github");
    expect(detail.text()).toContain("code");
    expect(detail.text()).toContain("code_review");
    expect(detail.text()).toContain("reporting");
    expect(detail.text()).toContain("How is Q2 reporting structured?");
    expect(detail.text()).toContain("http://hermes.local:3001");
    expect(detail.text()).toContain("Capabilities approved");
    wrapper.unmount();
  });

  it("confirms a pending-review agent from the detail view", async () => {
    listAgentsMock
      .mockResolvedValueOnce([
        {
          id: "a1",
          alias: "Hermes",
          agent_id: "agent-hermes",
          owner_employee_id: "e1",
          logo_url: "",
          capabilities: { system: "hermes", mcp: [], tools: ["deploy"], skills: [], specialty: "integration" },
          runtime: "local",
          api_url: "",
          status: "registered",
          has_token: false,
          capabilities_pending_review: true,
          created_at: "2026-08-08T00:00:00.000Z",
          updated_at: "2026-08-08T00:00:00.000Z",
        },
      ])
      .mockResolvedValue([
        {
          id: "a1",
          alias: "Hermes",
          agent_id: "agent-hermes",
          owner_employee_id: "e1",
          logo_url: "",
          capabilities: { system: "hermes", mcp: [], tools: ["deploy"], skills: [], specialty: "integration" },
          runtime: "local",
          api_url: "",
          status: "registered",
          has_token: false,
          capabilities_pending_review: false,
          created_at: "2026-08-08T00:00:00.000Z",
          updated_at: "2026-08-08T00:00:00.000Z",
        },
      ]);
    confirmAgentMock.mockResolvedValue({ id: "a1", capabilities_pending_review: false });
    const { wrapper } = await mountView();

    await wrapper.find(".agent-status-row .agent-status-summary").trigger("click");
    await flushPromises();
    expect(wrapper.find(".detail-review.is-pending").exists()).toBe(true);
    expect(wrapper.find(".detail-review").text()).toContain("review and confirm");

    await wrapper.find(".detail-confirm").trigger("click");
    await flushPromises();

    expect(confirmAgentMock).toHaveBeenCalledWith("agent-hermes", "ses123");
    expect(wrapper.find(".detail-review.is-pending").exists()).toBe(false);
    expect(wrapper.find(".detail-review").text()).toContain("Capabilities approved");
    wrapper.unmount();
  });

  it("edits the agent alias and logo from the detail view", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        alias: "Hermes",
        agent_id: "agent-hermes",
        owner_employee_id: "e1",
        logo_url: "/logos/fox-clean.png",
        capabilities: { system: "hermes", mcp: [], tools: ["deploy"], skills: [], specialty: "integration" },
        runtime: "local",
        api_url: "",
        status: "registered",
        has_token: false,
        capabilities_pending_review: false,
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
      },
    ]);
    updateAgentMock.mockResolvedValue({ id: "a1", alias: "Hermes-2" });
    const { wrapper } = await mountView();

    await wrapper.find(".agent-status-row .agent-status-summary").trigger("click");
    await flushPromises();
    await wrapper.find(".detail-edit-toggle").trigger("click");
    await wrapper.find(".detail-alias").setValue("Hermes-2");
    const wolf = wrapper
      .findAll(".detail-edit-form .logo-option")
      .find((el) => el.attributes("data-url") === "/logos/wolf-indigo.png");
    await wolf!.trigger("click");
    await wrapper.find(".detail-save").trigger("click");
    await flushPromises();

    expect(updateAgentMock).toHaveBeenCalledWith("Hermes", {
      alias: "Hermes-2",
      logo_url: "/logos/wolf-indigo.png",
    });
    wrapper.unmount();
  });

  it("sends the capabilities to the server when a capability is edited", async () => {
    listAgentsMock.mockResolvedValue([
      {
        id: "a1",
        alias: "Hermes",
        agent_id: "agent-hermes",
        owner_employee_id: "e1",
        logo_url: "/logos/fox-clean.png",
        capabilities: { system: "hermes", mcp: [], tools: ["deploy"], skills: [], specialty: "integration" },
        runtime: "local",
        api_url: "",
        status: "registered",
        has_token: false,
        capabilities_pending_review: false,
        created_at: "2026-08-08T00:00:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
      },
    ]);
    updateAgentMock.mockResolvedValue({ id: "a1", capabilities_pending_review: true });
    const { wrapper } = await mountView();

    await wrapper.find(".agent-status-row .agent-status-summary").trigger("click");
    await flushPromises();
    await wrapper.find(".detail-edit-toggle").trigger("click");
    await wrapper.find(".caps-mcp").setValue("sap, github");
    await wrapper.find(".detail-save").trigger("click");
    await flushPromises();

    expect(updateAgentMock).toHaveBeenCalledWith("Hermes", {
      capabilities: {
        system: "hermes",
        mcp: ["sap", "github"],
        tools: ["deploy"],
        skills: [],
        specialty: "integration",
      },
    });
    wrapper.unmount();
  });

  it("shows admin-only invite + register entries for admins only", async () => {
    const memberWrapper = await mountView();
    expect(memberWrapper.wrapper.find(".am-action").exists()).toBe(false);
    memberWrapper.wrapper.unmount();

    listAgentsMock.mockReset().mockResolvedValue([]);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: adminEmployee });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();

    const actions = wrapper.findAll(".am-action");
    expect(actions.some((el) => el.text().includes("Invite agent"))).toBe(true);
    expect(actions.some((el) => el.text().includes("Register agent"))).toBe(true);
    wrapper.unmount();
  });

  it("manual register form registers an agent with its api_url via createAgent", async () => {
    listAgentsMock.mockReset().mockResolvedValue([]);
    createAgentMock.mockResolvedValue({ id: "a1" });
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: adminEmployee });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();

    const registerButton = wrapper
      .findAll(".am-action")
      .find((el) => el.text().includes("Register agent"));
    await registerButton!.trigger("click");
    await wrapper.find("#manual-alias").setValue("Hermes");
    await wrapper.find("#manual-owner").setValue("zhang.wei");
    await wrapper.find("#manual-api-url").setValue("http://hermes.local:3001");
    await wrapper.find("form.am-form").trigger("submit");
    await flushPromises();

    expect(createAgentMock).toHaveBeenCalledWith({
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      api_url: "http://hermes.local:3001",
      runtime: undefined,
      capabilities: {
        system: "remote",
        mcp: [],
        tools: [],
        skills: [],
        specialty: "general",
      },
    });
    wrapper.unmount();
  });

  it("invite form shows the generated {agent_id, api_url, token} exactly once", async () => {
    listAgentsMock.mockReset().mockResolvedValue([]);
    inviteAgentMock.mockResolvedValue({
      agent: { id: "a1", alias: "wts", status: "invited" },
      invite: {
        agent_id: "agent-wts",
        api_url: "http://wts.local:3001",
        token: "tok_abc123",
      },
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.setSession({ session_token: "ses123", employee: adminEmployee });
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, TDesign] } });
    await flushPromises();

    const inviteButton = wrapper
      .findAll(".am-action")
      .find((el) => el.text().includes("Invite agent"));
    await inviteButton!.trigger("click");
    await wrapper.find("#invite-alias").setValue("wts");
    await wrapper.find("#invite-owner").setValue("owner@caleo.com");
    await wrapper.find("form.am-form").trigger("submit");
    await flushPromises();

    expect(inviteAgentMock).toHaveBeenCalledWith("ses123", {
      alias: "wts",
      owner_employee_id: "owner@caleo.com",
    });
    const result = wrapper.find(".invite-result");
    expect(result.exists()).toBe(true);
    expect(result.text()).toContain("agent-wts");
    expect(result.text()).toContain("tok_abc123");
    wrapper.unmount();
  });
});
