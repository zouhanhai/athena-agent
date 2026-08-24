import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";

import AdminView from "@/views/AdminView.vue";
import {
  listKbAuditReports,
  type KbAuditReport,
  type KbRelinkReport,
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
}));

const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listReportsMock = listKbAuditReports as unknown as ReturnType<typeof vi.fn>;

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
    startedAt: "2026-08-23T03:00:00.000Z",
    durationMs: 1500,
    review: { runAt: "2026-08-23", scanned: 9, changed: 3, archive: [], results: [] },
    fileCheck: { repaired: 2, details: [] },
    orphans: { scannedDirs: 7, removed: [], kept: [] },
    ...overrides,
  };
}

function makeRelink(): KbRelinkReport {
  return {
    trigger: "weekly",
    scannedEntities: 42,
    candidateCount: 5,
    llmCalls: 2,
    mergesApplied: 1,
    unmergedCount: 2,
    newEdgesCreated: 1,
    incrementalEntities: 3,
    merges: [
      { from: "CALEO Group", to: "CALEO", similarity: 0.96, evidence: "same group" },
    ],
    unmergedCandidates: [
      { a: "SAP", b: "BTP", similarity: 0.86, reasons: ["vector"] },
    ],
    newEdges: [
      {
        source: "CALEO",
        target: "ZOB München",
        relation: "HAS_OFFICE",
        evidence_quote: "q",
      },
    ],
    errors: [],
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
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AdminView weekly full-graph re-link report (G4.S10.T3)", () => {
  it("shows the re-link summary counts and a Re-link column in the shared history", async () => {
    listReportsMock.mockResolvedValue([
      makeReport({ relink: makeRelink() }),
      makeReport({ id: "run-plain" }),
    ]);
    const wrapper = await mountAdmin();

    // Latest-run summary line with cost + coverage observability.
    const summary = wrapper.find('[data-testid="kb-relink-summary"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("5 candidate(s)");
    expect(summary.text()).toContain("1 merge(s)");
    expect(summary.text()).toContain("1 new edge(s)");
    expect(summary.text()).toContain("2 unmerged");
    expect(summary.text()).toContain("2 LLM call(s)");

    // History table column; rows without the block show an em dash.
    const rows = wrapper.findAll('[data-testid="kb-audit-table"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("5c · 1m · 1e");
    expect(rows[1].text()).toContain("—");
    wrapper.unmount();
  });

  it("renders the drill-in details alongside the community-quality section", async () => {
    listReportsMock.mockResolvedValue([
      makeReport({
        relink: makeRelink(),
        communities: {
          communities: 4,
          entitiesPerCommunity: [{ id: "c_caleo", size: 5 }],
          largestCommunity: { id: "c_caleo", size: 5 },
          entitiesWithoutCommunity: 0,
          summariesPresent: 4,
          summariesTotal: 4,
        },
      }),
    ]);
    const wrapper = await mountAdmin();

    const latest = wrapper.find('[data-testid="kb-audit-latest"]');
    expect(latest.text()).toContain("Communities: 4");

    const details = wrapper.find('[data-testid="kb-relink-details"]');
    expect(details.exists()).toBe(true);
    expect(details.text()).toContain("Weekly re-link (weekly)");
    expect(details.text()).toContain("CALEO Group → CALEO");
    expect(details.text()).toContain("similarity 0.96");
    expect(details.text()).toContain("SAP ↔ BTP");
    expect(details.text()).toContain("CALEO -[HAS_OFFICE]-> ZOB München");
    wrapper.unmount();
  });

  it("hides every re-link surface before any re-link-bearing run exists", async () => {
    listReportsMock.mockResolvedValue([makeReport()]);
    const wrapper = await mountAdmin();

    expect(wrapper.find('[data-testid="kb-relink-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="kb-relink-details"]').exists()).toBe(false);
    const rows = wrapper.findAll('[data-testid="kb-audit-table"] tbody tr');
    expect(rows[0].text()).toContain("—");
    wrapper.unmount();
  });

  it("surfaces re-link errors inside the drill-in block", async () => {
    const relink = makeRelink();
    relink.errors = ["incremental provenance read failed: neo4j down"];
    listReportsMock.mockResolvedValue([makeReport({ relink })]);
    const wrapper = await mountAdmin();

    expect(wrapper.find('[data-testid="kb-relink-details"]').text()).toContain(
      "neo4j down",
    );
    wrapper.unmount();
  });
});
