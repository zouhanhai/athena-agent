import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";
import CodeBrowserView from "@/views/CodeBrowserView.vue";
import { deleteWikiDoc, getCodeObject, listCodeObjects } from "@/api/kb";
import type { CodeObjectDetail, CodeObjectEntity } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  deleteWikiDoc: vi.fn(),
  getCodeObject: vi.fn(),
  listCodeObjects: vi.fn(),
}));

const listMock = listCodeObjects as unknown as ReturnType<typeof vi.fn>;
const getMock = getCodeObject as unknown as ReturnType<typeof vi.fn>;
const deleteMock = deleteWikiDoc as unknown as ReturnType<typeof vi.fn>;

const sampleEntities: CodeObjectEntity[] = [
  { name: "FICOMPUTE", type: "abap_unit", description: "ABAP function module" },
  { name: "ZCL_FI_DELIVERY", type: "abap_unit", description: "ABAP class" },
  { name: "ZCL_MM_GOODS", type: "abap_unit", description: "ABAP class" },
  { name: "I_CNSLDTN", type: "cds_view", description: "CDS view" },
  { name: "MARA", type: "table", description: "SAP table" },
];

const sampleDetail: CodeObjectDetail = {
  name: "FICOMPUTE",
  type: "abap_unit",
  description: "ABAP function module",
  outgoing: [{ keywords: ["READS_FROM"], entity: "MARA", type: "table", wikiPaths: [] }],
  incoming: [
    {
      keywords: ["CALLS"],
      entity: "ZCL_FI_DELIVERY",
      type: "abap_unit",
      wikiPaths: ["wiki/code/dev/zcl_fi_delivery.md"],
    },
    { keywords: ["CALLS"], entity: "ZCL_MM_GOODS", type: "abap_unit", wikiPaths: [] },
  ],
};

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/code-browser", component: CodeBrowserView },
      { path: "/wiki", component: { template: "<div>wiki</div>" } },
    ],
  });
  await router.push("/code-browser");
  await router.isReady();
  const pinia = createPinia();
  const wrapper = mount(CodeBrowserView, {
    global: { plugins: [pinia, TDesign, router] },
  });
  return { wrapper, router };
}

afterEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  deleteMock.mockReset();
});

describe("CodeBrowserView", () => {
  it("renders a group collapse + entity list grouped by type", async () => {
    listMock.mockResolvedValue(sampleEntities);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("ABAP Unit");
    expect(wrapper.text()).toContain("CDS View");
    expect(wrapper.text()).toContain("Table");
    expect(wrapper.text()).toContain("FICOMPUTE");
    expect(wrapper.findAll('[data-testid="cb-entity"]').length).toBe(5);
    wrapper.unmount();
  });

  it("filters the list by a search query (debounced)", async () => {
    vi.useFakeTimers();
    listMock.mockResolvedValue([{ name: "ZCL_FI_DELIVERY", type: "abap_unit", description: "ABAP class" }]);
    const { wrapper } = await mountView();
    await flushPromises();

    const input = wrapper.find('[data-testid="cb-search"] input');
    await input.setValue("zcl_");
    vi.advanceTimersByTime(300);
    await flushPromises();

    expect(listMock).toHaveBeenLastCalledWith({ q: "zcl_", limit: 200 });
    vi.useRealTimers();
    wrapper.unmount();
  });

  it("shows an explicit empty state when there are no objects (graph not configured / no data)", async () => {
    listMock.mockResolvedValue([]);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.find('[data-testid="cb-empty-state"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("No code objects yet");
    wrapper.unmount();
  });

  it("shows the error message when the list fetch fails", async () => {
    listMock.mockRejectedValue(new Error("neo4j down"));
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.find(".cb-error").exists()).toBe(true);
    expect(wrapper.text()).toContain("neo4j down");
    wrapper.unmount();
  });

  it("renders the selected object's Uses + Used by with keywords and labels", async () => {
    listMock.mockResolvedValue(sampleEntities);
    getMock.mockResolvedValue(sampleDetail);
    const { wrapper } = await mountView();
    await flushPromises();

    const ent = wrapper.findAll('[data-testid="cb-entity"]').find((b) => b.text().includes("FICOMPUTE"))!;
    await ent.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="cb-detail"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("FICOMPUTE");
    const uses = wrapper.find('[data-testid="cb-uses"]');
    expect(uses.text()).toContain("READS_FROM");
    expect(uses.text()).toContain("MARA");
    const usedBy = wrapper.find('[data-testid="cb-used-by"]');
    expect(usedBy.text()).toContain("CALLS");
    expect(usedBy.text()).toContain("ZCL_FI_DELIVERY");
    expect(usedBy.text()).toContain("ZCL_MM_GOODS");
    wrapper.unmount();
  });

  it("deep-links to the wiki page when a wiki path resolves, plain otherwise", async () => {
    listMock.mockResolvedValue(sampleEntities);
    getMock.mockResolvedValue(sampleDetail);
    const { wrapper, router } = await mountView();
    await flushPromises();

    const ent = wrapper.findAll('[data-testid="cb-entity"]').find((b) => b.text().includes("FICOMPUTE"))!;
    await ent.trigger("click");
    await flushPromises();

    // Used-by ZCL_FI_DELIVERY has a wiki page → a link.
    const link = wrapper.find('[data-testid="cb-link"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toContain("ZCL_FI_DELIVERY");
    await link.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/wiki");
    expect(router.currentRoute.value.query.path).toBe("wiki/code/dev/zcl_fi_delivery.md");

    // The MARA use + ZCL_MM_GOODS caller have no wiki page → plain text, no link.
    expect(wrapper.findAll('[data-testid="cb-link-plain"]').length).toBe(2);
    wrapper.unmount();
  });

  it("shows the detail loading state then the error on a failed detail fetch", async () => {
    listMock.mockResolvedValue(sampleEntities);
    getMock.mockRejectedValue(new Error("entity down"));
    const { wrapper } = await mountView();
    await flushPromises();

    const ent = wrapper.findAll('[data-testid="cb-entity"]').find((b) => b.text().includes("FICOMPUTE"))!;
    await ent.trigger("click");
    await flushPromises();

    expect(wrapper.find(".cb-error").exists()).toBe(true);
    expect(wrapper.text()).toContain("entity down");
    wrapper.unmount();
  });

  it("offers a delete action only for entries whose page resolves and deletes the PAGE (never the entity)", async () => {
    listMock.mockResolvedValue(sampleEntities);
    getMock.mockResolvedValue(sampleDetail);
    deleteMock.mockResolvedValue({ ok: true });
    const confirm = vi.fn().mockReturnValue(true);
    Object.assign(window, { confirm });
    const { wrapper } = await mountView();
    await flushPromises();

    const ent = wrapper.findAll('[data-testid="cb-entity"]').find((b) => b.text().includes("FICOMPUTE"))!;
    await ent.trigger("click");
    await flushPromises();

    // Only the wiki-page-backed relation (ZCL_FI_DELIVERY) gets a delete button.
    const buttons = wrapper.findAll('[data-testid="cb-delete-page"]');
    expect(buttons).toHaveLength(1);

    await buttons[0].trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("wiki/code/dev/zcl_fi_delivery.md"));
    expect(deleteMock).toHaveBeenCalledWith("wiki/code/dev/zcl_fi_delivery.md");
    // After delete both list + detail refresh.
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Declining the confirm never calls the API.
    confirm.mockReturnValue(false);
    getMock.mockResolvedValue(sampleDetail);
    await wrapper.findAll('[data-testid="cb-delete-page"]')[0].trigger("click");
    await flushPromises();
    expect(deleteMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("surfaces a delete failure without losing the current detail", async () => {
    listMock.mockResolvedValue(sampleEntities);
    getMock.mockResolvedValue(sampleDetail);
    deleteMock.mockRejectedValue(new Error("delete failed"));
    Object.assign(window, { confirm: () => true });
    const { wrapper } = await mountView();
    await flushPromises();

    const ent = wrapper.findAll('[data-testid="cb-entity"]').find((b) => b.text().includes("FICOMPUTE"))!;
    await ent.trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="cb-delete-page"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="cb-delete-error"]').text()).toContain("delete failed");
    expect(wrapper.find('[data-testid="cb-detail"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
