import { describe, expect, it, vi, afterEach } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import KnowledgeView from "@/views/KnowledgeView.vue";
import { getGraph } from "@/api/kb";
import {
  buildTypeColors,
  mapKnowledgeGraph,
  nodeRelations,
} from "@/kb/graph";
import type { KnowledgeGraph } from "@/api/kb";

vi.mock("@/api/kb", () => ({
  getGraph: vi.fn(),
  getWikiTree: vi.fn(),
  readWikiPage: vi.fn(),
  searchKnowledge: vi.fn(),
}));

const getGraphMock = getGraph as unknown as ReturnType<typeof vi.fn>;

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

function mountView() {
  return mount(KnowledgeView, {
    global: {
      plugins: [createPinia(), TDesign],
      stubs: { VNetworkGraph: GraphStub },
    },
  });
}

function graphStub(wrapper: ReturnType<typeof mountView>) {
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
    const wrapper = mountView();
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
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("No knowledge graph yet");
    expect(graphStub(wrapper).exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the error message when fetching fails", async () => {
    getGraphMock.mockRejectedValue(new Error("lightrag down"));
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find(".knowledge-error").text()).toContain("lightrag down");
    wrapper.unmount();
  });

  it("shows entity details when a node is clicked", async () => {
    getGraphMock.mockResolvedValue(sampleGraph);
    const wrapper = mountView();
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
