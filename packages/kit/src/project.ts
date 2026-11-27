// Pure helpers for naming a project, shared by kit's resolver and the harness adapters.
import { isRepositoryKey } from "@loadsheet/schema";

/** `owner/repo` from a remote URL, or undefined for a local path or a URL with fewer than two segments. */
export const repoOfRemote = (url: string): string | undefined => {
  const trimmed = url.trim();
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const remote = new URL(trimmed);
      if (remote.protocol === "file:" || !remote.hostname) return undefined;
      path = remote.pathname;
    } catch {
      return undefined;
    }
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
  const key = segments.slice(-2).join("/");
  return isRepositoryKey(key) ? key.toLowerCase() : undefined;
};
