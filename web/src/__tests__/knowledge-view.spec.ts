import { describe, expect, it, vi, afterEach } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KnowledgeView from "@/views/KnowledgeView.vue";
import { getGraph, getGraphTopics, searchKnowledge } from "@/api/kb";
import {
  buildTypeColors,
  mapKnowledgeGraph,
  nodeRelations,
} from "@/kb/graph";
import type { KnowledgeGraph } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getGraphTopics: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  searchKnowledge: vi.fn(),
  ingestFile: vi.fn(),
  ingestUrl: vi.fn(),
  getTask: vi.fn(),
}));

const getGraphMock = getGraph as unknown as ReturnType<typeof vi.fn>;
const getGraphTopicsMock = getGraphTopics as unknown as ReturnType<typeof vi.fn>;
const searchKnowledgeMock = searchKnowledge as unknown as ReturnType<typeof vi.fn>;

const GraphStub = defineComponent({
  name: "VNetworkGraph",
  props: {
    nodes: { type: Object, default: () => ({}) },
    edges: { type: Object, default: () => ({}) },
    configs: { type: Object, default: () => ({}) },
    layouts: { type: Object, default: () => ({}) },
    selectedNodes: { type: Array, default: () => [] },
    eventHandlers: { type: Object, default: () => ({}) },
  },
  setup(props, { expose }) {
    expose({ fitToContents: vi.fn() });
    return () =>
      h("div", {
        class: "graph-stub",
        "data-node-count": Object.keys(props.nodes).length,
        onClick: () => props.eventHandlers?.["node:click"]?.({ node: "n1" }),
      });
  },
});

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/knowledge", component: KnowledgeView },
      { path: "/wiki", component: { template: "<div />" } },
    ],
  });
  await router.push("/knowledge");
  await router.isReady();
  const wrapper = mount(KnowledgeView, {
    global: {
      plugins: [createPinia(), TDesign, router],
      stubs: { VNetworkGraph: GraphStub },
    },
  });
  return { wrapper, router };
}

type ViewMount = Awaited<ReturnType<typeof mountView>>;

function graphStub(wrapper: ViewMount["wrapper"]) {
  return wrapper.findComponent(GraphStub);
}

const sampleGraph: KnowledgeGraph = {
  nodes: [
    { id: "n1", label: "Alpha", type: "concept" },
    { id: "n2", label: "Beta", type: "org" },
    { id: "n3", label: "Gamma" },
  ],
  edges: [
    { source: "n1", target: "n2", weight: 1 },
    { source: "n2", target: "n3" },
  ],
};

afterEach(() => {
  getGraphMock.mockReset();
  getGraphTopicsMock.mockReset();
  searchKnowledgeMock.mockReset();
});

describe("graph mapping helpers", () => {
  it("maps LightRAG nodes/edges to the v-network-graph format", () => {
    const view = mapKnowledgeGraph(sampleGraph);
    expect(Object.keys(view.nodes)).toEqual(["n1", "n2", "n3"]);
    expect(view.nodes.n1).toEqual({ name: "Alpha", type: "concept" });
    expect(view.nodes.n2).toEqual({ name: "Beta", type: "org" });
    expect(view.edges.e0).toEqual({ source: "n1", target: "n2" });
    expect(view.edges.e1).toEqual({ source: "n2", target: "n3" });
  });

  it("skips nodes without an id and edges without endpoints", () => {
    const view = mapKnowledgeGraph({
      nodes: [{ label: "orphan" }, { id: "ok", label: "OK" }],
      edges: [{ source: "a" }, { source: "x", target: "y" }],
    });
    expect(Object.keys(view.nodes)).toEqual(["ok"]);
    expect(Object.keys(view.edges)).toEqual(["e0"]);
  });

  it("builds per-type colors deterministically from a palette", () => {
    const palette = ["#ff6633", "#69b3e7"];
    const colors = buildTypeColors(["concept", "org", "concept"], palette);
    expect(colors).toEqual({ concept: "#ff6633", org: "#69b3e7" });
  });

  it("computes incoming/outgoing relations for a node", () => {
    const relations = nodeRelations(sampleGraph, "n2");
    expect(relations.incoming).toEqual([{ other: "n1", weight: 1 }]);
    expect(relations.outgoing).toEqual([{ other: "n3" }]);
  });
});

describe("KnowledgeView", () => {
  it("fetches the graph on mount and passes mapped nodes/edges to the graph", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(getGraphMock).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".knowledge-title").text()).toContain("Knowledge Graph");
    const stub = graphStub(wrapper);
    expect(stub.exists()).toBe(true);
    expect(Object.keys(stub.props("nodes") ?? {})).toEqual(["n1", "n2", "n3"]);
    expect(Object.keys(stub.props("edges") ?? {})).toEqual(["e0", "e1"]);
    wrapper.unmount();
  });

  it("shows a friendly empty state when there are no entities", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("No knowledge graph yet");
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the error message when fetching fails", async () => {
    getGraphMock.mockRejectedValue(new Error("lightrag down"));
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.find(".knowledge-error").text()).toContain("lightrag down");
    wrapper.unmount();
  });

  it("shows entity details when a node is clicked", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    await graphStub(wrapper).trigger("click");
    await flushPromises();

    const detail = wrapper.find(".knowledge-detail");
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain("Alpha");
    expect(detail.text()).toContain("concept");
    expect(detail.text()).toContain("Beta");
    wrapper.unmount();
  });
});

describe("KnowledgeView topic filter", () => {
  it("loads the topic list on mount and renders it in the select", async () => {
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    getGraphTopicsMock.mockResolvedValue(["ops", "sommerseminar"]);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(getGraphTopicsMock).toHaveBeenCalledTimes(1);
    const select = wrapper.findComponent({ name: "TSelect" });
    expect(select.exists()).toBe(true);
    expect(select.props("options")).toEqual([
      { label: "ops", value: "ops" },
      { label: "sommerseminar", value: "sommerseminar" },
    ]);
    wrapper.unmount();
  });

  it("re-fetches the graph with the selected topic and shows the filtered note", async () => {
    getGraphMock
      .mockResolvedValueOnce({ nodes: sampleGraph.nodes, edges: sampleGraph.edges })
      .mockResolvedValueOnce({
        nodes: [sampleGraph.nodes[0]!],
        edges: [],
      });
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();

    expect(getGraphMock).toHaveBeenLastCalledWith(undefined, "sommerseminar");
    expect(wrapper.text()).toContain("Showing 1 of 3 entities");
    wrapper.unmount();
  });

  it("shows the full-graph meta when no topic is selected", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    getGraphTopicsMock.mockResolvedValue([]);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("3 entities · 2 links");
    wrapper.unmount();
  });
});

describe("KnowledgeView search", () => {
  async function search(wrapper: ViewMount["wrapper"], query: string) {
    const input = wrapper.find('.knowledge-search-input input');
    await input.setValue(query);
    const buttons = wrapper.findAll("button");
    const searchBtn = buttons.find((b) => b.text().includes("Search"));
    await searchBtn!.trigger("click");
    await flushPromises();
  }

  it("searches and renders results with source badges", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    searchKnowledgeMock.mockResolvedValue([
      { source: "lightrag", title: "RAG summary", snippet: "semantic answer" },
      { source: "llmwiki", title: "Runbook", snippet: "Incident process", path: "docs/runbook.md", score: 0.9 },
    ]);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "incidents");

    expect(searchKnowledgeMock).toHaveBeenCalledWith("incidents");
    expect(wrapper.find(".search-results").exists()).toBe(true);
    expect(wrapper.text()).toContain('2 results for "incidents"');
    expect(wrapper.text()).toContain("RAG summary");
    expect(wrapper.text()).toContain("Runbook");
    expect(wrapper.text()).toContain("semantic answer");
    wrapper.unmount();
  });

  it("navigates to the wiki page when a wiki result is clicked", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    searchKnowledgeMock.mockResolvedValue([
      { source: "llmwiki", title: "Runbook", snippet: "Incident", path: "docs/runbook.md" },
    ]);
    const { wrapper, router } = await mountView();
    await flushPromises();

    await search(wrapper, "runbook");
    await wrapper.find(".search-result-item").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/wiki?path=docs/runbook.md");
    wrapper.unmount();
  });

  it("shows an empty message when no results are found", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    searchKnowledgeMock.mockResolvedValue([]);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "zzz");

    expect(wrapper.text()).toContain("No results found.");
    wrapper.unmount();
  });

  it("shows the error when the search fails", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    searchKnowledgeMock.mockRejectedValue(new Error("search down"));
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "boom");

    expect(wrapper.find(".search-results").text()).toContain("search down");
    wrapper.unmount();
  });

  it("returns to the graph view when cleared", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    searchKnowledgeMock.mockResolvedValue([
      { source: "llmwiki", title: "Runbook", snippet: "Incident", path: "a.md" },
    ]);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "runbook");
    const backBtn = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Back to graph"));
    await backBtn!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".search-results").exists()).toBe(false);
    expect(graphStub(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });
});
