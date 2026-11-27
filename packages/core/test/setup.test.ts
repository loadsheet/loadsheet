import { describe, expect, it } from "vite-plus/test";
import { setupBudget } from "../src/index.ts";

describe("setupBudget", () => {
  it("is 5% of the window, with the limit at 10%", () => {
    expect(setupBudget()).toEqual({ budget: 10_000, limit: 20_000 });
    expect(setupBudget(1_000_000)).toEqual({ budget: 50_000, limit: 100_000 });
  });
});
