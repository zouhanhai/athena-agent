import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "@/App.vue";

describe("App shell", () => {
  it("renders the portal header skeleton", () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: { template: "<div />" },
        },
      },
    });
    expect(wrapper.find(".app-header").exists()).toBe(true);
    expect(wrapper.text()).toContain("Athena Agent");
  });
});
