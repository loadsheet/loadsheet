import { useRouter } from "vue-router";
import { useLoadsheet } from "./state";
import { say } from "./ui";

/** Returns a function that asks for a report.json and opens its map; a file loadsheet can't read only says so. */
export function usePickReport() {
  const router = useRouter();
  const { openFile } = useLoadsheet();
  return () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await openFile(file);
        await router.push({ name: "report" });
      } catch {
        say(`${file.name} isn't a loadsheet report`);
      }
    };
    input.click();
  };
}
