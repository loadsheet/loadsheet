---
title: Several machines
description: Report every machine you work on in one report with --fleet, and keep their skills in sync with loadsheet fleet.
navigation.order: 5
---

If you run agents on more than one machine, a skill you never use on your laptop may still be used on your server. `--fleet` reads them all before it judges.

## One report for every machine

```sh
npx loadsheet --fleet
```

loadsheet reads this machine, then asks each other machine of your fleet for its Scan over ssh. On each one it runs:

```sh
npx -y loadsheet@0.1.0 --scan --days 30
```

That machine reads its own transcripts and sends back counters, names and skill descriptions as JSON. No transcript text leaves it. loadsheet then prints one Report for all machines, and says on stderr how many it read, such as `Read 3 of 4 machines`.

loadsheet leaves out a machine that fails or does not answer within `--timeout` seconds, 300 by default. The Report lists it under `machines` with the reason. A fleet report adds the `drift` rule: the same skill with different contents on two machines.

The fleet is the list of machines in [fleetrc](https://www.npmjs.com/package/fleetrc)'s manifest. loadsheet finds it through fleetrc's `config.json`, in `$XDG_CONFIG_HOME/fleetrc` or `~/.config/fleetrc`. Without one, `--fleet` reports this machine alone.

To run another build of loadsheet on the other machines, such as one not yet on npm, set `LOADSHEET_FLEET_COMMAND`. loadsheet splits it on spaces and runs it in place of `npx -y loadsheet@0.1.0`.

## Keep skills in sync

`loadsheet fleet` runs fleetrc, which installs the same skills in every agent's skills folder from the sources a manifest lists. `loadsheet fleet init <manifest>` points this machine at a manifest, and `loadsheet fleet sync` fetches the sources and links the skills. To list every command:

```sh
npx loadsheet fleet --help
```
