import type { ScanProgress } from "@loadsheet/kit/node";

/** `seconds` as `~8s` or `~2m 05s`. */
const duration = (seconds: number) => {
  const whole = Math.max(1, Math.round(seconds));
  return whole < 60
    ? `~${whole}s`
    : `~${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
};

/**
 * Progress on stderr for a scan that takes over 2 s, such as a first run, which reads every
 * transcript before the cache holds them. On a terminal one line with a bar, the share read and the
 * time left is rewritten in place and cleared at the end; elsewhere a line with the files read is
 * printed every 5 s. Both move with
 * the bytes read, since transcripts run from a few KB to hundreds of MB.
 */
export function scanProgress(
  stderr: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr,
  clock: () => number = Date.now,
) {
  const started = clock();
  const tty = stderr.isTTY === true;
  const label = "Reading your agents' past chats, on this machine only";
  const count = (n: number) => n.toLocaleString("en-US");
  let latest: ScanProgress | undefined;
  // Where reads from disk began: the bytes the cache holds count as read at once.
  let from: { doneBytes: number; at: number } | undefined;
  let printed = 0;
  let shown = false;
  const line = () => {
    if (!latest) return label;
    const { done, total, doneBytes, totalBytes } = latest;
    const share = totalBytes > 0 ? doneBytes / totalBytes : total > 0 ? done / total : 1;
    const percent = `${Math.floor(share * 100)}%`;
    const read = doneBytes - (from?.doneBytes ?? doneBytes);
    const elapsed = (clock() - (from?.at ?? clock())) / 1000;
    const left =
      read > 0 && doneBytes < totalBytes && elapsed >= 1
        ? [`${duration(((totalBytes - doneBytes) * elapsed) / read)} left`]
        : [];
    if (!tty)
      return `${label}: ${count(done)} of ${count(total)} files, ${[percent, ...left].join(", ")}`;
    const status = [percent, ...left].join("  ");
    const width = Math.min(30, (stderr.columns ?? 80) - label.length - status.length - 4);
    if (width < 10) return `${label}: ${status}`;
    const filled = Math.round(share * width);
    return `${label}  ${"█".repeat(filled)}${"░".repeat(width - filled)}  ${status}`;
  };
  const show = () => {
    if (!tty && !shown)
      stderr.write("The first run reads every transcript; later runs use a cache.\n");
    if (tty) stderr.write(`\r\u001b[2K${line()}`);
    else stderr.write(`${line()}\n`);
    printed = clock();
    shown = true;
  };
  const timer = setTimeout(show, 2000);
  timer.unref();
  return {
    update: (progress: ScanProgress) => {
      from ??= { doneBytes: progress.doneBytes, at: clock() };
      latest = progress;
      if (clock() - started < 2000) return;
      if (tty ? clock() - printed >= 100 : clock() - printed >= 5000) show();
    },
    stop: () => {
      clearTimeout(timer);
      if (shown && tty) stderr.write("\r\u001b[2K");
    },
  };
}
