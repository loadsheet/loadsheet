import type { RunResult } from "@loadsheet/fleet";
import { parseScan, ScanSchema, type Machine, type Scan } from "@loadsheet/schema";

/**
 * Why a host gave no Scan. Only these phrases reach the Report: what a host prints, other than a
 * Scan that validates, can carry text or paths.
 */
export type Unread = "offline" | "timed out" | "loadsheet failed there" | "sent no Scan";

/** The parts of a valibot schema `known` walks. */
interface Shape {
  type: string;
  entries?: Record<string, Shape>;
  item?: Shape;
  items?: Shape[];
  wrapped?: Shape;
  value?: Shape;
}

/**
 * `value`, which validated against `shape`, with only the keys the schema names. parseScan keeps
 * keys it does not know, and the Report copies some objects whole, so a key another build added
 * would reach it.
 */
const known = (shape: Shape, value: unknown): unknown => {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (shape.entries) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(shape.entries)
        .filter(([key]) => record[key] !== undefined)
        .map(([key, entry]) => [key, known(entry, record[key])]),
    );
  }
  if (shape.type === "record" && shape.value)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, known(shape.value!, entry)]),
    );
  const list = value as unknown[];
  if (shape.item) return list.map((entry) => known(shape.item!, entry));
  if (shape.items) return list.map((entry, index) => known(shape.items![index]!, entry));
  if (shape.wrapped) return known(shape.wrapped, value);
  throw new Error(`known: no rule for a ${shape.type} schema`);
};

/** A host's Scan, or why there is none; nothing else of what it printed. */
export const scanOf = (result: RunResult): Scan | Unread => {
  if (!result.reachable) return "offline";
  if (result.exitCode === undefined)
    return result.error?.startsWith("timed out") ? "timed out" : "offline";
  if (result.exitCode !== 0) return "loadsheet failed there";
  // The end of an output that was cut is not what the host printed, even when it reads as a Scan.
  if (result.truncated) return "sent no Scan";
  try {
    return known(ScanSchema as unknown as Shape, parseScan(JSON.parse(result.stdout))) as Scan;
  } catch {
    return "sent no Scan";
  }
};

const renameScan = (scan: Scan, machine: string): Scan => ({
  ...scan,
  machine,
  coverage: scan.coverage.map((row) => ({ ...row, machine })),
});

/**
 * The Scans and unread machines of a fleet, this machine's Scan first, every machine under a name
 * no other has: buildReport keys Scans by machine, and two hosts may call themselves the same. No
 * machine takes the fleet's name for another host. A Scan whose name is not free goes by its name
 * and the fleet's name for its own host (or `local`), and if that is not free either, by a number
 * after its name.
 */
export const fleetScans = (
  here: Scan,
  results: readonly RunResult[],
): { scans: Scan[]; machines: Machine[] } => {
  const reserved = new Set(results.map(({ host }) => host));
  const taken = new Set<string>();
  const unique = (host: string | undefined, ...names: string[]) => {
    const free = (name: string) => !taken.has(name) && (name === host || !reserved.has(name));
    let name = names.find(free);
    for (let n = 2; name === undefined; n++)
      if (free(`${names[0]} #${n}`)) name = `${names[0]} #${n}`;
    taken.add(name);
    return name;
  };
  const localName = unique(undefined, here.machine, `${here.machine} (local)`);
  const scans = [localName === here.machine ? here : renameScan(here, localName)];
  const machines: Machine[] = [];
  for (const result of results) {
    const scan = scanOf(result);
    if (typeof scan === "string") {
      machines.push({ name: unique(result.host, result.host), reachable: false, error: scan });
      continue;
    }
    const machine = unique(result.host, scan.machine, `${scan.machine} (${result.host})`);
    scans.push(renameScan(scan, machine));
  }
  return { scans, machines };
};
