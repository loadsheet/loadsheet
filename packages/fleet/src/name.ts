// The command the user typed to run this CLI, such as `fleetrc` or `loadsheet fleet`, which help
// and error text name. Commands that other programs run (the launcher, the session hooks, `npx
// fleetrc` on a host) keep the name fleetrc.
let name = "fleetrc";

export const cliName = () => name;

export function setCliName(value: string) {
  name = value;
}
