import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { costOn, fixesOn, saves, totals } from "./report";
import { useLoadsheet } from "./state";

/** Every harness the report knows, busiest first; the one in `?h=` is current. */
export function useHarness() {
  const route = useRoute();
  const router = useRouter();
  const { report } = useLoadsheet();
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
  /** The current harness's sheet, when it has anything on it. */
  const sheet = computed(() =>
    report.value.sheet.find((s) => s.harness === current.value && s.lines.length),
  );
  const cost = computed(() => (sheet.value ? costOn(sheet.value) : () => 0));
  const sum = computed(() => (sheet.value ? totals(sheet.value) : undefined));
  const fixes = computed(() => fixesOn(report.value, current.value));
  const saving = computed(() => saves(fixes.value));
  /** No sheet anywhere has a line: loadsheet found nothing to read. */
  const empty = computed(() => !report.value.sheet.some((s) => s.lines.length));
  const set = (h: string) => router.replace({ query: { ...route.query, h } });
  return { all, current, sheet, cost, sum, fixes, saving, empty, set };
}
