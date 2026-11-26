import type { Fact, TranscriptFormat } from "../../src/index.ts";

/** A transcript format for the worker tests: a `start` line opens the session, `use` lines use. */
export const countingFormat: TranscriptFormat<{ day?: string }> = {
  markers: ['"t":"'],
  initial: () => ({}),
  parse(line, state): Fact[] {
    const value = JSON.parse(line) as { t: string; day?: string; item?: string };
    if (value.t === "start") {
      state.day = value.day!;
      return [{ type: "session", day: state.day, via: "cli" }];
    }
    if (value.t === "use" && state.day !== undefined) {
      return [{ type: "used", day: state.day, via: "cli", item: value.item!, by: "model" }];
    }
    return [];
  },
};
