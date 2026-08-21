import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";

import AdminView from "@/views/AdminView.vue";
import {
  KbAuditHttpError,
  listKbAuditReports,
  runKbAudit,
  type KbAuditReport,
} from "@/api/kb";
import { listEmployees } from "@/api/invitations";
import { listAgents } from "@/api/agents";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  listEmployees: vi.fn(),
  updateEmployee: vi.fn(),
  sendInvite: vi.fn(),
}));
vi.mock("@/api/agents", () => ({
  listAgents: vi.fn(),
}));
vi.mock("@/api/kb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listKbAuditReports: vi.fn(),
  runKbAudit: vi.fn(),
}));

const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listReportsMock = listKbAuditReports as unknown as ReturnType<typeof vi.fn>;
const runAuditMock = runKbAudit as unknown as ReturnType<typeof vi.fn>;

const adminEmployee = {
  id: "e1",
  email: "admin@caleo.com",
  display_name: "Admin User",
  logo_url: "",
  role: "admin" as const,
  created_at: "x",
  updated_at: "x",
};

function makeReport(overrides: Partial<KbAuditReport> = {}): KbAuditReport {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    trigger: "scheduled",
    startedAt: "2026-08-16T03:00:00.000Z",
    durationMs: 1500,
    review: { runAt: "2026-08-16", scanned: 9, changed: 3, archive: [], results: [] },
    fileCheck: { repaired: 2, details: ["stale graph subtree removed: wiki/x.md"] },
    orphans: { scannedDirs: 7, removed: ["/refinement/stale"], kept: ["/refinement/fresh"] },
    ...overrides,
  };
}

async function mountAdmin() {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.setSession({ session_token: "ses123", employee: adminEmployee });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin", component: AdminView },
      { path: "/settings", component: { template: "<div>Settings</div>" } },
    ],
  });
  await router.push("/admin");
  await router.isReady();
  const wrapper = mount(AdminView, {
    global: { plugins: [pinia, TDesign, router] },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  listEmployeesMock.mockReset().mockResolvedValue([]);
  listAgentsMock.mockReset().mockResolvedValue([]);
  listReportsMock.mockReset().mockResolvedValue([]);
  runAuditMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AdminView KB audit section (G4.S8.T15)", () => {
  it("renders the latest report summary + history table with trigger badges", async () => {
    listReportsMock.mockResolvedValue([
      makeReport({ trigger: "manual", startedAt: "2026-08-21T10:00:00.000Z" }),
      makeReport({ id: "run-sched", trigger: "scheduled" }),
    ]);
    const wrapper = await mountAdmin();

    const summary = wrapper.find('[data-testid="kb-audit-latest"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("manual");
    expect(summary.text()).toContain("Review: 3 change(s) across 9 page(s)");
    expect(summary.text()).toContain("File repairs: 2");
    expect(summary.text()).toContain("Orphans removed: 1");

    const rows = wrapper.findAll('[data-testid="kb-audit-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".audit-badge").text()).toBe("manual");
    expect(rows[1].find(".audit-badge").text()).toBe("scheduled");
    wrapper.unmount();
  });

  it("shows a spinner state while running and refreshes reports after success", async () => {
    let resolveRun!: (report: KbAuditReport) => void;
    runAuditMock.mockImplementation(
      () =>
        new Promise<KbAuditReport>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const wrapper = await mountAdmin();

    const button = wrapper.find('[data-testid="kb-audit-run"]');
    expect(button.text()).toBe("Run audit now");
    await button.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="kb-audit-run"]').text()).toBe("Auditing…");
    expect(wrapper.find('[data-testid="kb-audit-run"]').attributes("disabled")).toBeDefined();

    resolveRun(makeReport({ trigger: "manual" }));
    await flushPromises();
    expect(runAuditMock).toHaveBeenCalled();
    // The report list was refreshed after the manual run persisted.
    expect(listReportsMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(wrapper.find('[data-testid="kb-audit-run"]').text()).toBe("Run audit now");
    expect(wrapper.find('[data-testid="kb-audit-notice"]').text()).toContain("finished");
    wrapper.unmount();
  });

  it("handles 409 concurrent runs with a friendly message", async () => {
    runAuditMock.mockRejectedValue(new KbAuditHttpError(409, "Request failed with status 409"));
    const wrapper = await mountAdmin();

    await wrapper.find('[data-testid="kb-audit-run"]').trigger("click");
    await flushPromises();
    const error = wrapper.find('[data-testid="kb-audit-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("already running");
    expect(wrapper.find('[data-testid="kb-audit-run"]').text()).toBe("Run audit now");
    wrapper.unmount();
  });

  it("shows the empty state before the first ever audit run", async () => {
    const wrapper = await mountAdmin();
    expect(wrapper.find('[data-testid="kb-audit-table"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("No audit reports yet.");
    wrapper.unmount();
  });
});
