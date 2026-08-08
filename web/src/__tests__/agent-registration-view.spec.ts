import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import AgentRegistrationView from "@/views/AgentRegistrationView.vue";
import { listDeclarations, listLogos, registerDeclaration } from "@/api/agents";

vi.mock("@/api/agents", () => ({
  listDeclarations: vi.fn(),
  listLogos: vi.fn(),
  registerDeclaration: vi.fn(),
}));

const listDeclarationsMock = listDeclarations as unknown as ReturnType<typeof vi.fn>;
const listLogosMock = listLogos as unknown as ReturnType<typeof vi.fn>;
const registerDeclarationMock = registerDeclaration as unknown as ReturnType<typeof vi.fn>;

const caps = {
  system: "opencode",
  mcp: ["lightrag", "github"],
  tools: ["bash", "web_fetch"],
  skills: ["code_review"],
  specialty: "software-engineering",
};

const declaration = {
  id: "d1",
  agent_id: "opencode-ses_xyz",
  runtime: "local",
  capabilities: caps,
  declared_at: "2026-08-08T00:00:00.000Z",
};

const logos = [
  { id: "l1", name: "fox", animal: "fox", color: "teal", url: "/logos/fox-clean.png", filename: "fox-clean.png", source: "generated", created_at: "x" },
  { id: "l2", name: "wolf", animal: "wolf", color: "indigo", url: "/logos/wolf-indigo.png", filename: "wolf-indigo.png", source: "generated", created_at: "x" },
];

async function mountView() {
  const wrapper = mount(AgentRegistrationView, {
    global: { plugins: [createPinia(), TDesign] },
  });
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  listDeclarationsMock.mockReset();
  listLogosMock.mockReset();
  registerDeclarationMock.mockReset();
});

describe("AgentRegistrationView", () => {
  it("loads pending declarations + logos and renders a card per declaration", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    listLogosMock.mockResolvedValue(logos);
    const wrapper = await mountView();

    expect(listDeclarationsMock).toHaveBeenCalledTimes(1);
    expect(listLogosMock).toHaveBeenCalledTimes(1);
    const cards = wrapper.findAll(".declaration-card");
    expect(cards).toHaveLength(1);
    expect(wrapper.text()).toContain("opencode-ses_xyz");
    expect(wrapper.text()).toContain("local");
    expect(wrapper.text()).toContain("software-engineering");
    expect(wrapper.text()).toContain("lightrag");
    expect(wrapper.text()).toContain("bash");
    wrapper.unmount();
  });

  it("shows a friendly empty state when there are no declarations", async () => {
    listDeclarationsMock.mockResolvedValue([]);
    listLogosMock.mockResolvedValue(logos);
    const wrapper = await mountView();

    expect(wrapper.find(".reg-empty").exists()).toBe(true);
    expect(wrapper.findAll(".declaration-card")).toHaveLength(0);
    wrapper.unmount();
  });

  it("shows the error message when loading fails", async () => {
    listDeclarationsMock.mockRejectedValue(new Error("registry down"));
    listLogosMock.mockResolvedValue(logos);
    const wrapper = await mountView();

    expect(wrapper.find(".reg-error").text()).toContain("registry down");
    wrapper.unmount();
  });

  it("confirms registration with the employee-chosen alias + logo and removes the card", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    listLogosMock.mockResolvedValue(logos);
    registerDeclarationMock.mockResolvedValue({ id: "a1" });
    const wrapper = await mountView();

    await wrapper.find(".decl-alias").setValue("Hermes");
    const fox = wrapper
      .findAll(".logo-option")
      .find((el) => el.attributes("data-url") === "/logos/fox-clean.png");
    await fox!.trigger("click");
    await wrapper.find(".decl-confirm").trigger("click");
    await flushPromises();

    expect(registerDeclarationMock).toHaveBeenCalledWith("d1", {
      alias: "Hermes",
      owner_employee_id: "employee",
      logo_url: "/logos/fox-clean.png",
    });
    expect(wrapper.findAll(".declaration-card")).toHaveLength(0);
    wrapper.unmount();
  });

  it("does not register when the alias is empty and shows a validation error", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    listLogosMock.mockResolvedValue(logos);
    const wrapper = await mountView();

    await wrapper.find(".decl-confirm").trigger("click");
    await flushPromises();

    expect(registerDeclarationMock).not.toHaveBeenCalled();
    expect(wrapper.find(".decl-error").text()).toContain("Alias is required");
    wrapper.unmount();
  });

  it("surfaces the backend error when registration fails", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    listLogosMock.mockResolvedValue(logos);
    registerDeclarationMock.mockRejectedValue(new Error("alias already taken"));
    const wrapper = await mountView();

    await wrapper.find(".decl-alias").setValue("Hermes");
    await wrapper.find(".decl-confirm").trigger("click");
    await flushPromises();

    expect(wrapper.find(".decl-error").text()).toContain("alias already taken");
    expect(wrapper.findAll(".declaration-card")).toHaveLength(1);
    wrapper.unmount();
  });
});
