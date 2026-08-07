import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import LoginView from "@/views/LoginView.vue";
import AuthVerifyView from "@/views/AuthVerifyView.vue";
import { requestMagicLink, verifyMagicLink } from "@/api/invitations";
import { useAuthStore } from "@/stores/auth";

vi.mock("@/api/invitations", () => ({
  requestMagicLink: vi.fn(),
  verifyMagicLink: vi.fn(),
}));

const requestMagicLinkMock = requestMagicLink as unknown as ReturnType<typeof vi.fn>;
const verifyMagicLinkMock = verifyMagicLink as unknown as ReturnType<typeof vi.fn>;

async function makeRouter(initialPath: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/chat", name: "chat", component: { template: "<div />" } },
      { path: "/login", name: "login", component: LoginView },
      { path: "/auth/verify", name: "verify", component: AuthVerifyView },
    ],
  });
  await router.push(initialPath);
  return router;
}

afterEach(() => {
  requestMagicLinkMock.mockReset();
  verifyMagicLinkMock.mockReset();
});

describe("LoginView", () => {
  it("requests a magic link for the entered email and confirms", async () => {
    setActivePinia(createPinia());
    requestMagicLinkMock.mockResolvedValue(undefined);
    const router = await makeRouter("/login");
    const wrapper = mount(LoginView, { global: { plugins: [createPinia(), TDesign, router] } });
    await wrapper.find(".login-email").setValue("carol@caleo.com");
    await wrapper.find(".login-submit").trigger("click");
    await flushPromises();
    expect(requestMagicLinkMock).toHaveBeenCalledWith("carol@caleo.com");
    expect(wrapper.find(".login-sent").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows an error when requesting the magic link fails", async () => {
    setActivePinia(createPinia());
    requestMagicLinkMock.mockRejectedValue(new Error("mailer down"));
    const router = await makeRouter("/login");
    const wrapper = mount(LoginView, { global: { plugins: [createPinia(), TDesign, router] } });
    await wrapper.find(".login-email").setValue("carol@caleo.com");
    await wrapper.find(".login-submit").trigger("click");
    await flushPromises();
    expect(wrapper.find(".login-error").text()).toContain("mailer down");
    wrapper.unmount();
  });

  it("does not send when the email is empty", async () => {
    setActivePinia(createPinia());
    const router = await makeRouter("/login");
    const wrapper = mount(LoginView, { global: { plugins: [createPinia(), TDesign, router] } });
    await wrapper.find(".login-submit").trigger("click");
    await flushPromises();
    expect(requestMagicLinkMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("AuthVerifyView", () => {
  it("verifies the login token, stores the session and redirects to /chat", async () => {
    setActivePinia(createPinia());
    verifyMagicLinkMock.mockResolvedValue({
      session_token: "ses123",
      employee: { id: "e1", email: "carol@caleo.com", display_name: "Carol", role: "member" },
    });
    const router = await makeRouter("/auth/verify?token=login-token");
    const wrapper = mount(AuthVerifyView, { global: { plugins: [createPinia(), TDesign, router] } });
    await flushPromises();
    expect(verifyMagicLinkMock).toHaveBeenCalledWith("login-token");
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(true);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/chat");
    wrapper.unmount();
  });

  it("shows an error when the login token is invalid", async () => {
    setActivePinia(createPinia());
    verifyMagicLinkMock.mockRejectedValue(new Error("invalid or expired token"));
    const router = await makeRouter("/auth/verify?token=bad");
    const wrapper = mount(AuthVerifyView, { global: { plugins: [createPinia(), TDesign, router] } });
    await flushPromises();
    expect(wrapper.find(".verify-error").text()).toContain("invalid or expired");
    wrapper.unmount();
  });
});
