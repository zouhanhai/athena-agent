import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import App from "@/App.vue";
import router from "@/router";

describe("App shell", () => {
  it("renders the portal header skeleton", async () => {
    const wrapper = mount(App, {
      global: {
        plugins: [createPinia(), TDesign, router],
        stubs: {
          RouterView: { template: "<div />" },
        },
      },
    });
    await router.isReady();
    expect(wrapper.find(".app-header").exists()).toBe(true);
    expect(wrapper.text()).toContain("Athena Agent");
    wrapper.unmount();
  });
});
