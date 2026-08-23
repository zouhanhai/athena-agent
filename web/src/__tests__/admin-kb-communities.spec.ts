import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";

import AdminView from "@/views/AdminView.vue";
import {
  KbAuditHttpError,
  listKbAuditReports,
  recomputeCommunities,
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
  recomputeCommunities: vi.fn(),
}));

const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listReportsMock = listKbAuditReports as unknown as ReturnType<typeof vi.fn>;
const runAuditMock = runKbAudit as unknown as ReturnType<typeof vi.fn>;
const recomputeMock = recomputeCommunities as unknown as ReturnType<typeof vi.fn>;

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
    fileCheck: { repaired: 2, details: [] },
    orphans: { scannedDirs: 7, removed: [], kept: [] },
    ...overrides,
  };
}

function makeCommunitiesReport(): KbAuditReport {
  return makeReport({
    id: "run-manual-comm",
    trigger: "manual",
    communities: {
      communities: 4,
      entitiesPerCommunity: [
        { id: "c_caleo", size: 5 },
        { id: "c_bcs", size: 3 },
      ],
      largestCommunity: { id: "c_caleo", size: 5 },
      changedSinceLast: 6,
      entitiesWithoutCommunity: 1,
      summariesPresent: 3,
      summariesTotal: 4,
      summariesRefreshed: 2,
      summariesUnchanged: 2,
    },
  });
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
  recomputeMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AdminView knowledge-graph community maintenance (G4.S9.T4)", () => {
  it("renders the Recompute communities button and runs it synchronously with a running state", async () => {
    let resolveRecompute!: (report: KbAuditReport) => void;
    recomputeMock.mockImplementation(
      () =>
        new Promise<KbAuditReport>((resolve) => {
          resolveRecompute = resolve;
        }),
    );
    const wrapper = await mountAdmin();

    const button = wrapper.find('[data-testid="kb-communities-recompute"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe("Recompute communities");

    await button.trigger("click");
    await flushPromises();
    expect(recomputeMock).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="kb-communities-recompute"]').text()).toBe(
      "Recomputing…",
    );

    resolveRecompute(makeCommunitiesReport());
    await flushPromises();
    // The shared report history was refreshed after the manual run persisted.
    expect(listReportsMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(wrapper.find('[data-testid="kb-communities-recompute"]').text()).toBe(
      "Recompute communities",
    );
    expect(wrapper.find('[data-testid="kb-communities-notice"]').text()).toContain(
      "recomputed",
    );
    wrapper.unmount();
  });

  it("surfaces a friendly message when another recompute is running (409)", async () => {
    recomputeMock.mockRejectedValue(new KbAuditHttpError(409, "Request failed with status 409"));
    const wrapper = await mountAdmin();

    await wrapper.find('[data-testid="kb-communities-recompute"]').trigger("click");
    await flushPromises();
    const error = wrapper.find('[data-testid="kb-communities-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("already running");
    wrapper.unmount();
  });

  it("shows community counts in the latest summary and a Communities column in the shared history", async () => {
    listReportsMock.mockResolvedValue([
      makeCommunitiesReport(),
      makeReport({ id: "run-weekly" }),
    ]);
    const wrapper = await mountAdmin();

    const latest = wrapper.find('[data-testid="kb-audit-latest"]');
    expect(latest.text()).toContain("Communities: 4");
    expect(latest.text()).toContain("largest c_caleo (5)");
    expect(latest.text()).toContain("without community: 1");
    expect(latest.text()).toContain("summaries 3/4");

    const rows = wrapper.findAll('[data-testid="kb-audit-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("4");
    expect(rows[0].text()).toContain("+6");
    // A row without a communities block shows an em dash placeholder.
    expect(rows[1].text()).toContain("—");
    wrapper.unmount();
  });

  it("hides the community summary lines before any community-bearing run exists", async () => {
    listReportsMock.mockResolvedValue([makeReport()]);
    const wrapper = await mountAdmin();

    expect(wrapper.find('[data-testid="kb-audit-latest"]').text()).not.toContain(
      "Communities:",
    );
    wrapper.unmount();
  });
});
