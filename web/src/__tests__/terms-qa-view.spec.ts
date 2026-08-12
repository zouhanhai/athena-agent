import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import TermsQaView from "@/views/TermsQaView.vue";
import {
  listSemanticMappings,
  addSemanticMapping,
  deleteSemanticMapping,
  addManualQa,
  deleteQaPair,
} from "@/api/kb";
import { listQaPairs } from "@/api/feedback";

vi.mock("@/api/kb", () => ({
  listSemanticMappings: vi.fn(),
  addSemanticMapping: vi.fn(),
  deleteSemanticMapping: vi.fn(),
  addManualQa: vi.fn(),
  deleteQaPair: vi.fn(),
  searchKnowledge: vi.fn(),
  searchKnowledgeFull: vi.fn(),
  getGraph: vi.fn(),
  getGraphTopics: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  ingestFile: vi.fn(),
  ingestUrl: vi.fn(),
  getTask: vi.fn(),
  retryTask: vi.fn(),
}));

vi.mock("@/api/feedback", () => ({
  listQaPairs: vi.fn(),
  sendFeedback: vi.fn(),
}));

const listMappingsMock = listSemanticMappings as unknown as ReturnType<typeof vi.fn>;
const addMappingMock = addSemanticMapping as unknown as ReturnType<typeof vi.fn>;
const deleteMappingMock = deleteSemanticMapping as unknown as ReturnType<typeof vi.fn>;
const addManualMock = addManualQa as unknown as ReturnType<typeof vi.fn>;
const deletePairMock = deleteQaPair as unknown as ReturnType<typeof vi.fn>;
const listPairsMock = listQaPairs as unknown as ReturnType<typeof vi.fn>;

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/terms-qa", component: TermsQaView }],
  });
  await router.push("/terms-qa");
  await router.isReady();
  const wrapper = mount(TermsQaView, {
    global: { plugins: [createPinia(), TDesign, router] },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  listMappingsMock.mockResolvedValue([]);
  listPairsMock.mockResolvedValue([]);
  addMappingMock.mockResolvedValue({ id: "m1", term: "C-Day", canonical: "CALEO Day" });
  addManualMock.mockResolvedValue({ action: "inserted", pair: { id: "p1" } });
  deleteMappingMock.mockResolvedValue(true);
  deletePairMock.mockResolvedValue(true);
});

describe("TermsQaView", () => {
  it("loads and lists semantic mappings + Q&A pairs on mount", async () => {
    listMappingsMock.mockResolvedValue([
      { id: "m1", term: "C-Day", canonical: "CALEO Day", created_at: "", updated_at: "" },
    ]);
    listPairsMock.mockResolvedValue([
      {
        id: "p1",
        question: "What is C-Day?",
        answer: "C-Day is the CALEO Day.",
        sources: [],
        feedback: "up",
        created_at: "",
        updated_at: "",
      },
    ]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("Terms & QA");
    expect(wrapper.text()).toContain("C-Day");
    expect(wrapper.text()).toContain("CALEO Day");
    expect(wrapper.text()).toContain("What is C-Day?");
    expect(wrapper.text()).toContain("C-Day is the CALEO Day.");
  });

  it("adds a semantic mapping and refreshes the list", async () => {
    listMappingsMock.mockResolvedValue([
      { id: "m1", term: "HW", canonical: "Haushaltswaren", created_at: "", updated_at: "" },
    ]);
    const wrapper = await mountView();

    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("HW");
    await inputs[1]!.setValue("Haushaltswaren");
    const addButton = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Add mapping"))!;
    await addButton.trigger("click");
    await flushPromises();

    expect(addMappingMock).toHaveBeenCalledWith("HW", "Haushaltswaren");
    expect(wrapper.text()).toContain("Haushaltswaren");
  });

  it("deletes a semantic mapping", async () => {
    listMappingsMock.mockResolvedValue([
      { id: "m1", term: "C-Day", canonical: "CALEO Day", created_at: "", updated_at: "" },
    ]);
    const wrapper = await mountView();

    const deleteButton = wrapper.findAll("button").find((b) => b.text().includes("Delete"))!;
    await deleteButton.trigger("click");
    await flushPromises();

    expect(deleteMappingMock).toHaveBeenCalledWith("m1");
  });

  it("adds a manual Q&A pair", async () => {
    const wrapper = await mountView();
    const inputs = wrapper.findAll("input");
    await inputs[3]!.setValue("Who founded CALEO?");
    const textarea = wrapper.find("textarea");
    await textarea.setValue("The founders did.");
    const addButton = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Add Q&A"))!;
    await addButton.trigger("click");
    await flushPromises();

    expect(addManualMock).toHaveBeenCalledWith({
      question: "Who founded CALEO?",
      answer: "The founders did.",
    });
  });

  it("shows the merge/overwrite/add-anyway dialog when a similar Q&A exists", async () => {
    addManualMock
      .mockResolvedValueOnce({
        action: "needs_decision",
        pair: null,
        similar: { id: "p1", question: "What is C-Day?", score: 0.93 },
      })
      .mockResolvedValueOnce({ action: "merged", pair: { id: "p1" } });
    listPairsMock.mockResolvedValue([
      {
        id: "p1",
        question: "What is C-Day?",
        answer: "C-Day is the CALEO Day.",
        sources: [],
        feedback: null,
        created_at: "",
        updated_at: "",
      },
    ]);
    const wrapper = await mountView();

    const inputs = wrapper.findAll("input");
    await inputs[3]!.setValue("What is C Day?");
    await wrapper.find("textarea").setValue("A new answer.");
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Add Q&A"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Similar Q&A already exists");
    const dialogButton = wrapper.findAll("button").find((b) => b.text().includes("Merge answers"))!;
    await dialogButton.trigger("click");
    await flushPromises();

    expect(addManualMock).toHaveBeenLastCalledWith({
      question: "What is C Day?",
      answer: "A new answer.",
      mode: "merge",
    });
  });

  it("deletes a Q&A pair", async () => {
    listPairsMock.mockResolvedValue([
      {
        id: "p1",
        question: "What is C-Day?",
        answer: "C-Day is the CALEO Day.",
        sources: [],
        feedback: "up",
        created_at: "",
        updated_at: "",
      },
    ]);
    const wrapper = await mountView();

    const deleteButton = wrapper.findAll("button").find((b) => b.text().includes("Delete"))!;
    await deleteButton.trigger("click");
    await flushPromises();

    expect(deletePairMock).toHaveBeenCalledWith("p1");
  });
});
