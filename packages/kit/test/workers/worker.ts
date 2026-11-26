import { serveTranscripts } from "../../src/node/index.ts";
import { countingFormat } from "./format.ts";

serveTranscripts((id) => (id === "counting" ? countingFormat : undefined));
