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
  try {
    return known(ScanSchema as unknown as Shape, parseScan(JSON.parse(result.stdout))) as Scan;
  } catch {
    return "sent no Scan";
  }
};

/**
 * The Scans and unread machines of a fleet, this machine's Scan first, every machine under a name
 * no other has: buildReport keys Scans by machine, and two hosts may call themselves the same. A
 * Scan whose name is taken, or is the fleet's name for another host, goes by its name and the
 * fleet's name for its own host, as in `ubuntu (vps2)`, and if that is taken too, by a number
 * after it.
 */
export const fleetScans = (
  here: Scan,
  results: readonly RunResult[],
): { scans: Scan[]; machines: Machine[] } => {
  const taken = new Set([here.machine]);
  const unique = (...names: string[]) => {
    let name = names.find((candidate) => !taken.has(candidate));
    for (let n = 2; name === undefined; n++)
      if (!taken.has(`${names[0]} #${n}`)) name = `${names[0]} #${n}`;
    taken.add(name);
    return name;
  };
  const scans = [here];
  const machines: Machine[] = [];
  for (const result of results) {
    const scan = scanOf(result);
    if (typeof scan === "string") {
      machines.push({ name: unique(result.host), reachable: false, error: scan });
      continue;
    }
    const elsewhere = results.some((other) => other !== result && other.host === scan.machine);
    const machine = unique(
      ...(elsewhere ? [] : [scan.machine]),
      `${scan.machine} (${result.host})`,
    );
    scans.push({
      ...scan,
      machine,
      coverage: scan.coverage.map((row) => ({ ...row, machine })),
    });
  }
  return { scans, machines };
};
