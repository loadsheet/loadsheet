# loadsheet web design

The web UI shows what an agent loads before you type, against its context window. Every block is sized by its tokens and coloured by its kind. Everything else (type, chrome, copy) stays quiet so the map carries the page.

Its views, components and styles live in `@loadsheet/ui` (`packages/ui`); the paths below are under `packages/ui/src`. Two apps mount them. `apps/site` is loadsheet.dev, a Nuxt app on ViteHub that registers the views under its own path routes. `apps/page` is the single HTML file the CLI writes: `src/main.ts` reads an inlined report, installs `createLoadsheet()` (`lib/state.ts`, where the report on screen lives, given to views through provide/inject) and mounts the hash router in `src/routes.ts`. Views link by route name (`home`, `report`, `fixes`, `pack`, and on the site `mcp`, `skills`, `skill-pack`, `skill-compare`), so a Nuxt app can mount them under its own routes.

## Tokens

The CSS loads in this order (`styles/index.css`, exported as `@loadsheet/ui/styles.css`): the layer order `theme, base, ui-sdk, components, utilities`, the kit's `tokens.css` and `default.scoped.css`, then `styles/tokens.css`, then `styles/app.css`. Everything is scoped to the element with `class="ui-sdk loadsheet"` (`<body>` in `apps/page`), so the page can sit inside a site with its own theme, Nuxt UI or Tailwind: the kit styles only inside `.ui-sdk`, and `app.css` prefixes every rule with `:where(.loadsheet)`, which keeps each rule's specificity.

- `tokens.css` sets the kit's shadcn names (`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--primary`, `--ring`) and loadsheet's own names (below). Each colour is defined twice: on `.loadsheet`, and again under `[data-theme="dark"]`, which the host sets on `<html>`.
- `app.css` uses only `var(--…)` names. If a colour isn't a token, add it to both theme blocks in `tokens.css` first. A hex value in `app.css` or a `.vue` file breaks dark mode.

| Role                                               | Token                                            |
| -------------------------------------------------- | ------------------------------------------------ |
| Page / panel / sunk well                           | `--background` / `--card` / `--muted`            |
| Text / secondary text                              | `--foreground` / `--muted-foreground`            |
| Hairline / control border                          | `--border` / `--input`                           |
| Ink (the one solid button)                         | `--primary` on `--primary-foreground`            |
| Accent: `$` prompt, savings, row links, focus ring | `--acc` (selection tint: `--acc-tint`)           |
| Block corner / card corner                         | `--r-b` (3px) / `--r-lg` (8px)                   |
| Motion curve                                       | `--ease`                                         |
| Report header height                               | `--bar`                                          |
| MCP client status: fine / rewrite / problem / out  | `--s-ok` / `--s-info` / `--s-warn` / `--s-error` |

The kit's rules sit in `@layer ui-sdk`, and every rule in `app.css` is unlayered, so `app.css` always wins. Wrap a reset of a bare element in `:where()` and skip kit parts, e.g. `button:where(:not([data-slot]))`. A plain `button { background: none }` blanks the solid button. At specificity 0,1,1 it also beat `.b` and wiped the colour off every treemap block.

## Type

Three faces, all inlined into the single built HTML file:

- `--font-pixel` (Geist Pixel Square), always weight 400, through `.px` or the `.lock` wordmark. Use it for exactly three things: the wordmark, the page `h1`, and the state title (`[data-slot="vh-empty-title"]`). Body text, labels and numbers in pixel type become unreadable below 20px.
- `--font-sans` (Geist): all running text. Body is 14px; secondary lines are 13–13.5px. Nothing goes below 10.5px (the strip label in a block).
- `--font-mono` (Geist Mono), through `.mono` or `code`: item names, paths, commands, and every number. Numbers use `.num` (mono with tabular figures), so columns line up.

Page titles: `.ph h1` is 34px (28px under 760px); the landing `h1` is 46px.

## Kinds and the hatch

Each loaded thing has one kind colour: `--k-mcp`, `--k-instr`, `--k-skill`, `--k-agent`, plus `--k-pskill` for skills that live in the project and `--k-harness` for the harness's own prompt on the report page. `--logo-claude` is only for Claude Code's mark in the harness switch. Add the class `k-mcp`, `k-instr`, `k-skill`, `k-agent`, `k-dead` or `k-h` to an element and it sets `--c`. An `i` with one of those classes renders a 10–11px square; `.b` renders a block. Kind names come from `KINDS` / `kindName()` in `lib/report.ts`.

- Never used (`isDead()`): use `k-dead`, never the item's kind. It draws the red hatch (`--hatch-dead`) with a 1.5px `--k-dead` inset ring. Dead always outranks kind, so the reader sees waste before category.
- The harness's own prompt: use `k-h`, which draws the grey hatch (`--hatch-h`). It is context the user can't remove, so it is neither a kind nor dead.
- Text on a solid kind block is `--on-k`. On a hatch, the label sits on a `--background` pill.

## The report page (`views/Report.vue`)

It answers one question: how much of the window a session started now uses before you type. `lib/context.ts` turns the sheet into a `Context` (`contextOf`): one segment per kind with every installed line at its full tokens, plus a harness segment for `fixedTokens` minus what your files add. Lines without `scope` are no longer installed and stay out. History (means, never-used) isn't on this page.

- The headline is the total in pixel type, then "tokens used before you type, out of a {window} chat limit" and a "?" (`.dhelp`) that says what a token is. When built-ins aren't measured, the headline labels the count as tokens from your setup. The window is the Report's, or `DEFAULT_WINDOW` (200k) for a Report that predates it.
- Under it, one sentence from `takeaway()` describes the setup for someone who has never counted tokens: light, the heaviest part, or the share of the limit once half is gone. It never tells the reader what to change; fixes live on the Fixes page.
- `components/ContextBar.vue`: the whole window as one bar, scaled to fit the startup segments if they're over the limit. Beneath it a key names each colour with its tokens ("{harness}, built-in", then each segment), and "Free for your chat" sits at the right. Both the key and table show zero if setup already fills the window, or unknown if built-ins aren't measured and setup leaves room. Clicking a segment selects it in both views.
- Under the bar, left of the view switch, a plain `.fixl` link reads "N fixes" and opens `/report/fixes`. It is hidden when the harness has no fixes. The rules' findings live on that page, not on this one. The Fixes page leads back with a plain "← Report" link (`.back`) above its title, keeping `h` and `r`.
- A SegmentedControl switches Map and Table, kept in `?view=table`. The map is the default.
- `components/ContextMap.vue`: segments squarified (7% floor), ordered by `RANK`, skills biggest top-left. The harness is a fixed strip under the map with a link to its docs (`HDOC`), never a block. Segment tooltips carry each kind's `about`, one plain sentence on what it is. Personal skills get one tile each; a plugin or other source is one tile with an "Open table" button; other kinds fold small items into "+N more". Tile text is 10px mono and hides when the tile is too small. Clicking a skill tile opens the table on that row.
- `components/ContextTable.vue`: one row per segment, then source groups for skills, then items, heaviest first. Lists over six show the top five plus a full-width "Show more" row. Skills with 0 tokens sit in "Installed, not loaded". A description shows its first sentence and expands on click; the "?" button's tooltip says where it comes from. The last row is the free window. The pack page renders the same table over the pack's lines with `:free="false"`, every skill listed and described, so its rows match the report's table.
- The map and the table share one `ViewState` through `provide(VIEW)`, so selection, open rows and search survive a switch.

## The MCP check (`views/Mcp.vue`)

The URL form sits at 820px, with three servers to try. The answer uses the page's full width in two columns. A sticky side column holds the server, its tool count and URL in mono, the verdict as a pixel line ("Works in all 9 clients", or "Breaks in N of 9 clients" in `--s-error`), the one "Copy fix prompt" button, a row per client with a problem (its mark from `components/McpClientMark.vue` in a 24px circle, its name, and "problem" in `--s-warn` or "breaks" in `--s-error`), the other clients as overlapping marks the same size, in one column with those rows, in the kit's `vh-avatar-group` that name themselves on hover or focus, with "N fine" beside them when some client has a problem, and the CI command folded. Client marks are one colour, from @lobehub/icons (MIT); a client without a mark we may ship shows its initials. Under 960px the side column goes on top. The main column lists problems worst first (`mcpProblems()` in `lib/mcp.ts`), without cards: hairlines between them, a status dot, a plain title, the code linking to its Doctor docs, the clients it hits (unfolding to what each one does), then each fix once above the tools that take it, as one wrapped line of mono names. When the tools differ only in one quoted value, `sharedFix()` writes the fix with "…" and each tool shows its own fix on hover and through a keyboard- and touch-accessible disclosure. When every fix starts with the same sentences, `sharedHead()` shows them once and what some fixes add below them, above those tools. A fix every tool of the server takes says "All N tools" instead of naming them, unless a fragment selects one tool to show and mark. Several fixes shared by several tools each get their own fix line and tool list; only when no two tools share a fix does each tool get a row with its own. Notes (info) follow under a quiet "Notes on client behavior" label, open, their fixes in 13px muted text. The address bar is the share link: `?url=` holds the server, and a fragment from `mcpAnchor()` (`#MCP0001-get-blog-post`) points at one diagnostic. The square with a link glyph beside each problem's code copies the problem's link, and a tool's name copies that tool's; either puts its fragment in the address bar. The diagnostic a fragment names is unfolded, scrolled to, and marked: the problem's title turns `--acc` and the tool's name takes `--acc-tint`. A server that wants a token gets the Doctor command instead of a report; any other failure is a pixel title in `--s-error` and one plain line.

## The skill pack reviews (`views/Skills.vue`, `SkillPack.vue`, `SkillCompare.vue`)

loadsheet.dev reviews a few public skill packs at `/skills`: a sortable table, one page per pack, and a comparison per job. `apps/site/scripts/skill-packs.ts` measures each pack at a pinned commit into `apps/site/app/skills/packs.json` and one file list per pack; the review text is `copy.json`. Only file lists are committed: the pack page's file tree (the kit's `Tree`, `components/SkillFiles.vue`) fetches a file's text from raw.githubusercontent.com at that commit when it opens.

- Every bar and share is drawn against the setup budget, `setupBudget()` in `@loadsheet/core`: 5% of the window, 10,000 tokens of 200k, with 10% as too heavy. Never draw against the largest pack.
- Those bars estimate the full Claude Code skill listing, not the installed pack's runtime cost. The `SKILL.md` body metric excludes front matter and supporting files.
- `components/SkillBlocks.vue` puts one block per listed skill on a track that is the whole budget, so the empty part is what's left.
- Their styles are in `styles/skills.css`, every class `sk-`.

## The treemap (`components/Treemap.vue`)

The landing page and the pack page draw sizes with this component.

- Pass `Block[]` built from the report: `value` comes from `costOn(sheet)`, never a literal. Groups go harness, mcp, instr, skill, agent. Each group is squarified, and inside it used blocks come first, then dead ones. A group narrower than 200px and taller than 1.5× its width stacks its blocks as full-width strips.
- A block shows its label only when it fits: name and number at ≥56×50px, a one-line strip at ≥64×16px, nothing smaller. The full name is always in the DOM as `.sr` text, so search, screen readers and the page test find it.
- Pass `:interactive="false"` when there is nothing to open (the pack page).
- The legend is `components/Legend.vue`, fed by `totals(sheet)`.

## Buttons

Use the kit button (`data-slot="button"`) for any action. Navigation styled as a button is a `RouterLink` with `data-slot="button"`.

Variants (set with `data-variant`): none (outlined, the default), `solid`, `ghost`. Sizes (set with `data-size`): `sm` (28px), none (36px), `lg` (40px). Those are all the overrides `app.css` restyles. Any other kit variant renders off-brand.

```
Is it the main action of this view?
 ├── Yes → data-variant="solid" (data-size="lg" in a page head). One per view.
 └── No
      ├── Icon only (close, theme) → data-variant="ghost" with aria-label
      ├── Copy a command → <CopyButton> (sm, hairline square, turns --acc when done)
      └── Default → no variant (outlined)
```

```vue
<!-- Correct: the page's one ink button -->
<button
  type="button"
  data-slot="button"
  data-variant="solid"
  data-size="lg"
>Copy all for your agent</button>
<!-- Incorrect: a second solid in the same view; the head loses its one action -->
<RouterLink data-slot="button" data-variant="solid" to="/">Go home</RouterLink>
```

On every pressable thing, `:active` scales to .96. Hover styles live only inside `@media (hover: hover) and (pointer: fine)`, because a tap would otherwise leave them stuck. Focus is the global 2px `--acc` outline. Under `prefers-reduced-motion`, transitions drop to 0.

## Controls and chips

- Switching between peer views in place: the `@ui-sdk/vue` SegmentedControl. The harness switch sits centred in the report header, each item with its mark (`components/HarnessMark.vue`) and name. It lists harnesses with sessions or report lines, and the current harness, and is hidden when that leaves one. The Map / Table switch sits above the view, right-aligned.
- Switching between peer content panels: `@ui-sdk/vue` Tabs (the landing start card).
- Filtering a list: `.fchip` buttons with `aria-pressed`. Status labels: `.chip`; "never used" is `.chip.no`. Kind labels: `.kchip` (square plus name).
- Commands: `components/Cmd.vue`, given `fixView(f)`. `cmd` shows a `$` prompt in `--acc`, `set` shows a front-matter key, and `ask` is a plain sentence for the agent in an outlined well.
- Feedback after copying: the `copy()` toast in `lib/ui.ts`.

## States

- States go through `components/StateBox.vue` (the kit's `vh-empty`): the dashed four-block glyph, a pixel title, one sentence, then actions with at most one `solid`. Use it for every dead end: no sessions for a harness (`NoSessions.vue`), nothing read, nothing to fix, a broken link, an unknown pack.

## Copy

- Each page gets a title plus at most one short line (`.sub`). No eyebrow line above the title, and no caption under a chart. No native `title` attributes: tooltips go through `showTip()` in `lib/ui.ts`.
- Keep control labels, the numbers, and the one-line reason on each fix (`evidence()`). Cut every other sentence that doesn't change what the reader does next.
- Numbers come from the report through `fmt()`. Anything the schema doesn't carry is left out, never written in.
- Title states as the fact ("Nothing to fix", "Cursor has no sessions here") and describe the next action in the button.

## Marks

The mark is four blocks: the ink harness, then MCP, instructions and skills. It lives in `components/Logo.vue` (`size`, `word`). The favicon in `index.html` is the same paths as an inline SVG with a dark-scheme media query. The touch icon is an inline 180px PNG of the mark on an ink tile.
