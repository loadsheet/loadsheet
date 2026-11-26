import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { foldFacts, type Fact, type Tally, type TranscriptFormat } from "../index.ts";
import { readTranscript, type ReadOptions, type ReadPosition } from "./reader.ts";

/** One transcript file to read, from `position` when its guard still matches. */
export interface TranscriptJob {
  readonly harness: string;
  readonly path: string;
  readonly position?: ReadPosition;
}

/** The counters of one transcript file read from disk. */
export interface TranscriptRead {
  /** The counters of the complete lines read, from `position` when `resumed`, else from the start. */
  readonly fresh: Tally;
  /** The counters of an unterminated last line, which is read again next time. */
  readonly tail: Tally;
  /** Whether the last line was unterminated and gave any Facts. */
  readonly tailFacts: boolean;
  readonly position: ReadPosition;
  readonly resumed: boolean;
}

/**
 * Reads one transcript file and folds its Facts, from the job's position when its guard matches
 * and else in full. Returns null when the file cannot be read.
 */
export const readTranscriptTally = async (
  format: TranscriptFormat<unknown>,
  job: TranscriptJob,
  options?: ReadOptions,
): Promise<TranscriptRead | null> => {
  let read = await readTranscript<unknown, Fact>(job.path, format, job.position, options);
  if (read === null && job.position) {
    read = await readTranscript<unknown, Fact>(job.path, format, undefined, options);
  }
  if (read === null) return null;
  return {
    fresh: foldFacts(job.harness, read.records),
    tail: foldFacts(job.harness, read.tail),
    tailFacts: read.tail.length > 0,
    position: read.position,
    resumed: read.resumed,
  };
};

type Request = { readonly id: number; readonly job: TranscriptJob };
type Response =
  | { readonly id: number; readonly read: TranscriptRead | null }
  | { readonly id: number; readonly error: string };

/**
 * Serves `scanMachine`'s reads in a worker thread. The module passed as its `worker` option calls
 * it with the formats of the harnesses it may be asked to read, by harness id:
 *
 *   serveTranscripts((id) => findHarness(id)?.machine?.transcripts);
 */
export const serveTranscripts = (
  formatOf: (harness: string) => TranscriptFormat<unknown> | undefined,
): void => {
  if (isMainThread || !parentPort) throw new Error("serveTranscripts runs in a worker thread");
  const port = parentPort;
  port.on("message", async ({ id, job }: Request) => {
    let response: Response;
    try {
      const format = formatOf(job.harness);
      if (!format) throw new Error(`No transcript format for ${job.harness}`);
      // A worker does nothing but read, so blocking reads cost it no other work.
      response = { id, read: await readTranscriptTally(format, job, { sync: true }) };
    } catch (error) {
      response = { id, error: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(response);
  });
};

/**
 * Reads transcripts on worker threads running a module that calls `serveTranscripts`. Reads wait
 * in one queue, largest first, and each goes to a thread with nothing to do, so the last reads of
 * a run are small ones and no thread finishes long before the others.
 */
export interface TranscriptPool {
  /** Threads started so far. */
  readonly size: number;
  /** Starts threads until there are `size`; reads queued before the first one wait for it. */
  grow(size: number): void;
  /** Reads `job`, which reads `bytes` from disk. */
  read(job: TranscriptJob, bytes: number): Promise<TranscriptRead | null>;
  close(): Promise<void>;
}

/**
 * Reads each thread holds at once: the next one waits in its message queue, so the thread starts
 * it as soon as the last ends instead of waiting on a message from this one. More would leave
 * reads queued behind a busy thread while another runs out.
 */
const READS_PER_WORKER = 2;

export const openTranscriptPool = (url: URL | string, size = 0): TranscriptPool => {
  type Queued = {
    readonly job: TranscriptJob;
    readonly bytes: number;
    readonly resolve: (read: TranscriptRead | null) => void;
    readonly reject: (error: Error) => void;
  };
  type Slot = { readonly worker: Worker; readonly pending: Map<number, Queued> };
  const slots: Slot[] = [];
  // Smallest first, so the largest is popped off the end.
  const queue: Queued[] = [];
  let next = 0;
  let closed = false;

  const dispatch = () => {
    while (queue.length) {
      const largest = queue.at(-1)!;
      let slot: Slot | undefined;
      for (const candidate of slots) {
        if (candidate.pending.size >= READS_PER_WORKER) continue;
        if (!slot || candidate.pending.size < slot.pending.size) slot = candidate;
        if (slot.pending.size === 0) break;
      }
      if (!slot) return;
      queue.pop();
      const id = next++;
      slot.pending.set(id, largest);
      slot.worker.postMessage({ id, job: largest.job } satisfies Request);
    }
  };

  const start = (): Slot => {
    const slot: Slot = { worker: new Worker(url), pending: new Map() };
    const fail = (error: Error) => {
      for (const { reject } of slot.pending.values()) reject(error);
      slot.pending.clear();
    };
    slot.worker.on("message", (response: Response) => {
      const waiting = slot.pending.get(response.id);
      if (!waiting) return;
      slot.pending.delete(response.id);
      if ("error" in response) waiting.reject(new Error(response.error));
      else waiting.resolve(response.read);
      dispatch();
    });
    slot.worker.on("error", fail);
    slot.worker.on("exit", (code) =>
      fail(new Error(`A transcript reader exited with code ${code}`)),
    );
    return slot;
  };

  const pool: TranscriptPool = {
    get size() {
      return slots.length;
    },
    grow: (size) => {
      if (closed) return;
      while (slots.length < size) slots.push(start());
      dispatch();
    },
    read: (job, bytes) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("The transcript readers are closed"));
          return;
        }
        // Before reads of the same size, so those queued earlier go first.
        let low = 0;
        let high = queue.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (queue[middle]!.bytes < bytes) low = middle + 1;
          else high = middle;
        }
        queue.splice(low, 0, { job, bytes, resolve, reject });
        dispatch();
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      const error = new Error("The transcript readers are closed");
      for (const { reject } of queue.splice(0)) reject(error);
      await Promise.all(slots.map(({ worker }) => worker.terminate()));
    },
  };
  pool.grow(size);
  return pool;
};
