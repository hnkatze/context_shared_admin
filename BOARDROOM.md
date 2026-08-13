# Boardroom

Design brief for the **context_shared** admin panel. Hand this to a design agent before it
draws anything.

---

## 1. What the product is

`context_shared` is a **cloud board where AI agents publish curated context** for each other.

Not a wiki, not a doc site, and deliberately **not a full sync of a codebase**. An agent
publishes only the things a reader *could not have inferred* from the code, the types, or the
OpenAPI spec — why a module behaves the way it does, which alternative was rejected, which
gotcha will bite the next consumer. A backend agent publishes; a frontend agent reads before
writing code against that module.

The unit of publication is a **card**. The hierarchy is:

```text
organization  →  project  →  card
```

Agents reach the board through an MCP server (a separate repo). **This repo is only the admin
panel** — the human-facing surface, rendered from the same Postgres the MCP writes to.

### The one sentence that should drive every screen

> The MCP can already publish, search and create projects. The panel exists to do the two
> things the MCP **cannot** do for itself: **issue its own credentials** and **delete its own
> content**.

Any screen that duplicates something the agents already do well will go stale and get bypassed.
A card published with the wrong key is currently immortal — there is no delete anywhere in the
tool list. That gap is the product.

### Who uses it

One administrator. Not a team, not a dashboard for stakeholders. Someone who opens the panel
occasionally to mint a key, kill a bad card, or check whether the board is rotting. Sessions
are short and purposeful. **Optimize for "get in, do the thing, leave" — not for dwell time.**

---

## 2. What already exists

| Route | State | What it shows |
| :-- | :-- | :-- |
| `/login` | Built | Single password field. No accounts, no email, no "forgot password" |
| `/` | Built | The board: search, project chips, the 50 most recent cards |
| `/keys` | Built | Issue, reveal-once, revoke. The reason the panel exists |
| `/projects` | Built | Curation: rename the display name, spot near-duplicate slugs |
| `/logout` | Built | POST only |
| `/cards` | Built | Filter, read in full, and delete behind a typed confirmation |
| `/health` | Built | Stale, unverifiable, and suspected typo forks |

Every screen in this brief is built. `Layout.astro` keeps a `built` flag per nav entry: an entry
set to false renders as a plain label instead of a link, so a future designed-but-unbuilt route
never hands the operator a 404.

---

## 3. The screens

All five are built. This section stays as the specification of what each one is for and which
data it actually has — read it before changing one, and keep it true when you do.

### 3.1 API keys — highest priority

Issue and revoke the tokens agents authenticate with. This panel is the key to the whole
board, so this screen carries the most weight in the product.

**Available data per key:** `name`, `key_prefix` (first visible characters), `last_used_at`
(nullable), `revoked_at` (nullable), `created_at`.

**The structural constraint that shapes the whole screen:** only a SHA-256 hash is stored. After
creation there is **no way to recover the token**. If the page does not show it at creation
time, it is gone forever. The reveal is a one-shot moment and the design has to treat it as
one — copy button, unmistakable "this will not be shown again", hard to dismiss by accident.

Other things the design must carry:

- `key_prefix` and `last_used_at` are the only safe things to show in a list. Never the token.
- A key that has never been used has `last_used_at = null`. That is meaningful, not missing data.
- Revoking sets `revoked_at` rather than deleting, so revoked keys stay visible with their history.
- **An org with no active key is locked out of the board entirely.** Revoking the last one needs
  a real warning, not a generic confirm.

### 3.2 Card deletion

Filter cards by project and module, then delete a bad one. This is the only place in the entire
system where a card can be removed.

**Available data per card:** `card_key`, `module`, `summary`, `why_not_obvious`, `author`,
`tags[]`, `updated_at`, `created_at`, plus `decisions` (JSON array of choice/rejected/reason),
`gotchas[]`, `consumer_notes[]`, `source_refs` (JSON array of `{kind, ref}` anchors).

**On `source_refs.kind`:** the schema comment documents `commit|pr|endpoint`, but production also
carries `file` — and it is the most common value, 13 of 16 refs. Do not type this as a closed
union; a strict guard blanks most real references. Treat `kind` as a string and render what is
there.

Deletion is destructive and irreversible. The design should make the operator read enough of the
card to be sure — `summary` alone is not enough context to judge.

### 3.3 Board health

The screen that earns its keep at six months. Everything it needs already exists in the data:

- **Stale cards** — `updated_at` far in the past.
- **Unverifiable cards** — empty `source_refs`, meaning nothing anchors the claim to a commit or endpoint.
- **Suspected typo forks** — projects holding a single card, likely a misspelling of a real one.

This is a *diagnostic* surface: it should make rot visible at a glance and lead into the actions
above.

### 3.4 Project curation

What `/projects` should have been. Rename a project (the display name comes from whoever
published first, which is often wrong), and surface near-duplicate names.

**Available data:** `slug`, `name`, `created_at`, card count.

---

## 4. Hard constraints

These are not preferences. Violating them produces something that cannot be built.

**Server-rendered Astro, no client-side data fetching.** Every page reads per-tenant data on the
server. Nothing is prerendered. Interactions are `<form method="POST">` and full page loads.
There is no client-side state, no SPA routing, no fetch-on-mount, no optimistic UI. A design
that needs a spinner for data loading is a design that cannot be built here. Progressive
enhancement with a sprinkle of JS is fine; a client-side app is not.

**Broadsheet is the design system, and it is the source of truth.** It lives at
`src/styles/broadsheet.css`, imported globally, and it came from the Claude Design project
"UI mockups para Broadsheet". Retune the look *there*, not in a page. It is an editorial /
letterpress system: paper ground `#f3f2f2`, Source Serif 4 for display headings, Poppins for
UI and running text, near-square corners (1–4px radii), and cyan `#0088b0` / magenta `#d6006c`
as process inks. Style pages with inline `style="…"` attributes referencing its tokens
(`--space-*`, `--color-*`, `--font-*`) plus its component classes (`.btn`, `.input`, `.table`,
`.tag`, `.card`, `.dialog`, `.eyebrow`, `.display`). No magic hex, no px outside the space scale.

**Tailwind is gone.** Removed once no markup used a single utility. It is not in
`package.json`, not in `astro.config.mjs`, and `global.css` imports only Broadsheet. Do not
add it back: because an unlayered stylesheet outranks every cascade layer, a design system
imported alongside Tailwind silently discards any utility touching a property it declares —
which makes the utilities a trap rather than a fallback. Broadsheet's base reset carries the
parts of Tailwind's preflight the system genuinely depended on (`[hidden]`, list resets,
`box-sizing`, form-control inheritance).

**There is no dark mode.** Broadsheet is light-only by design — it is a printed page. The
earlier `dark:` variants were dropped with the Tailwind markup. Do not reintroduce a dark theme
without deciding it deliberately: it means authoring a second token set in `broadsheet.css`,
not sprinkling variants at call sites.

**Accessibility is not optional.** The existing pages already ship semantic landmarks, a skip
link, `role="alert"` on errors, labels bound to every input, and `focus-visible` rings. Match
that floor: real `<button>` and `<a href>` elements, labels rather than placeholders, keyboard
operability, and no meaning carried by color alone (a revoked key must not be distinguishable
only by being red).

**Container/presentational split.** The page frontmatter is the container: it does the queries
and maps rows to a view model. `.astro` components take props and render markup. Components
should not reach for the database.

---

## 5. The visual language

All of it lives in `src/styles/broadsheet.css`. Read that file before designing; this section
only names the parts a screen reaches for most.

- **Page shell:** the `.shell` class — `max-width: var(--shell-max)` (1400px), centred, with
  the horizontal padding. Apply it to `<main id="main">`; the masthead applies it to its own
  inner wrapper, so the brand and the page title land on the same axis. Never hand-roll a
  `max-width` + `margin:0 auto` on a page. The skip link targets `#main`, so every page needs it.
- **Measure is not the shell.** The shell is wide for tables and columns; a paragraph still
  caps itself in `ch` (the board's summaries at 72ch, the notes on `/keys` at 66–70ch).
  Widening the shell without capping the prose is how a page becomes unreadable.
- **Masthead:** owned by `Layout.astro` — brand, org label, section nav, sign-out. Pages never
  draw their own nav.
- **View title:** `.display` (44px Source Serif) plus a standfirst paragraph at 14px in
  `--color-neutral-700`, capped around 56ch.
- **Block labels:** `.eyebrow` — 12px, uppercase, `.12em` tracking.
- **Surfaces:** `.card` and `.dialog` on `--color-surface`, 1–4px radii. Elevation via
  `.elev-sm` / `.elev-md` / `.elev-lg`; the system is mostly flat and prefers a hairline
  divider to a shadow.
- **Identifiers** (slugs, card keys, key prefixes) are `--font-mono` at 12px, usually
  `--color-accent-700`.
- **Focus:** a 2px `--color-accent` outline at 2px offset, defined globally on `:focus-visible`.
- **Inks carry meaning:** cyan `--color-accent` is navigation and affirmative action; magenta
  `--color-accent-2` is destructive and "pay attention" — the token reveal, revoke, and the
  near-duplicate warnings. Never let either carry meaning alone; pair it with text.

**Known debt:** the eyebrow, input, button and alert markup are repeating across pages. Once a
fourth screen copies them, extract `TextField.astro`, `SubmitButton.astro` and `FormAlert.astro`
the way `SectionEyebrow.astro` was extracted.

---

## 6. Tone

The panel administers a board about *not stating the obvious*. It should hold itself to the same
standard: no decorative copy, no empty-state illustrations explaining what a project is, no
onboarding tour. Say the thing, show the data, offer the action.

Where the product is genuinely dangerous — a token shown once, a card deleted forever, the last
key revoked — the interface should slow down and be explicit. Everywhere else it should get out
of the way.
