import type { Router } from "vue-router";
import { openFile } from "./report";
import { say } from "./ui";

/** Asks for a report.json and opens its map; a file loadsheet can't read only says so. */
export function pickReport(router: Router) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await openFile(file);
      await router.push("/report");
    } catch {
      say(`${file.name} isn't a loadsheet report`);
    }
  };
  input.click();
}
