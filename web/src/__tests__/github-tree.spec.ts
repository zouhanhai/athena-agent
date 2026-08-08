import { describe, expect, it } from "vitest";

import { buildTree } from "@/github/tree";
import type { GithubTreeEntry } from "@/api/github";

function entry(path: string, type: "blob" | "tree" | "commit" = "blob", sha = path, size: number | null = 10): GithubTreeEntry {
  return { path, type, mode: "100644", sha, size };
}

describe("buildTree", () => {
  it("nests files under their folder segments", () => {
    const tree = buildTree([
      entry("README.md"),
      entry("server/src", "tree"),
      entry("server/src/index.ts"),
      entry("server/src/index.test.ts"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["server", "README.md"]);
    const server = tree[0]!;
    expect(server.type).toBe("tree");
    expect(server.children.map((n) => n.name)).toEqual(["src"]);
    expect(server.children[0]!.children.map((n) => n.name)).toEqual(["index.test.ts", "index.ts"]);
  });

  it("sorts folders before files and alphabetically within a kind", () => {
    const tree = buildTree([
      entry("zeta.md"),
      entry("alpha/one.ts"),
      entry("alpha/two.ts"),
      entry("middle.md"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["alpha", "middle.md", "zeta.md"]);
    expect(tree[0]!.children.map((n) => n.name)).toEqual(["one.ts", "two.ts"]);
  });

  it("keeps blob sha and size on leaf nodes", () => {
    const tree = buildTree([entry("src/app.ts", "blob", "sha-app", 42)]);
    expect(tree[0]!.children[0]).toMatchObject({ name: "app.ts", type: "blob", sha: "sha-app", size: 42 });
  });

  it("creates implicit folder nodes when entries skip intermediate directories", () => {
    const tree = buildTree([entry("a/b/c/deep.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["a"]);
    expect(tree[0]!.children[0]!.name).toBe("b");
    expect(tree[0]!.children[0]!.children[0]!.name).toBe("c");
    expect(tree[0]!.children[0]!.children[0]!.children[0]!.name).toBe("deep.ts");
  });

  it("treats a submodule (commit entry) as a leaf file", () => {
    const tree = buildTree([entry("vendor/lib", "commit", "sub-sha")]);
    expect(tree[0]).toMatchObject({ name: "vendor", type: "tree" });
    expect(tree[0]!.children[0]!.name).toBe("lib");
  });

  it("returns an empty array for no entries", () => {
    expect(buildTree([])).toEqual([]);
  });
});
