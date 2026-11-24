import { expect, it } from "vite-plus/test";
import type { Fact, TranscriptFormat } from "../src/index.ts";
import type { LineFormat } from "../src/node/index.ts";

it("a TranscriptFormat is the reader's line format for Facts, and the other way round", () => {
  const format: TranscriptFormat<{ day?: string }> = {
    markers: ['"type"'],
    initial: () => ({}),
    parse: () => [],
  };
  const asLineFormat: LineFormat<{ day?: string }, Fact> = format;
  const back: TranscriptFormat<{ day?: string }> = asLineFormat;
  expect(back).toBe(format);
});
