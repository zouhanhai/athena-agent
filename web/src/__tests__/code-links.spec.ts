import { describe, expect, it } from "vitest";

import type { WikiCodeMeta } from "@/api/kb";
import {
  codeSlug,
  detectCodeChannel,
  resolveCodeLinkAction,
  resolveCodeLinkTarget,
} from "@/kb/code-links";

function metaWith(chunks: WikiCodeMeta["chunks"]): WikiCodeMeta {
  return { type: "code", system: "S4H", chunks };
}

describe("detectCodeChannel (G4.S8.T11)", () => {
  it("detects ddic from fields/tableName metadata", () => {
    const meta = metaWith([
      { id: "ddic-1", path: "MARA/_header", heading_path: "MARA/_header", metadata: { kind: "header", tableName: "MARA", fields: [{ name: "MATNR" }] } },
    ]);
    expect(detectCodeChannel(meta)).toBe("ddic");
  });

  it("detects cds from sourceTables/members metadata", () => {
    const meta = metaWith([
      { id: "cds-1", path: "Master Data/I_CnsldtnSubitem_2", heading_path: "Master Data/I_CnsldtnSubitem_2", metadata: { technicalName: "I_CnsldtnSubitem_2", sourceTables: ["MARA"], associations: [], members: ["key matnr as x"] } },
    ]);
    expect(detectCodeChannel(meta)).toBe("cds");
  });

  it("detects abap from dependencies/modulePath metadata", () => {
    const meta = metaWith([
      { id: "c1", path: "zfi/zcl_fi_delivery/get", heading_path: "zfi/zcl_fi_delivery/get", metadata: { objectType: "class", devName: "zcl_fi_delivery", method: "get", modulePath: "zfi/zcl_fi_delivery/get", dependencies: [] } },
    ]);
    expect(detectCodeChannel(meta)).toBe("abap");
  });

  it("detects ui5 from references/file/component metadata", () => {
    const meta = metaWith([
      { id: "u1", path: "app/webapp/controller/Report.controller.js", heading_path: "app/webapp/controller/Report.controller.js", metadata: { kind: "controller", name: "Report.controller", file: "webapp/controller/Report.controller.js", component: "com.caleo.consolidation", method: null, references: [] } },
    ]);
    expect(detectCodeChannel(meta)).toBe("ui5");
  });

  it("returns null without chunks (markdown fallback)", () => {
    expect(detectCodeChannel(null)).toBeNull();
    expect(detectCodeChannel({ type: "code", chunks: [] })).toBeNull();
    expect(detectCodeChannel({ type: "code", chunks: [{ id: "x", path: "", metadata: {} }] })).toBeNull();
  });
});

describe("codeSlug (G4.S8.T11)", () => {
  it("matches the server slugify form used for wiki page stems", () => {
    expect(codeSlug("MARA")).toBe("mara");
    // the server slugify maps every non-alnum run (incl. `_`) to `-`
    expect(codeSlug("I_CnsldtnSubitem_2")).toBe("i-cnsldtnsubitem-2");
    expect(codeSlug("ZCL_FI_DELIVERY")).toBe("zcl-fi-delivery");
    expect(codeSlug("com.caleo.app")).toBe("com-caleo-app");
    expect(codeSlug(" S4H ")).toBe("s4h");
  });
});

describe("resolveCodeLinkTarget / resolveCodeLinkAction (no dead links)", () => {
  const pages = [
    "wiki/code/S4H/mara.md",
    "wiki/code/S4H/t134.md",
    "wiki/code/DEV/zcl-fi-delivery.md",
    "wiki/concepts/note.md",
  ];

  it("navigates to the exact expected path when the page exists", () => {
    expect(resolveCodeLinkTarget(pages, "S4H", "T134")).toBe("wiki/code/S4H/t134.md");
    expect(resolveCodeLinkAction(pages, "S4H", "T134")).toEqual({
      kind: "navigate",
      path: "wiki/code/S4H/t134.md",
    });
  });

  it("matches a page under a different system dir by file stem", () => {
    expect(resolveCodeLinkTarget(pages, "S4H", "ZCL_FI_DELIVERY")).toBe(
      "wiki/code/DEV/zcl-fi-delivery.md",
    );
  });

  it("searches when no page exists (no dead link)", () => {
    expect(resolveCodeLinkTarget(pages, "S4H", "MARA")).toBe("wiki/code/S4H/mara.md");
    expect(resolveCodeLinkTarget(pages, "S4H", "ZZ_MISSING")).toBeNull();
    expect(resolveCodeLinkAction(pages, "S4H", "ZZ_MISSING")).toEqual({
      kind: "search",
      target: "ZZ_MISSING",
    });
  });

  it("never matches non-code pages", () => {
    expect(resolveCodeLinkTarget(pages, "S4H", "note")).toBeNull();
  });
});