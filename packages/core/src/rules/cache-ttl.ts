import type { Finding, Fix, Settings, Where } from "@loadsheet/schema";
import { promptCacheFixes } from "../fixes.ts";
import { CACHE_DAYS, promptCacheDays } from "../prompt-cache.ts";
import { defineRule } from "./rule.ts";

interface Hit {
  where: Where;
  fixes: Fix[];
  cacheWrite5m: number;
  cacheWrite: number;
  cacheRewrite: number;
  days: number;
}

/**
 * Claude Code main conversations that kept their prompt cache 5 minutes on each of the last
 * CACHE_DAYS days that wrote enough to judge, per machine and entrypoint. A pause of more than 5
 * minutes then writes the whole prompt to the cache again. One finding per entrypoint, whose fix on
 * each machine sets the lifetime to 1 hour where its settings do not already; where they do, the
 * 5-minute writes come from Claude Code itself and the finding has no fix there.
 */
export const cacheTtl = defineRule({
  id: "cache-ttl",
  needs: ["usage", "cacheTtl"],
  run: ({ sheets }) => {
    const byVia = new Map<string, Hit[]>();
    for (const sheet of sheets) {
      if (sheet.harness !== "claude-code") continue;
      for (const machine of sheet.machines) {
        const settings: Settings = sheet.settingsOn(machine) ?? {};
        for (const cache of promptCacheDays(sheet.usageOn(machine))) {
          if (cache.recent !== "5m") continue;
          const recent = cache.days.slice(-CACHE_DAYS);
          const hit: Hit = {
            where: { machine, harness: sheet.harness },
            fixes: settings.cacheTtl === "1h" ? [] : promptCacheFixes(sheet, machine, settings),
            cacheWrite5m: recent.reduce((total, day) => total + day.cacheWrite5m, 0),
            cacheWrite: recent.reduce(
              (total, day) => total + day.cacheWrite5m + day.cacheWrite1h,
              0,
            ),
            cacheRewrite: recent.reduce((total, day) => total + day.cacheRewrite, 0),
            days: recent.length,
          };
          byVia.set(cache.via, [...(byVia.get(cache.via) ?? []), hit]);
        }
      }
    }
    return [...byVia].map(([via, hits]): Finding => {
      const sum = (field: "cacheWrite5m" | "cacheWrite" | "cacheRewrite") =>
        hits.reduce((total, hit) => total + hit[field], 0);
      return {
        id: `cache-ttl:claude-code:${via}`,
        rule: "cache-ttl",
        level: "fix",
        via,
        where: hits.map((hit) => hit.where),
        evidence: {
          days: CACHE_DAYS,
          cacheWrite: sum("cacheWrite"),
          cacheWrite5m: sum("cacheWrite5m"),
          cacheRewrite: sum("cacheRewrite"),
        },
        fixes: hits.flatMap((hit) => hit.fixes),
      };
    });
  },
});
