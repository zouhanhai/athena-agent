/**
 * Build a nested repo tree from GitHub's flat recursive git tree.
 * Directories sort before files; both are alphabetical within a kind.
 */
import type { GithubTreeEntry } from "@/api/github";

export interface TreeNode {
  name: string;
  path: string;
  type: "blob" | "tree";
  sha: string;
  size: number | null;
  children: TreeNode[];
}

/** Build a nested tree from a flat recursive git tree. Submodules (commit) are leaves. */
export function buildTree(entries: GithubTreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "tree", sha: "", size: null, children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const sorted = [...entries].sort((a, b) => a.path.length - b.path.length);
  for (const entry of sorted) {
    const segments = entry.path.split("/").filter(Boolean);
    const parts: string[] = [];
    let parent = root;
    for (let i = 0; i < segments.length; i++) {
      parts.push(segments[i]!);
      const fullPath = parts.join("/");
      let node = byPath.get(fullPath);
      if (!node) {
        const isLeaf = i === segments.length - 1;
        node = {
          name: segments[i]!,
          path: fullPath,
          type: isLeaf && entry.type === "blob" ? "blob" : "tree",
          sha: isLeaf ? entry.sha : "",
          size: isLeaf ? entry.size : null,
          children: [],
        };
        byPath.set(fullPath, node);
        parent.children.push(node);
      }
      parent = node;
    }
  }

  const sortChildren = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "tree" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      sortChildren(node.children);
    }
  };
  sortChildren(root.children);

  return root.children;
}
