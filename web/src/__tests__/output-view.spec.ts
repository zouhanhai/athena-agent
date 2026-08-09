import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TDesign from "tdesign-vue-next";

import OutputView from "@/views/OutputView.vue";

describe("OutputView placeholder", () => {
  it("renders the Output page header and M5 placeholder", async () => {
    const wrapper = mount(OutputView, {
      global: { plugins: [TDesign] },
    });

    expect(wrapper.find(".output-view").exists()).toBe(true);
    expect(wrapper.find(".output-title").text()).toBe("Output");
    expect(wrapper.text()).toContain("Output — coming in M5");
    wrapper.unmount();
  });

  it("notes that full output generation ships in milestone M5", async () => {
    const wrapper = mount(OutputView, {
      global: { plugins: [TDesign] },
    });

    expect(wrapper.find(".output-placeholder").exists()).toBe(true);
    expect(wrapper.text()).toContain("M5");
    wrapper.unmount();
  });
});
