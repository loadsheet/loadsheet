# loadsheet web design

The web UI shows what an agent loads before you type, against its context window. Every block is sized by its tokens and coloured by its kind. Everything else (type, chrome, copy) stays quiet so the map carries the page.

Its views, components and styles live in `@loadsheet/ui` (`packages/ui`); the paths below are under `packages/ui/src`. `apps/web` is the shell that loadsheet.dev serves and the CLI writes: `src/main.ts` reads an inlined report, installs `createLoadsheet()` (`lib/state.ts`, where the report on screen lives, given to views through provide/inject) and mounts the hash router in `src/routes.ts`. Views link by route name (`home`, `report`, `fixes`, `pack`), so a Nuxt app can mount them under its own routes.

## Tokens

The CSS loads in this order (`styles/index.css`, exported as `@loadsheet/ui/styles.css`): the layer order `theme, base, ui-sdk, components, utilities`, the kit's `tokens.css` and `default.scoped.css`, then `styles/tokens.css`, then `styles/app.css`. Everything is scoped to the element with `class="ui-sdk loadsheet"` (`<body>` in `apps/web`), so the page can sit inside a site with its own theme, Nuxt UI or Tailwind: the kit styles only inside `.ui-sdk`, and `app.css` prefixes every rule with `:where(.loadsheet)`, which keeps each rule's specificity.

- `tokens.css` sets the kit's shadcn names (`--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--primary`, `--ring`) and loadsheet's own names (below). Each colour is defined twice: on `.loadsheet`, and again under `[data-theme="dark"]`, which `apps/web` sets on `<html>`.
- `app.css` uses only `var(--…)` names. If a colour isn't a token, add it to both theme blocks in `tokens.css` first. A hex value in `app.css` or a `.vue` file breaks dark mode.

| Role                                               | Token                                  |
| -------------------------------------------------- | -------------------------------------- |
| Page / panel / sunk well                           | `--background` / `--card` / `--muted`  |
| Text / secondary text                              | `--foreground` / `--muted-foreground`  |
| Hairline / control border                          | `--border` / `--input`                 |
| Ink (the one solid button)                         | `--primary` on `--primary-foreground`  |
| Accent: `$` prompt, savings, row links, focus ring | `--acc` (selection tint: `--acc-tint`) |
| Block corner / card corner                         | `--r-b` (3px) / `--r-lg` (8px)         |
| Motion curve                                       | `--ease`                               |
| Report header height                               | `--bar`                                |

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

- The headline is the total in pixel type, then "of {window} used before you type". The window is `DEFAULT_WINDOW` (200k) until the Report carries one.
- `components/ContextBar.vue`: the whole window as one bar, each segment at its true share, a scale beneath. Clicking a segment selects it in both views.
- Under the bar, left of the view switch, a plain `.fixl` link reads "N fixes" and opens `/report/fixes`. It is hidden when the harness has no fixes. The rules' findings live on that page, not on this one. The Fixes page leads back with a plain "← Report" link (`.back`) above its title, keeping `h` and `r`.
- A SegmentedControl switches Map and Table, kept in `?view=table`. The map is the default.
- `components/ContextMap.vue`: segments squarified (7% floor), ordered by `RANK`, skills biggest top-left. The harness is a fixed strip under the map with a link to its docs (`HDOC`), never a block. Personal skills get one tile each; a plugin or other source is one tile with an "Open table" button; other kinds fold small items into "+N more". Tile text is 10px mono and hides when the tile is too small. Clicking a skill tile opens the table on that row.
- `components/ContextTable.vue`: one row per segment, then source groups for skills, then items, heaviest first. Lists over six show the top five plus a full-width "Show more" row. Skills with 0 tokens sit in "Installed, not loaded". A description shows its first sentence and expands on click; the "?" button's tooltip says where it comes from. The last row is the free window. The pack page renders the same table over the pack's lines with `:free="false"`, every skill listed and described, so its rows match the report's table.
- The map and the table share one `ViewState` through `provide(VIEW)`, so selection, open rows and search survive a switch.

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

- Switching between peer views in place: the `@ui-sdk/vue` SegmentedControl. The harness switch sits centred in the report header, each item with its mark (`components/HarnessMark.vue`) and name; a harness with 0 sessions gets `data-off`, which dims it but keeps it clickable. The Map / Table switch sits above the view, right-aligned.
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
