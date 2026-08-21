import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import AdminView from "@/views/AdminView.vue";
import {
  listEmployees,
  updateEmployee,
  sendInvite,
  type EmployeeRecord,
} from "@/api/invitations";
import { listAgents, type AgentRecord } from "@/api/agents";
import { listKbAuditReports, type KbAuditReport } from "@/api/kb";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  listEmployees: vi.fn(),
  updateEmployee: vi.fn(),
  sendInvite: vi.fn(),
}));
vi.mock("@/api/agents", () => ({
  listAgents: vi.fn(),
}));
vi.mock("@/api/kb", () => ({
  KbAuditHttpError: class KbAuditHttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  listKbAuditReports: vi.fn(),
  runKbAudit: vi.fn(),
}));

const listKbAuditReportsMock = listKbAuditReports as unknown as ReturnType<typeof vi.fn>;

const emptyReport: KbAuditReport = {
  id: "run-1",
  trigger: "scheduled",
  startedAt: "2026-08-16T03:00:00.000Z",
  durationMs: 1200,
  review: { runAt: "2026-08-16", scanned: 5, changed: 2, archive: [], results: [] },
  fileCheck: { repaired: 1, details: [] },
  orphans: { scannedDirs: 4, removed: ["/r/stale"], kept: [] },
};

const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;
const updateEmployeeMock = updateEmployee as unknown as ReturnType<typeof vi.fn>;
const sendInviteMock = sendInvite as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;

const employees: EmployeeRecord[] = [
  {
    id: "e1",
    email: "admin@caleo.com",
    display_name: "Admin User",
    logo_url: "/logos/fox-clean.png",
    role: "admin",
    permissions: [],
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  },
  {
    id: "e2",
    email: "member@caleo.com",
    display_name: "Member User",
    logo_url: "/logos/wolf-indigo.png",
    role: "member",
    permissions: ["kb.edit"],
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  },
  {
    id: "e3",
    email: "plain@caleo.com",
    display_name: "Plain Member",
    logo_url: "/logos/hare-clean.png",
    role: "member",
    permissions: [],
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  },
];

const agents: AgentRecord[] = [
  {
    id: "a1",
    alias: "Hermes",
    agent_id: "agent-hermes",
    owner_employee_id: "e2",
    logo_url: "/logos/hare.png",
    capabilities: { system: "opencode", mcp: [], tools: [], skills: [], specialty: "x" },
    runtime: "local",
    api_url: "http://hermes.local:3001",
    status: "reachable",
    has_token: true,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  },
];

const adminEmployee: EmployeeRecord = {
  id: "e1",
  email: "admin@caleo.com",
  display_name: "Admin User",
  logo_url: "/logos/fox-clean.png",
  role: "admin",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const memberEmployee: EmployeeRecord = {
  id: "e9",
  email: "member@caleo.com",
  display_name: "Member User",
  logo_url: "/logos/wolf-indigo.png",
  role: "member",
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

async function makeRouter(initial = "/admin") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin", component: AdminView },
      { path: "/settings", component: { template: "<div>Settings</div>" } },
    ],
  });
  await router.push(initial);
  await router.isReady();
  return router;
}

async function mountView(role: "admin" | "member" = "admin") {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.setSession({
    session_token: "ses123",
    employee: role === "admin" ? adminEmployee : memberEmployee,
  });
  const router = await makeRouter();
  const wrapper = mount(AdminView, {
    global: { plugins: [pinia, TDesign, router] },
  });
  await flushPromises();
  return { wrapper, auth, router };
}

beforeEach(() => {
  listEmployeesMock.mockReset().mockResolvedValue(employees);
  updateEmployeeMock.mockReset();
  sendInviteMock.mockReset();
  listAgentsMock.mockReset().mockResolvedValue(agents);
  listKbAuditReportsMock.mockReset().mockResolvedValue([emptyReport]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AdminView employee list (G4.S3.T11)", () => {
  it("renders one row per employee with role control + kb.edit switch", async () => {
    const { wrapper } = await mountView();
    expect(listEmployeesMock).toHaveBeenCalledWith("ses123");
    const rows = wrapper.findAll(".employee-row");
    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(first.text()).toContain("Admin User");
    expect(first.find(".employee-role").exists()).toBe(true);
    expect(first.find(".perm-toggle input").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the kb.edit switch checked for a member granted kb.edit", async () => {
    const { wrapper } = await mountView();
    const member = wrapper.findAll(".employee-row")[1];
    expect((member.find(".perm-toggle input").element as HTMLInputElement).checked).toBe(true);
    wrapper.unmount();
  });

  it("changes a role via PUT /api/employees/:email", async () => {
    const { wrapper } = await mountView();
    updateEmployeeMock.mockResolvedValue({ ...employees[1], role: "admin" });
    const member = wrapper.findAll(".employee-row")[1];
    const select = member.find(".employee-role");
    await select.setValue("admin");
    await flushPromises();
    expect(updateEmployeeMock).toHaveBeenCalledWith("ses123", "member@caleo.com", {
      role: "admin",
    });
    wrapper.unmount();
  });

  it("grants kb.edit to a member without it (switch on)", async () => {
    const { wrapper } = await mountView();
    updateEmployeeMock.mockResolvedValue({ ...employees[2], permissions: ["kb.edit"] });
    const plain = wrapper.findAll(".employee-row")[2];
    const input = plain.find(".perm-toggle input");
    await input.setValue(true);
    await flushPromises();
    expect(updateEmployeeMock).toHaveBeenCalledWith("ses123", "plain@caleo.com", {
      permissions: ["kb.edit"],
    });
    wrapper.unmount();
  });

  it("revokes kb.edit from a granted member (switch off)", async () => {
    const { wrapper } = await mountView();
    updateEmployeeMock.mockResolvedValue({ ...employees[1], permissions: [] });
    const member = wrapper.findAll(".employee-row")[1];
    const input = member.find(".perm-toggle input");
    await input.setValue(false);
    await flushPromises();
    expect(updateEmployeeMock).toHaveBeenCalledWith("ses123", "member@caleo.com", {
      permissions: [],
    });
    wrapper.unmount();
  });

  it("expands a row to reveal the agents the employee owns, grouped by owner", async () => {
    const { wrapper } = await mountView();
    expect(listAgentsMock).toHaveBeenCalled();
    const member = wrapper.findAll(".employee-row")[1];
    await member.find(".employee-top").trigger("click");
    await flushPromises();
    const sub = wrapper.find(".agent-sub");
    expect(sub.exists()).toBe(true);
    expect(sub.text()).toContain("Hermes");
    // The admin row (no owned agents) shows an empty state when expanded.
    const admin = wrapper.findAll(".employee-row")[0];
    await admin.find(".employee-top").trigger("click");
    await flushPromises();
    const adminSub = wrapper.findAll(".agent-sub").find((el) => el.text().includes("No agents owned"));
    expect(adminSub).toBeDefined();
    wrapper.unmount();
  });

  it("surfaces a load error when the employee list fails", async () => {
    listEmployeesMock.mockRejectedValue(new Error("server down"));
    const { wrapper } = await mountView();
    expect(wrapper.find(".admin-error").text()).toContain("server down");
    wrapper.unmount();
  });
});

describe("AdminView invites (G4.S3.T11)", () => {
  it("generates an invite link and shows a copy button + TTL note", async () => {
    sendInviteMock.mockResolvedValue({
      ok: true,
      inviteUrl: "http://localhost:5173/register?token=abc",
      expiresInMs: 604800000,
    });
    const { wrapper } = await mountView();
    expect(wrapper.find(".admin-hint").text()).toContain("7 days");
    await wrapper.find(".invite-input").setValue("carol@caleo.com");
    await wrapper.find(".invite-button").trigger("click");
    await flushPromises();
    expect(sendInviteMock).toHaveBeenCalledWith("carol@caleo.com");
    const link = wrapper.find(".invite-link");
    expect(link.text()).toBe("http://localhost:5173/register?token=abc");
    expect(wrapper.find(".copy-button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("copies the generated link via the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    sendInviteMock.mockResolvedValue({
      ok: true,
      inviteUrl: "http://localhost:5173/register?token=abc",
      expiresInMs: 604800000,
    });
    const { wrapper } = await mountView();
    await wrapper.find(".invite-input").setValue("carol@caleo.com");
    await wrapper.find(".invite-button").trigger("click");
    await flushPromises();
    await wrapper.find(".copy-button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("http://localhost:5173/register?token=abc");
    expect(wrapper.find(".copy-button").text()).toBe("Copied!");
    wrapper.unmount();
  });

  it("surfaces an invite error and requires an email", async () => {
    const { wrapper } = await mountView();
    await wrapper.find(".invite-button").trigger("click");
    await flushPromises();
    expect(sendInviteMock).not.toHaveBeenCalled();
    expect(wrapper.find(".admin-error").text()).toContain("email");

    sendInviteMock.mockRejectedValue(new Error("already an employee"));
    await wrapper.find(".invite-input").setValue("member@caleo.com");
    await wrapper.find(".invite-button").trigger("click");
    await flushPromises();
    expect(wrapper.find(".admin-error").text()).toContain("already an employee");
    wrapper.unmount();
  });
});

describe("AdminView guard (G4.S3.T11)", () => {
  it("hides the admin body and redirects a member away", async () => {
    const { wrapper, router } = await mountView("member");
    expect(wrapper.find(".admin-body").exists()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.currentRoute.value.path).toBe("/settings");
    wrapper.unmount();
  });
});
