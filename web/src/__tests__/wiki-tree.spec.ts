import { describe, expect, it } from "vitest";

import { flattenPages, buildViewTree } from "@/kb/wiki-tree";
import type { WikiPage } from "@/kb/wiki-tree";
import type { WikiTreeNode } from "@/api/kb";

const physicalTree: WikiTreeNode[] = [
  {
    name: "sommerseminar",
    path: "sommerseminar",
    isDir: true,
    children: [
      { name: "s1.md", path: "sommerseminar/s1.md", isDir: false, type: "concept", topic: "sommerseminar" },
      { name: "s2.md", path: "sommerseminar/s2.md", isDir: false, type: "concept", topic: "sommerseminar" },
    ],
  },
  {
    name: "sap",
    path: "sap",
    isDir: true,
    children: [
      { name: "f1.md", path: "sap/f1.md", isDir: false, type: "concept", topic: "sap/fiori" },
      { name: "h1.md", path: "sap/h1.md", isDir: false, type: "concept", topic: "sap/s4hana" },
    ],
  },
  {
    name: "concepts",
    path: "concepts",
    isDir: true,
    children: [
      { name: "e1.md", path: "concepts/e1.md", isDir: false, type: "entity" },
    ],
  },
];

const flat: WikiPage[] = [
  { path: "sommerseminar/s1.md", name: "s1.md", type: "concept", topic: "sommerseminar" },
  { path: "sommerseminar/s2.md", name: "s2.md", type: "concept", topic: "sommerseminar" },
  { path: "sap/f1.md", name: "f1.md", type: "concept", topic: "sap/fiori" },
  { path: "sap/h1.md", name: "h1.md", type: "concept", topic: "sap/s4hana" },
  { path: "concepts/e1.md", name: "e1.md", type: "entity" },
];

describe("flattenPages", () => {
  it("flattens the physical tree into a page list", () => {
    expect(flattenPages(physicalTree)).toEqual(flat);
  });

  it("skips system pages (index/overview/log)", () => {
    const tree: WikiTreeNode[] = [
      { name: "index.md", path: "index.md", isDir: false },
      { name: "a.md", path: "a.md", isDir: false },
    ];
    expect(flattenPages(tree).map((p) => p.path)).toEqual(["a.md"]);
  });
});

describe("buildViewTree topic view", () => {
  it("groups pages by topic and renders slash paths as nested folders", () => {
    const tree = buildViewTree(flat, "topic");
    const names = tree.map((n) => n.name);
    expect(names).toEqual(["sap", "sommerseminar", "Untagged"]);

    const sap = tree.find((n) => n.name === "sap")!;
    const sub = sap.children!.map((n) => n.name);
    expect(sub).toEqual(["fiori", "s4hana"]);
    expect(sap.children!.find((n) => n.name === "fiori")!.children!.map((p) => p.name)).toEqual(["f1.md"]);
    expect(sap.children!.find((n) => n.name === "s4hana")!.children!.map((p) => p.name)).toEqual(["h1.md"]);

    const sommer = tree.find((n) => n.name === "sommerseminar")!;
    expect(sommer.children!.map((p) => p.path)).toEqual(["sommerseminar/s1.md", "sommerseminar/s2.md"]);
  });

  it("puts pages without a topic under an Untagged folder", () => {
    const tree = buildViewTree(flat, "topic");
    const untagged = tree.find((n) => n.name === "Untagged")!;
    expect(untagged.children!.map((p) => p.path)).toEqual(["concepts/e1.md"]);
  });

  it("returns empty for no pages", () => {
    expect(buildViewTree([], "topic")).toEqual([]);
  });
});

describe("buildViewTree type view", () => {
  it("groups pages by frontmatter type", () => {
    const tree = buildViewTree(flat, "type");
    expect(tree.map((n) => n.name)).toEqual(["concept", "entity"]);
    const concept = tree.find((n) => n.name === "concept")!;
    expect(concept.children!.map((p) => p.path)).toEqual([
      "sap/f1.md",
      "sap/h1.md",
      "sommerseminar/s1.md",
      "sommerseminar/s2.md",
    ]);
    const entity = tree.find((n) => n.name === "entity")!;
    expect(entity.children!.map((p) => p.path)).toEqual(["concepts/e1.md"]);
  });

  it("buckets unknown types under Other", () => {
    const tree = buildViewTree([{ path: "x.md", name: "x.md" }], "type");
    expect(tree.map((n) => n.name)).toEqual(["Other"]);
  });
});
