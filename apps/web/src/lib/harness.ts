import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { context, report } from "./report";

/** Every harness the report knows, busiest first; the one in `?h=` is current. */
export function useHarness() {
  const route = useRoute();
  const router = useRouter();
  const all = computed(() => {
    const sessions = new Map<string, number>();
    for (const c of report.value.coverage)
      if (c.installed) sessions.set(c.harness, (sessions.get(c.harness) ?? 0) + c.sessions);
    for (const s of report.value.sheet)
      if (!sessions.has(s.harness)) sessions.set(s.harness, s.sessions);
    return [...sessions].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, sessions: n }));
  });
  const current = computed(() => {
    const q = route.query.h;
    return typeof q === "string" && all.value.some((h) => h.id === q)
      ? q
      : (all.value[0]?.id ?? "");
  });
  const sheet = computed(() => report.value.sheet.find((s) => s.harness === current.value));
  const ctx = computed(() => context(sheet.value));
  const sessions = computed(() => all.value.find((h) => h.id === current.value)?.sessions ?? 0);
  const set = (h: string) => router.replace({ query: { ...route.query, h } });
  return { all, current, sheet, ctx, sessions, set };
}
