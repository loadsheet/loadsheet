import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { expect, it } from "vite-plus/test";
import SkillBlocks from "../src/components/SkillBlocks.vue";
import type { SkillPack } from "../src/lib/skills";

const render = (tokens: number[]) => {
  const pack: SkillPack = {
    slug: "example/skills",
    title: "Example",
    by: "example",
    repo: "example/skills",
    sha: "",
    stars: 0,
    pushed: "",
    jobs: [],
    findings: [],
    items: tokens.map((count, index) => ({
      name: `skill-${index}`,
      path: `skill-${index}`,
      tokens: count,
      listed: count * 4,
      body: 0,
      description: "",
    })),
  };
  return renderToString(createSSRApp({ render: () => h(SkillBlocks, { pack }) }));
};

it("sets the fill from total tokens, regardless of the number of blocks", async () => {
  const many = await render([100, 200, 400, 0]);
  const few = await render([800]);
  expect(many).toContain('class="sk-fill" style="width:7%;"');
  expect(few).toContain('class="sk-fill" style="width:8%;"');
  expect(many).toContain("flex-grow:100");
  expect(many).toContain("flex-grow:400");
  expect(many).not.toContain("skill-3");
});
