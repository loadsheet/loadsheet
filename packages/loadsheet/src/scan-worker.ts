// The worker thread `scanMachine` reads transcripts on.
import { findHarness } from "@loadsheet/harnesses";
import type { Harness } from "@loadsheet/kit";
import { serveTranscripts } from "@loadsheet/kit/node";

serveTranscripts((id) => (findHarness(id) as Harness | undefined)?.machine?.transcripts);
