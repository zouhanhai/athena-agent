import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import RegisterView from "@/views/RegisterView.vue";
import { resolveInvitation, registerInvitedEmployee } from "@/api/invitations";
import { listLogos, uploadLogo } from "@/api/agents";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  resolveInvitation: vi.fn(),
  registerInvitedEmployee: vi.fn(),
}));
vi.mock("@/api/agents", () => ({
  listLogos: vi.fn(),
  uploadLogo: vi.fn(),
}));

const resolveInvitationMock = resolveInvitation as unknown as ReturnType<typeof vi.fn>;
const registerInvitedEmployeeMock = registerInvitedEmployee as unknown as ReturnType<typeof vi.fn>;
const listLogosMock = listLogos as unknown as ReturnType<typeof vi.fn>;
const uploadLogoMock = uploadLogo as unknown as ReturnType<typeof vi.fn>;

const logos = [
  { id: "l1", name: "fox", animal: "fox", color: "teal", url: "/logos/fox-clean.png", filename: "fox-clean.png", source: "generated" as const, created_at: "x" },
  { id: "l2", name: "wolf", animal: "wolf", color: "indigo", url: "/logos/wolf-indigo.png", filename: "wolf-indigo.png", source: "generated" as const, created_at: "x" },
];

const verification = {
  session_token: "ses123",
  employee: { id: "e1", email: "carol@caleo.com", display_name: "Carol", role: "member" as const },
};

async function mountView(token = "invite-token") {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/register", name: "register", component: { template: "<div />" } },
      { path: "/knowledge", name: "knowledge", component: { template: "<div />" } },
    ],
  });
  await router.push(`/register?token=${token}`);
  const wrapper = mount(RegisterView, {
    global: { plugins: [createPinia(), TDesign, router] },
  });
  await flushPromises();
  return { wrapper, router };
}

afterEach(() => {
  resolveInvitationMock.mockReset();
  registerInvitedEmployeeMock.mockReset();
  listLogosMock.mockReset();
  uploadLogoMock.mockReset();
});

describe("RegisterView", () => {
  it("resolves the invite, shows the invited email and renders the profile form", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();

    expect(resolveInvitationMock).toHaveBeenCalledWith("invite-token");
    expect(wrapper.text()).toContain("carol@caleo.com");
    expect(wrapper.find(".reg-name").exists()).toBe(true);
    expect(wrapper.findAll(".logo-option").length).toBeGreaterThan(0);
    expect(wrapper.find(".reg-github-value").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows an error when the invite token is invalid or expired", async () => {
    resolveInvitationMock.mockRejectedValue(new Error("invitation token is invalid or expired"));
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();
    expect(wrapper.find(".reg-error").text()).toContain("invitation");
    expect(wrapper.find(".reg-name").exists()).toBe(false);
    wrapper.unmount();
  });

  it("registers with display name, password, chosen logo and github credential, then signs in", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    registerInvitedEmployeeMock.mockResolvedValue(verification);
    const { wrapper, router } = await mountView();

    await wrapper.find(".reg-name").setValue("Carol");
    await wrapper.find(".reg-password").setValue("s3cret!pw");
    const fox = wrapper
      .findAll(".logo-option")
      .find((el) => el.attributes("data-url") === "/logos/fox-clean.png");
    await fox!.trigger("click");
    await wrapper.find(".reg-github-value").setValue("ghp_supersecret");
    await wrapper.find(".reg-submit").trigger("click");
    await flushPromises();

    expect(registerInvitedEmployeeMock).toHaveBeenCalledWith("invite-token", {
      display_name: "Carol",
      password: "s3cret!pw",
      logo_url: "/logos/fox-clean.png",
      github_credential: { type: "token", value: "ghp_supersecret" },
    });
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(true);
    expect(router.currentRoute.value.path).toBe("/knowledge");
    wrapper.unmount();
  });

  it("renders the password field for setting a sign-in password", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();
    const input = wrapper.find(".reg-password");
    expect(input.exists()).toBe(true);
    expect(input.attributes("type")).toBe("password");
    wrapper.unmount();
  });

  it("rejects a password shorter than the minimum length", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();
    await wrapper.find(".reg-name").setValue("Carol");
    await wrapper.find(".reg-password").setValue("short");
    await wrapper.find(".reg-submit").trigger("click");
    await flushPromises();
    expect(registerInvitedEmployeeMock).not.toHaveBeenCalled();
    expect(wrapper.find(".reg-error").text()).toContain("8 characters");
    wrapper.unmount();
  });

  it("does not submit when display name is empty", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();

    await wrapper.find(".reg-submit").trigger("click");
    await flushPromises();
    expect(registerInvitedEmployeeMock).not.toHaveBeenCalled();
    expect(wrapper.find(".reg-error").text()).toContain("Display name");
    wrapper.unmount();
  });

  it("surfaces the backend error when registration fails", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    registerInvitedEmployeeMock.mockRejectedValue(new Error("email already registered"));
    const { wrapper } = await mountView();

    await wrapper.find(".reg-name").setValue("Carol");
    await wrapper.find(".reg-submit").trigger("click");
    await flushPromises();
    expect(wrapper.find(".reg-error").text()).toContain("already registered");
    wrapper.unmount();
  });

  it("offers only a personal access token for GitHub (no SSH option)", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const { wrapper } = await mountView();

    expect(wrapper.find(".reg-github-type").exists()).toBe(false);
    expect(wrapper.findAll('option[value="ssh"]')).toHaveLength(0);
    const valueInput = wrapper.find(".reg-github-value");
    expect(valueInput.exists()).toBe(true);
    expect(valueInput.attributes("type")).toBe("password");
    wrapper.unmount();
  });

  it("only shows available logos — in-use ones are excluded by the server", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue([logos[1]]); // fox is in use; only wolf is available
    const { wrapper } = await mountView();

    expect(listLogosMock).toHaveBeenCalledWith({ excludeInUse: true });
    const urls = wrapper.findAll(".logo-option").map((el) => el.attributes("data-url"));
    expect(urls).not.toContain("/logos/fox-clean.png");
    expect(urls).toContain("/logos/wolf-indigo.png");
    wrapper.unmount();
  });

  it("uploads a custom logo via POST /api/logos and refreshes the picker", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    const newLogo = {
      id: "u1",
      name: "hermes",
      url: "/logos/uploads/1-hermes.png",
      filename: "1-hermes.png",
      source: "upload" as const,
      created_at: "x",
    };
    uploadLogoMock.mockResolvedValue(newLogo);
    const { wrapper } = await mountView();
    listLogosMock.mockResolvedValue([...logos, newLogo]);

    const input = wrapper.find("input.logo-upload-input");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "hermes.png", {
      type: "image/png",
    });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await flushPromises();

    expect(uploadLogoMock).toHaveBeenCalledWith(file);
    expect(listLogosMock).toHaveBeenLastCalledWith({ excludeInUse: true });
    const urls = wrapper.findAll(".logo-option").map((el) => el.attributes("data-url"));
    expect(urls).toContain("/logos/uploads/1-hermes.png");
    wrapper.unmount();
  });

  it("allows the github credential to be omitted", async () => {
    resolveInvitationMock.mockResolvedValue("carol@caleo.com");
    listLogosMock.mockResolvedValue(logos);
    registerInvitedEmployeeMock.mockResolvedValue(verification);
    const { wrapper } = await mountView();

    await wrapper.find(".reg-name").setValue("Carol");
    await wrapper.find(".reg-submit").trigger("click");
    await flushPromises();

    expect(registerInvitedEmployeeMock).toHaveBeenCalledWith("invite-token", {
      display_name: "Carol",
      logo_url: expect.any(String),
      github_credential: undefined,
    });
    wrapper.unmount();
  });
});
