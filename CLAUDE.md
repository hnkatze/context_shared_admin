# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The **admin panel** for `context_shared` — a cloud board where agents publish *selectively curated*
context (not a full sync). A backend publishes the non-obvious logic of a module that the Swagger
does not express; the frontend consumes it. Hierarchy is `org → project → card`.

This repo holds **only the panel**. The MCP server, the SQL migrations, and the seed live in a
separate repo at `C:\Users\henri\personal\context-shared` (`mcp/`, `supabase/`). The panel reads
the same Postgres the MCP writes to.

`BOARDROOM.md` is the design brief: what each screen is for, what data it has, and the visual
system. Read it before building or restyling a screen.

## Stack

Astro 7 with `@astrojs/vercel`, `output: "server"`, `pg` against Supabase. Styling is the
hand-written **Broadsheet** design system in `src/styles/broadsheet.css` — no CSS framework.
Node `>=22.12.0`, ESM only.

## Commands

| Command | Action |
| :-- | :-- |
| `npm run dev` | Dev server on `localhost:4321` |
| `npm run check` | `astro check` — typecheck `.astro` and `.ts` |
| `npm run build` | Build the Vercel function into `.vercel/output/` |
| `npm run preview` | Serve the built output |

Start the dev server in background mode: `astro dev --background`. Manage it with
`astro dev stop`, `astro dev status`, `astro dev logs`.

`npm run check` and `npm run build` are the two verification gates. There is no test runner, no
linter, and no formatter configured — do not claim a test or lint pass, there is nothing to run.
Neither gate touches the database, so any change to `db.ts` or to a page's query needs the dev
server hit and the rendered output inspected before it counts as working.

## Development database — READ THIS FIRST

**`.env` currently points at PRODUCTION Supabase**, not at the local Docker Postgres. Check
before running anything that writes:

```bash
grep -o 'CONTEXT_SHARED_DATABASE_URL=postgresql://[^:]*' .env   # the role
grep -o '@[^/]*' .env | head -1                                 # the host
```

A `pooler.supabase.com` host means production: real cards, the real API key, real consequences.
The connection role is `context_app` there (not `mcp_app`), and it has neither `BYPASSRLS` nor
superuser, so RLS is genuinely enforced — but a stray `delete` is still a stray delete.

The alternative is a **local throwaway Postgres in Docker** (`localhost:55432`, container
`ctxpg`). It is brought up by `scripts/dev-up.sh` **in the other repo**
(`C:\Users\henri\personal\context-shared`), which recreates the database, applies
`supabase/migrations/0001_init.sql`, loads `supabase/seed/dev_seed.sql`, and prints the two env
values the panel expects.

That script drops and recreates the database every run, so any card published locally is lost.
If the panel renders "Could not reach the board", check the container before suspecting the code:
`docker ps` for `ctxpg`, then confirm the `context_shared` database still exists — a half-finished
`dev-up.sh` leaves the cluster-level role `mcp_app` behind while the database is gone, which
surfaces as `password authentication failed`.

## Architecture notes

- **In production `CONTEXT_SHARED_DATABASE_URL` must point at the Supabase pooler in transaction
  mode (port 6543), never at the direct connection (5432).** The pool is capped at `max: 1`
  because Vercel runs many isolated instances and a larger per-instance pool exhausts Postgres.
- **Tenancy is enforced per transaction, not per session.** `withTenant()` opens a transaction and
  calls `set_config('app.current_org_id', $1, true)` — the `true` scopes the value to that
  transaction. A session-scoped setting would leak one tenant's id onto the next request sharing
  the same pooled backend. Never relax that third argument, and never read tenant data outside
  `withTenant`.
- **Human auth is built.** One organization per deployment from `PANEL_ORG_ID`, guarded by a
  single admin password hash and a signed session cookie. `PANEL_PASSWORD_HASH` is scrypt in the
  form `scrypt:N:r:p:salt:key` — **colon-separated, because Vite expands `$` inside a `.env`** and
  a `$`-separated hash arrives truncated with a zero-length key. The cookie is signed with
  `PANEL_SESSION_SECRET` **plus** the password hash, so rotating the password invalidates every
  open session without a session store. `src/middleware.ts` closes every route and opens by
  exception. There is no users table and no `currentOrgId()`; pages resolve the tenant with
  `panelOrgId()`, which validates the id against `organizations` once per instance.
- **Nothing is prerendered** (`output: "server"`); every page reads per-tenant data.
- **Tailwind was removed.** `src/styles/global.css` imports only `broadsheet.css`, the design
  system imported from the Claude Design project "UI mockups para Broadsheet". Retune the look
  there, never in a page. Do not reinstall Tailwind: an unlayered stylesheet outranks every
  cascade layer, so a design system sitting beside Tailwind silently discards any utility that
  touches a property it declares — the utilities become a trap, not a fallback. Broadsheet's base
  reset carries the preflight rules the system genuinely depended on (`[hidden]`, list resets,
  `box-sizing`, form-control inheritance).
- Pages style themselves with Broadsheet classes plus inline `style="…"` referencing its tokens
  (`--space-*`, `--color-*`, `--shell-max`). `.shell` owns the page measure and the masthead
  shares it, so the brand and the page title sit on one axis. Prose still caps itself in `ch`.
  There is no dark mode: the system is light-only by design.
- `src/layouts/Layout.astro` owns the `<html>` shell, the `global.css` import, the masthead and
  the skip link. It takes a required `title` prop plus optional `orgLabel` and `chrome`. Every
  page renders through it, and every page supplies its own `<main id="main">` — the skip link
  targets it.
- `tsconfig.json` extends `astro/tsconfigs/strict`, which does **not** include
  `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`.

## Pending work

1. **Rotate the leaked credentials.** An early `.env.example` carried a real Supabase pooler
   password and a live `ctx_` API token. The file now holds placeholders, but the credentials
   themselves are still valid and must be rotated in Supabase and in the MCP client config.
2. **`src/lib/db.ts` duplicates `withTenant` from `mcp/src/db/pool.ts`** in the other repo. It is
   the second consumer, so the logic belongs in a shared package — but the two now live in
   separate repos, so that means publishing one, not an npm workspace.
3. **Screens designed but not built:** `/cards` (filter and delete a bad card — the only place a
   card can be removed) and `/health` (stale cards, cards with empty `source_refs`, suspected
   typo forks). Both are specified in `BOARDROOM.md`. The nav renders them as plain labels rather
   than links until they exist.
4. **Inline-style debt.** The pages carry many static `style="…"` attributes that should be
   Broadsheet component classes — an inline declaration cannot be overridden and cannot carry
   `:hover`/`:focus`/media queries, which has already killed designed states once.

## Known issue

`npm audit` reports 3 high-severity advisories for `path-to-regexp` (ReDoS), pulled in transitively
by `@vercel/routing-utils` ← `@astrojs/vercel@11`. `npm audit fix --force` "resolves" it by
downgrading to `@astrojs/vercel@8`, which is a breaking downgrade — do not run it. The affected
code is Vercel's build-time routing, not a runtime path fed by user input.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
