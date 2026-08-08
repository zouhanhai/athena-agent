import { describe, expect, it, vi, afterEach } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KnowledgeView from "@/views/KnowledgeView.vue";
import { getGraph, getGraphTopics } from "@/api/kb";
import {
  buildTypeColors,
  localSubgraph,
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

/** A graph with a reachable cluster (n1-n2-n3) plus an isolated node (n4), so a
 *  1-2 hop local subgraph is provably smaller than the whole graph. */
const clusterGraph: KnowledgeGraph = {
  nodes: [
    { id: "n1", label: "Alpha", type: "concept" },
    { id: "n2", label: "Beta", type: "org" },
    { id: "n3", label: "Gamma" },
    { id: "n4", label: "Delta" },
  ],
  edges: [
    { source: "n1", target: "n2", weight: 1 },
    { source: "n2", target: "n3" },
  ],
};

afterEach(() => {
  getGraphMock.mockReset();
  getGraphTopicsMock.mockReset();
});

describe("graph mapping helpers", () => {
  it("maps LightRAG nodes/edges to the v-network-graph format", () => {
    const view = mapKnowledgeGraph(sampleGraph);
    expect(Object.keys(view.nodes)).toEqual(["n1", "n2", "n3"]);
    expect(view.nodes.n1).toEqual({ name: "Alpha", type: "concept", size: 14 });
    expect(view.nodes.n2).toEqual({ name: "Beta", type: "org", size: 14 });
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

  it("extracts a node's 1-2 hop neighborhood, excluding unrelated nodes", () => {
    const sub = localSubgraph(clusterGraph, "n1", 2);
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
    expect(sub.edges).toEqual([
      { source: "n1", target: "n2", weight: 1 },
      { source: "n2", target: "n3" },
    ]);
  });

  it("keeps only edges between included nodes, honoring the hop limit", () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
        { id: "e", label: "E" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "d", target: "e" },
      ],
    };
    const oneHop = localSubgraph(graph, "a", 1);
    expect(oneHop.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(oneHop.edges).toEqual([{ source: "a", target: "b" }]);

    const twoHop = localSubgraph(graph, "a", 2);
    expect(twoHop.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(twoHop.edges).toEqual([
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ]);
  });

  it("returns just the root when it has no relations", () => {
    const sub = localSubgraph(clusterGraph, "n4", 2);
    expect(sub.nodes.map((n) => n.id)).toEqual(["n4"]);
    expect(sub.edges).toEqual([]);
  });
});

describe("KnowledgeView default view", () => {
  it("loads topics on mount but does NOT auto-load the full graph", async () => {
    getGraphTopicsMock.mockResolvedValue(["ops", "sommerseminar"]);
    const { wrapper } = await mountView();
    await flushPromises();

    expect(getGraphTopicsMock).toHaveBeenCalledTimes(1);
    expect(getGraphMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Explore the knowledge graph");
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the topic options in the filter select", async () => {
    getGraphTopicsMock.mockResolvedValue(["ops", "sommerseminar"]);
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    expect(select.exists()).toBe(true);
    expect(select.props("options")).toEqual([
      { label: "ops", value: "ops" },
      { label: "sommerseminar", value: "sommerseminar" },
    ]);
    wrapper.unmount();
  });
});

describe("KnowledgeView topic filter", () => {
  it("re-fetches the graph scoped to the selected topic", async () => {
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    getGraphMock.mockResolvedValue({ nodes: [sampleGraph.nodes[0]!], edges: [] });
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();

    expect(getGraphMock).toHaveBeenLastCalledWith(undefined, "sommerseminar");
    const stub = graphStub(wrapper);
    expect(stub.exists()).toBe(true);
    expect(Object.keys(stub.props("nodes") ?? {})).toEqual(["n1"]);
    expect(wrapper.text()).toContain("Showing 1 entities");
    wrapper.unmount();
  });

  it("returns to the explore prompt when the topic is cleared", async () => {
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    getGraphMock.mockResolvedValue(sampleGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();
    await select.vm.$emit("update:modelValue", "");
    await select.vm.$emit("clear");
    await flushPromises();

    expect(wrapper.text()).toContain("Explore the knowledge graph");
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the error message when the topic graph fetch fails", async () => {
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    getGraphMock.mockRejectedValue(new Error("lightrag down"));
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();

    expect(wrapper.find(".knowledge-error").text()).toContain("lightrag down");
    wrapper.unmount();
  });
});

describe("KnowledgeView node search (local graph)", () => {
  async function search(wrapper: ViewMount["wrapper"], query: string) {
    const input = wrapper.find(".knowledge-search-input input");
    await input.setValue(query);
    const buttons = wrapper.findAll("button");
    const searchBtn = buttons.find((b) => b.text().includes("Search"));
    await searchBtn!.trigger("click");
    await flushPromises();
  }

  it("searches a node and shows only its local neighborhood, not the whole graph", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "Alpha");

    expect(getGraphMock).toHaveBeenCalledWith("Alpha");
    const stub = graphStub(wrapper);
    expect(stub.exists()).toBe(true);
    expect(Object.keys(stub.props("nodes") ?? {})).toEqual(["n1", "n2", "n3"]);
    expect(wrapper.text()).toContain('local graph for "Alpha"');
    expect(wrapper.text()).toContain("3 entities");
    wrapper.unmount();
  });

  it("searches with the topic filter cleared first", async () => {
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();
    await search(wrapper, "Beta");

    expect(getGraphMock).toHaveBeenLastCalledWith("Beta");
    expect(wrapper.text()).toContain('local graph for "Beta"');
    wrapper.unmount();
  });

  it("renders node-local meta with a single separator (middle-dot rationed)", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "Alpha");

    const meta = wrapper.find(".knowledge-meta");
    expect(meta.text()).toBe('local graph for "Alpha" · 3 entities, 2 links');
    expect(meta.text().split("·")).toHaveLength(2);
    wrapper.unmount();
  });

  it("shows a message when no node matches the search", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "Ghost");

    expect(wrapper.find(".knowledge-error").text()).toContain('No node named "Ghost"');
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the error when the node lookup fails", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockRejectedValue(new Error("search down"));
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "boom");

    expect(wrapper.find(".knowledge-error").text()).toContain("search down");
    wrapper.unmount();
  });

  it("returns to the explore prompt when the node search is cleared", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    await search(wrapper, "Alpha");
    expect(graphStub(wrapper).exists()).toBe(true);

    const searchInput = wrapper
      .findAllComponents({ name: "TInput" })
      .find((c) => c.classes().includes("knowledge-search-input"));
    await searchInput!.vm.$emit("clear");
    await flushPromises();

    expect(wrapper.text()).toContain("Explore the knowledge graph");
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("KnowledgeView node click", () => {
  it("focuses the graph on the clicked node's 1-2 hop neighborhood", async () => {
    getGraphTopicsMock.mockResolvedValue(["sommerseminar"]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    const select = wrapper.findComponent({ name: "TSelect" });
    await select.vm.$emit("update:modelValue", "sommerseminar");
    await select.vm.$emit("change", "sommerseminar");
    await flushPromises();
    expect(graphStub(wrapper).props("nodes")).toHaveProperty("n4");

    await graphStub(wrapper).trigger("click");
    await flushPromises();

    const stub = graphStub(wrapper);
    expect(Object.keys(stub.props("nodes") ?? {})).toEqual(["n1", "n2", "n3"]);
    expect(stub.props("nodes")).not.toHaveProperty("n4");
    const detail = wrapper.find(".knowledge-detail");
    expect(detail.exists()).toBe(true);
    expect(detail.text()).toContain("Alpha");
    expect(detail.text()).toContain("concept");
    expect(detail.text()).toContain("Beta");
    wrapper.unmount();
  });

  it("shows the detail panel when a node is clicked in a node-local view", async () => {
    getGraphTopicsMock.mockResolvedValue([]);
    getGraphMock.mockResolvedValue(clusterGraph);
    const { wrapper } = await mountView();
    await flushPromises();

    const input = wrapper.find(".knowledge-search-input input");
    await input.setValue("Alpha");
    const buttons = wrapper.findAll("button");
    const searchBtn = buttons.find((b) => b.text().includes("Search"));
    await searchBtn!.trigger("click");
    await flushPromises();

    await graphStub(wrapper).trigger("click");
    await flushPromises();

    expect(wrapper.find(".knowledge-detail").text()).toContain("Alpha");
    wrapper.unmount();
  });
});
