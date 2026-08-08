/**
 * Wiki tree view grouping (G2.S5.T11).
 *
 * The backend stores each wiki page once (physical tree) and returns frontmatter
 * `type` + `topic` metadata per page. These helpers build the tree shown by the
 * frontend for each view:
 *   - "all":   the raw physical tree
 *   - "topic": pages grouped by topic (slash paths render as nested folders,
 *              e.g. "sap/fiori" → sap/ → fiori/)
 *   - "type":  pages grouped by frontmatter type (concepts/, entities/, ...)
 */
import type { WikiTreeNode } from "@/api/kb";

export type WikiView = "topic" | "type";

export interface WikiPage {
  path: string;
  name: string;
  type?: string;
  topic?: string;
}

/** Flatten the physical wiki tree into a list of content pages. */
export function flattenPages(tree: WikiTreeNode[]): WikiPage[] {
  const pages: WikiPage[] = [];
  const walk = (nodes: WikiTreeNode[]): void => {
    for (const node of nodes) {
      if (node.isDir) {
        walk(node.children ?? []);
      } else if (node.path.endsWith(".md")) {
        const stem = node.path.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() ?? "";
        if (["index", "overview", "log"].includes(stem)) continue;
        pages.push({ path: node.path, name: node.name, type: node.type, topic: node.topic });
      }
    }
  };
  walk(tree);
  return pages;
}

function pageNode(page: WikiPage): WikiTreeNode {
  return { name: page.name, path: page.path, isDir: false };
}

type Level = Map<string, Level | WikiPage[]>;
const PAGES_KEY = "__pages";

/** Build the Topic view tree: nested folders from slash-path topic keys. */
function buildTopicTree(pages: WikiPage[]): WikiTreeNode[] {
  const root: Level = new Map();
  const untagged: WikiPage[] = [];

  const insert = (segments: string[], page: WikiPage): void => {
    let level: Level = root;
    for (const segment of segments) {
      const next = level.get(segment);
      if (next instanceof Map) {
        level = next;
      } else {
        const created: Level = new Map();
        level.set(segment, created);
        level = created;
      }
    }
    const bucket = level.get(PAGES_KEY);
    if (Array.isArray(bucket)) bucket.push(page);
    else level.set(PAGES_KEY, [page]);
  };

  for (const page of pages) {
    if (page.topic && page.topic.length > 0) insert(page.topic.split("/"), page);
    else untagged.push(page);
  }

  const toTree = (level: Level, prefix: string): WikiTreeNode[] => {
    const out: WikiTreeNode[] = [];
    for (const [segment, value] of level) {
      if (segment === PAGES_KEY || !(value instanceof Map)) continue;
      const path = prefix ? `${prefix}/${segment}` : segment;
      const folder: WikiTreeNode = {
        name: segment,
        path,
        isDir: true,
        children: toTree(value, path),
      };
      const bucket = value.get(PAGES_KEY);
      if (Array.isArray(bucket)) {
        for (const page of bucket) folder.children!.push(pageNode(page));
        folder.children!.sort((a, b) => a.name.localeCompare(b.name));
      }
      out.push(folder);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  };

  const tree = toTree(root, "");
  if (untagged.length > 0) {
    tree.push({
      name: "Untagged",
      path: "untagged",
      isDir: true,
      children: untagged.sort((a, b) => a.name.localeCompare(b.name)).map(pageNode),
    });
    tree.sort((a, b) => a.name.localeCompare(b.name));
  }
  return tree;
}

/** Build the Type view tree: single-level folders per frontmatter type. */
function buildTypeTree(pages: WikiPage[]): WikiTreeNode[] {
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const key = page.type && page.type.length > 0 ? page.type : "other";
    const list = groups.get(key) ?? [];
    list.push(page);
    groups.set(key, list);
  }
  const result: WikiTreeNode[] = [];
  for (const key of [...groups.keys()].sort()) {
    const display = key === "other" ? "Other" : key;
    result.push({
      name: display,
      path: `view:type:${key}`,
      isDir: true,
      children: groups
        .get(key)!
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(pageNode),
    });
  }
  return result;
}

/** Build the view tree for the active view from a flat page list. */
export function buildViewTree(pages: WikiPage[], view: Exclude<WikiView, "all">): WikiTreeNode[] {
  return view === "topic" ? buildTopicTree(pages) : buildTypeTree(pages);
}
