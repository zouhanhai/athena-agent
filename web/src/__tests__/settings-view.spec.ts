import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import SettingsView from "@/views/SettingsView.vue";
import { updateMe } from "@/api/invitations";
import { listLogos, listDeclarations, registerDeclaration } from "@/api/agents";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  updateMe: vi.fn(),
}));
vi.mock("@/api/agents", () => ({
  listLogos: vi.fn(),
  listDeclarations: vi.fn(),
  registerDeclaration: vi.fn(),
}));

const updateMeMock = updateMe as unknown as ReturnType<typeof vi.fn>;
const listLogosMock = listLogos as unknown as ReturnType<typeof vi.fn>;
const listDeclarationsMock = listDeclarations as unknown as ReturnType<typeof vi.fn>;
const registerDeclarationMock = registerDeclaration as unknown as ReturnType<typeof vi.fn>;

const employee = {
  id: "e1",
  email: "carol@caleo.com",
  display_name: "Carol",
  logo_url: "/logos/fox-clean.png",
  role: "member" as const,
  created_at: "2026-08-08T00:00:00.000Z",
  updated_at: "2026-08-08T00:00:00.000Z",
};

const logos = [
  { id: "l1", name: "fox", animal: "fox", color: "teal", url: "/logos/fox-clean.png", filename: "fox-clean.png", source: "generated" as const, created_at: "x" },
  { id: "l2", name: "wolf", animal: "wolf", color: "indigo", url: "/logos/wolf-indigo.png", filename: "wolf-indigo.png", source: "generated" as const, created_at: "x" },
];

const declaration = {
  id: "d1",
  agent_id: "opencode-ses_xyz",
  runtime: "local",
  capabilities: {
    system: "opencode",
    mcp: ["github"],
    tools: ["bash"],
    skills: ["code_review"],
    specialty: "software-engineering",
  },
  declared_at: "2026-08-08T00:00:00.000Z",
};

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.setSession({ session_token: "ses123", employee });
  const wrapper = mount(SettingsView, {
    global: { plugins: [pinia, TDesign] },
  });
  await flushPromises();
  return { wrapper, auth };
}

beforeEach(() => {
  listLogosMock.mockReset().mockResolvedValue(logos);
  listDeclarationsMock.mockReset().mockResolvedValue([]);
  updateMeMock.mockReset();
  registerDeclarationMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SettingsView page", () => {
  it("renders a full page with Profile and Agents sections and no Theme section", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find(".settings-page").exists()).toBe(true);
    expect(wrapper.find(".settings-header").exists()).toBe(true);
    expect(wrapper.find(".settings-title").text()).toBe("Settings");
    expect(wrapper.find(".settings-section.profile").exists()).toBe(true);
    expect(wrapper.find(".settings-section.agents").exists()).toBe(true);
    // Theme settings live only in the sidebar ThemeToggle — never on the Settings page.
    expect(wrapper.find(".theme-option").exists()).toBe(false);
    expect(wrapper.find(".theme-options").exists()).toBe(false);
    // The page is not a dialog — no trigger button.
    expect(wrapper.find(".settings-trigger").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not render a dialog wrapper", async () => {
    const { wrapper } = await mountView();
    expect(wrapper.find(".t-dialog").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("SettingsView profile", () => {
  it("pre-fills the display name and selected logo from the signed-in employee", async () => {
    const { wrapper } = await mountView();

    expect(
      (wrapper.find(".settings-name").element as HTMLInputElement).value,
    ).toBe("Carol");
    const selected = wrapper.find(".logo-option.is-selected");
    expect(selected.attributes("data-url")).toBe("/logos/fox-clean.png");
    wrapper.unmount();
  });

  it("saves display name, logo and github credential via updateMe and refreshes the auth store", async () => {
    const { wrapper, auth } = await mountView();
    updateMeMock.mockResolvedValue({
      ...employee,
      display_name: "Carol C.",
      logo_url: "/logos/wolf-indigo.png",
    });

    await wrapper.find(".settings-name").setValue("Carol C.");
    const wolf = wrapper
      .findAll(".logo-option")
      .find((el) => el.attributes("data-url") === "/logos/wolf-indigo.png");
    await wolf!.trigger("click");
    await wrapper.find(".settings-github-value").setValue("ghp_supersecret");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol C.",
      logo_url: "/logos/wolf-indigo.png",
      github_credential: { type: "token", value: "ghp_supersecret" },
    });
    expect(auth.employee?.display_name).toBe("Carol C.");
    expect(auth.employee?.logo_url).toBe("/logos/wolf-indigo.png");
    wrapper.unmount();
  });

  it("keeps the existing github credential when the field is left empty", async () => {
    const { wrapper } = await mountView();
    updateMeMock.mockResolvedValue(employee);

    await wrapper.find(".settings-name").setValue("Carol C.");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).toHaveBeenCalledWith("ses123", {
      display_name: "Carol C.",
      logo_url: "/logos/fox-clean.png",
      github_credential: undefined,
    });
    wrapper.unmount();
  });

  it("validates that a display name is required", async () => {
    const { wrapper } = await mountView();

    await wrapper.find(".settings-name").setValue("   ");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(updateMeMock).not.toHaveBeenCalled();
    expect(wrapper.find(".settings-error").text()).toContain("Display name");
    wrapper.unmount();
  });

  it("surfaces the backend error when saving fails", async () => {
    const { wrapper } = await mountView();
    updateMeMock.mockRejectedValue(new Error("server down"));

    await wrapper.find(".settings-name").setValue("Carol C.");
    await wrapper.find(".settings-save").trigger("click");
    await flushPromises();

    expect(wrapper.find(".settings-error").text()).toContain("server down");
    wrapper.unmount();
  });

  it("hides the Profile section when there is no signed-in employee", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SettingsView, {
      global: { plugins: [pinia, TDesign] },
    });
    await flushPromises();

    expect(wrapper.find(".settings-name").exists()).toBe(false);
    expect(wrapper.find(".settings-section.profile").exists()).toBe(false);
    expect(wrapper.find(".agent-management").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("SettingsView agents", () => {
  it("renders pending agent declarations on the settings page", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    const { wrapper } = await mountView();

    expect(listDeclarationsMock).toHaveBeenCalled();
    expect(wrapper.find(".declaration-card").exists()).toBe(true);
    expect(wrapper.text()).toContain("opencode-ses_xyz");
    expect(wrapper.text()).toContain("software-engineering");
    wrapper.unmount();
  });

  it("confirms a declaration registration from settings, removing the card", async () => {
    listDeclarationsMock.mockResolvedValue([declaration]);
    registerDeclarationMock.mockResolvedValue({ id: "a1" });
    const { wrapper } = await mountView();

    await wrapper.find(".decl-alias").setValue("Hermes");
    const fox = wrapper
      .findAll(".declaration-card .logo-option")
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
});
