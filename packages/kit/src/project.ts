// Pure helpers for naming a project, shared by kit's resolver and the harness adapters.

/** `owner/repo` from a remote URL, or undefined for a local path or a URL with fewer than two segments. */
export const repoOfRemote = (url: string): string | undefined => {
  const trimmed = url.trim();
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/i.exec(trimmed);
  if (scheme) {
    if (/^file:/i.test(trimmed) || !scheme[1]) return undefined;
    path = scheme[2] ?? "";
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/.exec(trimmed);
    if (!scp?.[2] || scp[2].startsWith("/")) return undefined;
    path = scp[2];
  }
  const segments = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join("/").toLowerCase();
};
