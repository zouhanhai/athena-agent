import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import type { WikiCodeMeta } from "@/api/kb";
import WikiCodeRenderer from "@/components/wiki/WikiCodeRenderer.vue";
import DdicSchemaView from "@/components/wiki/DdicSchemaView.vue";
import CdsSourceOutline from "@/components/wiki/CdsSourceOutline.vue";

const DDIC_META: WikiCodeMeta = {
  type: "code",
  system: "S4H",
  devclass: "ZFI",
  chunks: [
    {
      id: "ddic-1",
      path: "MARA/_header",
      heading_path: "MARA/_header",
      metadata: {
        kind: "header",
        tableName: "MARA",
        fields: [
          { name: "MATNR", key: true, dataType: "CHAR", length: 18, description: "Material Number" },
          { name: "ERDAT", key: false, dataType: "DATS", length: 8, description: "Created on" },
          { name: "MTART", key: false, dataType: "CHAR", length: 4, description: "Material type", dataElement: "MTART" },
        ],
        foreignKeys: [{ field: "MTART", table: "T134", description: "Material type" }],
      },
    },
  ],
};

const CDS_META: WikiCodeMeta = {
  type: "code",
  system: "S4H",
  chunks: [
    {
      id: "cds-1",
      path: "Master Data/I_CnsldtnSubitem_2",
      heading_path: "Master Data/I_CnsldtnSubitem_2",
      text: "define view I_CnsldtnSubitem_2 as select from MARA\n{ key matnr as Material,\n  maktx as Description }",
      metadata: {
        technicalName: "I_CnsldtnSubitem_2",
        dataCategory: "Master Data",
        sourceTables: ["MARA"],
        associations: [{ name: "_Text", target: "I_Text" }],
        members: ["key matnr as Material", "maktx as Description"],
      },
    },
  ],
};

const ABAP_META: WikiCodeMeta = {
  type: "code",
  system: "S4H",
  devclass: "ZFI",
  chunks: [
    {
      id: "c1",
      path: "zfi/zcl_fi_delivery/get",
      heading_path: "zfi/zcl_fi_delivery/get",
      text: "METHOD get.\n  SELECT SINGLE * FROM mara.\nENDMETHOD.",
      metadata: { objectType: "class", devName: "zcl_fi_delivery", method: "get", modulePath: "zfi/zcl_fi_delivery/get", dependencies: [{ kind: "table_read", name: "MARA" }] },
    },
  ],
};

const UI5_META: WikiCodeMeta = {
  type: "code",
  system: "S4H",
  component: "com.caleo.consolidation",
  chunks: [
    {
      id: "u1",
      path: "app/webapp/controller/Report.controller.js",
      heading_path: "app/webapp/controller/Report.controller.js",
      text: "sap.ui.define([], function () { return {}; });",
      metadata: { kind: "controller", name: "Report.controller", file: "webapp/controller/Report.controller.js", component: "com.caleo.consolidation", method: null, references: [] },
    },
  ],
};

describe("WikiCodeRenderer dispatch (G4.S8.T11)", () => {
  it("renders the ddic schema table for `fields` metadata", () => {
    const wrapper = mount(WikiCodeRenderer, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="ddic-schema-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cds-source-outline"]').exists()).toBe(false);
  });

  it("renders the cds source outline for `sourceTables`/`members` metadata", () => {
    const wrapper = mount(WikiCodeRenderer, {
      props: { meta: CDS_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="cds-source-outline"]').exists()).toBe(true);
  });

  it("renders the abap unit navigator for `dependencies`/`modulePath` metadata", () => {
    const wrapper = mount(WikiCodeRenderer, {
      props: { meta: ABAP_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="abap-unit-nav"]').exists()).toBe(true);
  });

  it("renders the ui5 structure list for `references`/`file` metadata", () => {
    const wrapper = mount(WikiCodeRenderer, {
      props: { meta: UI5_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="ui5-structure-view"]').exists()).toBe(true);
  });

  it("renders nothing (markdown fallback) when no channel is detected", () => {
    const wrapper = mount(WikiCodeRenderer, {
      props: { meta: { type: "code", chunks: [] }, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="ddic-schema-view"]').exists()).toBe(false);
    expect(wrapper.text()).toBe("");
  });
});

describe("DdicSchemaView (G4.S8.T11)", () => {
  it("renders one table with key-glyph + field columns", () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.text()).toContain("MARA");
    expect(wrapper.text()).toContain("MATNR");
    expect(wrapper.text()).toContain("🔑");
    expect(wrapper.text()).toContain("Material Number");
  });

  it("filters rows through the search box", async () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    const rows = wrapper.findAll("tbody tr");
    expect(rows.length).toBe(3);
    const search = wrapper.find('[data-testid="ddic-search"]');
    await search.setValue("created");
    expect(wrapper.findAll("tbody tr").length).toBe(1);
    expect(wrapper.text()).toContain("ERDAT");
    await search.setValue("no-such-field");
    expect(wrapper.text()).toContain("No fields match");
  });

  it("sorts by field name through the clickable column header", async () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    const fieldHeader = wrapper.find('[data-testid="ddic-sort-field"]');
    await fieldHeader.trigger("click");
    let names = wrapper.findAll("tbody td.wiki-ddic-cell-name");
    expect(names[0]!.text()).toContain("ERDAT");
    expect(names[2]!.text()).toContain("MTART");
    await fieldHeader.trigger("click");
    names = wrapper.findAll("tbody td.wiki-ddic-cell-name");
    expect(names[0]!.text()).toContain("MTART");
    expect(names[2]!.text()).toContain("ERDAT");
  });

  it("sorts by dataType through the type column header", async () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    await wrapper.find('[data-testid="ddic-sort-type"]').trigger("click");
    const types = wrapper.findAll("tbody td.wiki-ddic-cell-type");
    // CHAR < DATS ascending
    expect(types[0]!.text()).toContain("CHAR");
    expect(types[2]!.text()).toContain("DATS");
  });

  it("emits navigate when the FK target page exists", async () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: ["wiki/code/S4H/t134.md"] },
    });
    const fk = wrapper.find('[data-testid="ddic-fk-link"]');
    expect(fk.exists()).toBe(true);
    await fk.trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["wiki/code/S4H/t134.md"]]);
    expect(wrapper.emitted("search")).toBeUndefined();
  });

  it("emits search when the FK target page does not exist (no dead link)", async () => {
    const wrapper = mount(DdicSchemaView, {
      props: { meta: DDIC_META, system: "S4H", existingPaths: [] },
    });
    await wrapper.find('[data-testid="ddic-fk-link"]').trigger("click");
    expect(wrapper.emitted("navigate")).toBeUndefined();
    expect(wrapper.emitted("search")).toEqual([["T134"]]);
  });
});

describe("CdsSourceOutline (G4.S8.T11)", () => {
  it("draws the HANA-Studio outline: Elements / Associations / Source tables", () => {
    const wrapper = mount(CdsSourceOutline, {
      props: { meta: CDS_META, system: "S4H", existingPaths: [] },
    });
    expect(wrapper.find('[data-testid="cds-elements"]').text()).toContain("Elements");
    expect(wrapper.find('[data-testid="cds-elements"]').text()).toContain("key matnr as Material");
    expect(wrapper.find('[data-testid="cds-associations"]').text()).toContain("_Text");
    expect(wrapper.find('[data-testid="cds-sources"]').text()).toContain("MARA");
  });

  it("shows source-table chips that search when the page does not exist", async () => {
    const wrapper = mount(CdsSourceOutline, {
      props: { meta: CDS_META, system: "S4H", existingPaths: [] },
    });
    const chip = wrapper.findAll('[data-testid="cds-chip"]').find((c) => c.text() === "MARA");
    expect(chip).toBeTruthy();
    await chip!.trigger("click");
    expect(wrapper.emitted("search")).toEqual([["MARA"]]);
  });

  it("chips navigate when the target page exists", async () => {
    const wrapper = mount(CdsSourceOutline, {
      props: { meta: CDS_META, system: "S4H", existingPaths: ["wiki/code/S4H/mara.md"] },
    });
    const chip = wrapper.findAll('[data-testid="cds-chip"]').find((c) => c.text() === "MARA");
    await chip!.trigger("click");
    expect(wrapper.emitted("navigate")).toEqual([["wiki/code/S4H/mara.md"]]);
  });
});