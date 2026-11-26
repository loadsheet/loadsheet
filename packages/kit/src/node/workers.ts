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

/** Reads transcripts on `size` worker threads running `url`, a module that calls `serveTranscripts`. */
export interface TranscriptPool {
  readonly size: number;
  read(job: TranscriptJob): Promise<TranscriptRead | null>;
  close(): Promise<void>;
}

export const openTranscriptPool = (url: URL | string, size: number): TranscriptPool => {
  type Pending = { resolve: (read: TranscriptRead | null) => void; reject: (error: Error) => void };
  const workers = Array.from({ length: Math.max(1, size) }, () => {
    const pending = new Map<number, Pending>();
    const worker = new Worker(url);
    const fail = (error: Error) => {
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    };
    worker.on("message", (response: Response) => {
      const waiting = pending.get(response.id);
      if (!waiting) return;
      pending.delete(response.id);
      if ("error" in response) waiting.reject(new Error(response.error));
      else waiting.resolve(response.read);
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`A transcript reader exited with code ${code}`)));
    return { worker, pending };
  });
  let next = 0;
  return {
    size: workers.length,
    read: (job) => {
      // The least busy worker; reads vary in size, so round-robin would leave some idle.
      const slot = workers.reduce((best, slot) =>
        slot.pending.size < best.pending.size ? slot : best,
      );
      const id = next++;
      return new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        slot.worker.postMessage({ id, job } satisfies Request);
      });
    },
    close: async () => {
      await Promise.all(workers.map(({ worker }) => worker.terminate()));
    },
  };
};
