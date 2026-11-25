---
title: The report as a web page
description: Open the report in a browser with --ui, or write it to a folder with loadsheet build.
navigation.order: 3
---

The web page shows the same Report as the terminal: a map of what loads into each session, a table of every line, and the fixes.

## Serve it with `--ui`

```sh
npx loadsheet --ui
```

```txt
Serving the report at http://127.0.0.1:41219/ (Ctrl+C stops it)
```

loadsheet serves the page from memory on `127.0.0.1` and writes no page to disk. It picks a free port unless you pass `--port <n>`. It answers only requests addressed to `127.0.0.1` or `localhost`, so another website cannot read the page through your browser.

## Write it with `build`

```sh
npx loadsheet build --out loadsheet-report
```

```txt
Wrote the report to loadsheet-report/index.html
```

`build` writes the page and its files into the folder that `--out` names, `./loadsheet-report` by default. Open `index.html` from disk, or put the folder on any static host. The Report is inside the HTML file, so the page needs no server.

`build` never overwrites a file it did not write. It writes into a folder that is missing or empty, or one that holds the `.loadsheet-build` file from an earlier build. In that last case it replaces only the files that the earlier build listed. Otherwise it stops with exit code 2 and changes nothing.

## Options

Both take the options of `npx loadsheet`, so the page shows the report those options print:

```sh
npx loadsheet --ui --days 7 --harness codex
npx loadsheet build https://github.com/mattpocock/skills
```

## Share a report

The page's Share button makes a loadsheet.dev link that holds the whole Report in the URL, after the `#`. Browsers do not send that part to the server, so loadsheet.dev never receives the Report. The link leaves out each skill's description. See [Privacy](/docs/guide/privacy).
