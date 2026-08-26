import { describe, expect, it, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import HeaderReviewEditor from "@/components/HeaderReviewEditor.vue";

const api = vi.hoisted(() => ({
  getHeaderReviewOutline: vi.fn(),
  putHeaderReviewDraft: vi.fn(),
  approveHeaderReview: vi.fn(),
  skipHeaderReview: vi.fn(),
  assistHeaderReview: vi.fn(),
  getHeaderReviewSettings: vi.fn(),
}));

vi.mock("@/api/kb", () => api);

/** Build a fixture outline: root "Intro" with n children "Field k". */
function outlineWith(cards: unknown[]): Record<string, unknown> {
  return {
    taskId: "t1",
    state: "pending",
    headingCount: cards.length + 1,
    cards: [
      { id: "h0", index: 0, text: "Intro", originalLevel: 1, originalOrder: 0, originalParentId: null, bold: false, parentId: null, order: 0, level: 1 },
      ...cards,
    ],
    draft: null,
    changes: 0,
  };
}

const SMALL = outlineWith([
  { id: "h1", index: 1, text: "Purpose", originalLevel: 2, originalOrder: 0, originalParentId: "h0", bold: false, parentId: "h0", order: 0, level: 2 },
  { id: "h2", index: 2, text: "Prerequisites", originalLevel: 2, originalOrder: 1, originalParentId: "h0", bold: false, parentId: "h0", order: 1, level: 2 },
  { id: "h3", index: 3, text: "Related Information", originalLevel: 2, originalOrder: 2, originalParentId: "h0", bold: false, parentId: "h0", order: 2, level: 2 },
]);

/** A 2000-card outline (virtualization exercise). */
function bigOutline(): Record<string, unknown> {
  const cards: unknown[] = [];
  for (let i = 1; i <= 2000; i++) {
    cards.push({
      id: `h${i}`,
      index: i,
      text: `Field ${i}`,
      originalLevel: 2,
      originalOrder: i - 1,
      originalParentId: "h0",
      bold: false,
      parentId: "h0",
      order: i - 1,
      level: 2,
    });
  }
  return outlineWith(cards);
}

beforeEach(() => {
  api.getHeaderReviewOutline.mockClear();
  api.putHeaderReviewDraft.mockClear();
  api.approveHeaderReview.mockClear();
  api.skipHeaderReview.mockClear();
  api.assistHeaderReview.mockClear();
  api.getHeaderReviewSettings.mockClear();
  api.getHeaderReviewOutline.mockResolvedValue(SMALL);
  api.putHeaderReviewDraft.mockImplementation(async (_taskId: string, ops: unknown[]) => ({
    ops,
    cards: SMALL.cards,
    changes: ops.length,
    updatedAt: Date.now(),
  }));
  api.approveHeaderReview.mockResolvedValue({ ok: true, edits: { ops: 0, bold: 0, moves: 0, levels: 0 }, changes: 0 });
  api.skipHeaderReview.mockResolvedValue({ ok: true });
  api.assistHeaderReview.mockResolvedValue({ suggestions: [] });
  api.getHeaderReviewSettings.mockResolvedValue({
    enabled: true,
    minHeaders: 8,
    templateWords: ["Purpose", "Prerequisites", "Related Information"],
  });
});

function mountEditor() {
  const wrapper = mount(HeaderReviewEditor, {
    props: { taskId: "t1", source: "doc.pdf" },
    attachTo: document.body,
  });
  return wrapper;
}

describe("HeaderReviewEditor", () => {
  it("renders one card per detected heading (level chip + title)", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="hr-card-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hr-card-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hr-card-3"]').text()).toContain("Related Information");
    expect(wrapper.find('[data-testid="hr-changes"]').text()).toContain("changes: 0");
  });

  it("level +/- buttons send draft ops and update the changes badge", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    // demote the SECOND card (Purpose) — the demote button inside its row
    const demote = wrapper.find('[data-card-id="1"] [data-testid="hr-demote"]');
    await demote.trigger("click");
    await nextTick();
    expect(api.putHeaderReviewDraft).toHaveBeenCalledWith("t1", [{ type: "demote", index: 1 }]);
    expect(wrapper.find('[data-testid="hr-changes"]').text()).toContain("changes: 1");
    const undo = wrapper.find('[data-testid="hr-undo"]');
    await undo.trigger("click");
    await nextTick();
    // undo sends the previous (empty) op history
    const lastCall = api.putHeaderReviewDraft.mock.calls.at(-1) as unknown[];
    expect(lastCall![1]).toEqual([]);
  });

  it("keyboard shortcuts move among siblings (Alt+ArrowDown)", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    await wrapper.find('[data-testid="hr-card-1"]').trigger("click");
    await wrapper.find('[data-testid="hr-viewport"]').trigger("keydown", { key: "ArrowDown", altKey: true });
    await nextTick();
    const lastCall = api.putHeaderReviewDraft.mock.calls.at(-1) as unknown[];
    const ops = lastCall![1] as Array<{ type: string; index: number; position: number }>;
    expect(ops[0].type).toBe("move");
    expect(ops[0].index).toBe(1);
    expect(ops[0].position).toBe(2); // after "Prerequisites"
  });

  it("virtualizes 2000+ cards (only a window is rendered)", async () => {
    api.getHeaderReviewOutline.mockResolvedValue(bigOutline());
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    const rendered = wrapper.findAll('[data-testid^="hr-card-"]');
    expect(rendered.length).toBeLessThan(120);
    // 2001 rows × 36px
    expect(wrapper.find('[data-testid="hr-viewport"]').find(".hr-spacer").attributes("style")).toContain("72036px");
  });

  it("search filters rows and jumps to the next match", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    const search = wrapper.find('[data-testid="hr-search"]');
    await search.setValue("Prerequisite");
    await nextTick();
    expect(wrapper.find('[data-testid="hr-card-2"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hr-card-1"]').exists()).toBe(false);
  });

  it("bulk template demotion previews matches and applies bold ops", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    await wrapper.find('[data-testid="hr-bulk"]').trigger("click");
    await nextTick();
    expect(wrapper.find('[data-testid="hr-bulk-panel"]').exists()).toBe(true);
    await wrapper.find('[data-testid="hr-bulk-preview"]').trigger("click");
    await nextTick();
    const matches = wrapper.findAll(".hr-bulk-match");
    expect(matches.length).toBe(3); // Purpose, Prerequisites, Related Information
    await wrapper.find('[data-testid="hr-bulk-apply"]').trigger("click");
    await nextTick();
    const lastCall = api.putHeaderReviewDraft.mock.calls.at(-1) as unknown[];
    const ops = lastCall![1] as Array<{ type: string; index: number }>;
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.type === "bold")).toBe(true);
  });

  it("Athena assist returns chips that apply ONLY on click (never auto-applied)", async () => {
    api.assistHeaderReview.mockResolvedValue({
      suggestions: [
        { kind: "demote-to-bold", targetIds: ["1"], reason: "template field Purpose" },
        { kind: "set-level", targetIds: ["2"], level: 3, reason: "misleveled" },
      ],
    });
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    await wrapper.find('[data-testid="hr-assist"]').trigger("click");
    await nextTick();
    await nextTick();
    expect(api.putHeaderReviewDraft).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([{ type: "bold", index: 1 }]),
    );
    const chips = wrapper.findAll('[data-testid="hr-apply-chip"]');
    expect(chips.length).toBe(2);
    await chips[0]!.trigger("click");
    await nextTick();
    const lastCall = api.putHeaderReviewDraft.mock.calls.at(-1) as unknown[];
    expect(lastCall![1]).toContainEqual({ type: "bold", index: 1 });
    expect(wrapper.findAll('[data-testid="hr-apply-chip"]')[0]!.text()).toContain("applied");
  });

  it("skip resolves through the endpoint (confirm stub)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "prompt").mockReturnValue("hartmut");
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    await wrapper.find('[data-testid="hr-skip"]').trigger("click");
    await nextTick();
    expect(api.skipHeaderReview).toHaveBeenCalledWith("t1");
    expect(wrapper.emitted().resolved).toEqual([["skip"]]);
  });

  it("approve resolves with the recorded reviewer name", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "prompt").mockReturnValue("hartmut");
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    await wrapper.find('[data-testid="hr-approve"]').trigger("click");
    await nextTick();
    expect(api.approveHeaderReview).toHaveBeenCalledWith("t1", "hartmut");
    expect(wrapper.emitted().resolved).toEqual([["approve"]]);
  });

  it("tree preview toggles and shows the live hierarchy", async () => {
    const wrapper = mountEditor();
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="hr-preview"]').exists()).toBe(false);
    await wrapper.find('[data-testid="hr-preview-toggle"]').trigger("click");
    await nextTick();
    const preview = wrapper.find('[data-testid="hr-preview"]');
    expect(preview.exists()).toBe(true);
    expect(preview.text()).toContain("Intro");
    expect(preview.text()).toContain("Purpose");
  });
});