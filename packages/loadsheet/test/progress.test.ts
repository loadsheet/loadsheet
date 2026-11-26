import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scanProgress } from "../src/progress.ts";

const MB = 1024 * 1024;

/** A stderr that keeps what is written, and a clock the test moves. */
const setup = (tty: boolean) => {
  const written: string[] = [];
  const stderr = { isTTY: tty, columns: 120, write: (text: string) => written.push(text) > 0 };
  let now = 0;
  const progress = scanProgress(stderr, () => now);
  return { written, progress, at: (ms: number) => (now = ms) };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scan progress", () => {
  it("fills the bar and gives the time left by bytes, not files", () => {
    const { written, progress, at } = setup(true);
    progress.update({ done: 0, total: 10, doneBytes: 0, totalBytes: 100 * MB });
    // The largest file is read first: one file of ten, but most of the bytes.
    at(2500);
    progress.update({ done: 1, total: 10, doneBytes: 75 * MB, totalBytes: 100 * MB });
    expect(written.at(-1)).toBe(
      `\r\u001b[2KReading this machine's sessions  ${"█".repeat(23)}${"░".repeat(7)}  1/10 files  75%  ~1s left`,
    );
    at(5000);
    progress.update({ done: 5, total: 10, doneBytes: 80 * MB, totalBytes: 100 * MB });
    expect(written.at(-1)).toContain("5/10 files  80%  ~1s left");
    progress.stop();
    expect(written.at(-1)).toBe("\r\u001b[2K");
  });

  it("starts the time left from the bytes the cache held", () => {
    const { written, progress, at } = setup(true);
    progress.update({ done: 90, total: 100, doneBytes: 90 * MB, totalBytes: 100 * MB });
    at(4000);
    progress.update({ done: 95, total: 100, doneBytes: 92 * MB, totalBytes: 100 * MB });
    // 2 MB in 4 s, 8 MB to go.
    expect(written.at(-1)).toContain("95/100 files  92%  ~16s left");
  });

  it("prints a line every 5 s off a terminal, with files and the share of bytes", () => {
    const { written, progress, at } = setup(false);
    progress.update({ done: 0, total: 2000, doneBytes: 0, totalBytes: 400 * MB });
    at(2000);
    progress.update({ done: 10, total: 2000, doneBytes: 100 * MB, totalBytes: 400 * MB });
    vi.advanceTimersByTime(2000);
    at(3000);
    progress.update({ done: 20, total: 2000, doneBytes: 120 * MB, totalBytes: 400 * MB });
    expect(written).toEqual([
      "The first run reads every transcript; later runs use a cache.\n",
      "Reading this machine's sessions: 10 of 2,000 files, 25%, ~6s left\n",
    ]);
    at(7000);
    progress.update({ done: 1500, total: 2000, doneBytes: 380 * MB, totalBytes: 400 * MB });
    expect(written.at(-1)).toBe(
      "Reading this machine's sessions: 1,500 of 2,000 files, 95%, ~1s left\n",
    );
    progress.stop();
  });

  it("prints nothing for a scan done within 2 s", () => {
    const { written, progress, at } = setup(true);
    progress.update({ done: 0, total: 3, doneBytes: 0, totalBytes: 3 * MB });
    at(1500);
    progress.update({ done: 3, total: 3, doneBytes: 3 * MB, totalBytes: 3 * MB });
    progress.stop();
    vi.advanceTimersByTime(5000);
    expect(written).toEqual([]);
  });
});
