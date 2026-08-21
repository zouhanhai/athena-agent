import { describe, expect, it } from "vitest";

import { flattenPages, buildViewTree, attachHeadings } from "@/kb/wiki-tree";
import type { WikiHeading, WikiPage } from "@/kb/wiki-tree";
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

describe("topic tree code hierarchy (G4.S8.T11)", () => {
  const codePages: WikiPage[] = [
    // ABAP devclass group
    { path: "wiki/code/S4H/zcl_fi_delivery.md", name: "zcl_fi_delivery.md", type: "code", topic: "code/S4H", system: "S4H", devclass: "ZFI", transport: "K900123" },
    { path: "wiki/code/S4H/zcl_fi_post.md", name: "zcl_fi_post.md", type: "code", topic: "code/S4H", system: "S4H", devclass: "ZFI" },
    // UI5 component namespace group
    { path: "wiki/code/S4H/com-caleo-consolidation.md", name: "com-caleo-consolidation.md", type: "code", topic: "code/S4H", system: "S4H", component: "com.caleo.consolidation" },
    // DDIC page WITHOUT a devclass → stays directly under code/<system>/
    { path: "wiki/code/S4H/mara.md", name: "mara.md", type: "code", topic: "code/S4H", system: "S4H" },
    // non-code page with identical topic stays as-is
    { path: "wiki/code/S4H/note.md", name: "note.md", type: "concept", topic: "code/S4H" },
  ];

  it("adds a devclass/component folder level under code/<system>/ for code pages", () => {
    const tree = buildViewTree(codePages, "topic");
    const code = tree.find((n) => n.name === "code")!;
    const system = code.children!.find((n) => n.name === "S4H")!;

    const folderNames = new Set(system.children!.map((n) => n.name));
    expect(folderNames).toEqual(
      new Set(["ZFI", "com.caleo.consolidation", "mara.md", "note.md"]),
    );

    const devclass = system.children!.find((n) => n.name === "ZFI")!;
    expect(devclass.isDir).toBe(true);
    expect(devclass.children!.map((n) => n.path)).toEqual([
      "wiki/code/S4H/zcl_fi_delivery.md",
      "wiki/code/S4H/zcl_fi_post.md",
    ]);

    const component = system.children!.find((n) => n.name === "com.caleo.consolidation")!;
    expect(component.isDir).toBe(true);
    expect(component.children!.map((n) => n.path)).toEqual([
      "wiki/code/S4H/com-caleo-consolidation.md",
    ]);

    // pages without devclass stay directly under code/<system>/; non-code pages unaffected
    expect(system.children!.find((n) => n.name === "mara.md")!.isDir).toBe(false);
    expect(system.children!.find((n) => n.name === "note.md")!.isDir).toBe(false);
  });

  it("devclass takes precedence over component when both present", () => {
    const pages: WikiPage[] = [
      { path: "wiki/code/S4H/a.md", name: "a.md", type: "code", topic: "code/S4H", system: "S4H", devclass: "ZFI", component: "com.x" },
    ];
    const tree = buildViewTree(pages, "topic");
    const system = tree.find((n) => n.name === "code")!.children![0]!;
    expect(system.children!.map((n) => n.name)).toEqual(["ZFI"]);
    expect(system.children![0]!.children![0]!.path).toBe("wiki/code/S4H/a.md");
  });

  it("code pages without a devclass/component gain no folder level", () => {
    const pages: WikiPage[] = [
      { path: "wiki/code/S4H/mara.md", name: "mara.md", type: "code", topic: "code/S4H", system: "S4H" },
      { path: "wiki/code/unknown/x.md", name: "x.md", type: "code", topic: "code/unknown" },
    ];
    const tree = buildViewTree(pages, "topic");
    const system = tree.find((n) => n.name === "code")!.children![0]!;
    expect(system.children!.map((n) => n.name)).toEqual(["mara.md"]);
    // topic "code/unknown" → single code/ folder, page under it
    const unknown = tree.find((n) => n.name === "code")!.children!.find((n) => n.name === "unknown")!;
    expect(unknown.children!.map((n) => n.name)).toEqual(["x.md"]);
  });
});

describe("attachHeadings (G3.S5.T6)", () => {
  const base = () => buildViewTree(flat, "topic");

  it("adds heading children under the active file node", () => {
    const headings: WikiHeading[] = [
      { level: 1, id: "title", text: "Title" },
      { level: 2, id: "setup", text: "Setup" },
      { level: 3, id: "sub", text: "Sub" },
    ];
    const tree = attachHeadings(base(), "sap/f1.md", headings);
    const sap = tree.find((n) => n.name === "sap")!;
    const fiori = sap.children!.find((n) => n.name === "fiori")!;
    const f1 = fiori.children!.find((n) => n.name === "f1.md")!;
    expect(f1.children).toEqual([
      { name: "Title", path: "sap/f1.md#title", isDir: false, isHeading: true, level: 1, anchorId: "title" },
      { name: "Setup", path: "sap/f1.md#setup", isDir: false, isHeading: true, level: 2, anchorId: "setup" },
      { name: "Sub", path: "sap/f1.md#sub", isDir: false, isHeading: true, level: 3, anchorId: "sub" },
    ]);
  });

  it("does not touch other files or folders", () => {
    const tree = attachHeadings(base(), "sap/f1.md", [{ level: 1, id: "x", text: "X" }]);
    const sap = tree.find((n) => n.name === "sap")!;
    const s4hana = sap.children!.find((n) => n.name === "s4hana")!;
    const h1 = s4hana.children!.find((n) => n.name === "h1.md")!;
    expect(h1.children).toBeUndefined();
    expect(h1).toEqual({ name: "h1.md", path: "sap/h1.md", isDir: false });
  });

  it("leaves the tree unchanged when there are no headings", () => {
    const tree = attachHeadings(base(), "sap/f1.md", []);
    expect(tree).toEqual(buildViewTree(flat, "topic"));
  });

  it("leaves the tree unchanged when the active file is not in the tree", () => {
    const tree = attachHeadings(base(), "missing.md", [{ level: 1, id: "x", text: "X" }]);
    expect(tree).toEqual(buildViewTree(flat, "topic"));
  });
});
