# Suab — Backend

Backend scaffold for **Suab**: Supabase PostgreSQL, Supabase Edge Functions (Deno),
Supabase Auth and Supabase Storage. No business functionality is implemented yet.

## Stack

- **Database** — Supabase PostgreSQL
- **API** — Supabase Edge Functions (Deno + TypeScript)
- **Auth** — Supabase Auth
- **Storage** — Supabase Storage
- **Types** — TypeScript (strict) with generated `Database` types

## Prerequisites

- [Node.js](https://nodejs.org) >= 20 and npm
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  (installed locally as a dev dependency in this repo — `npx supabase --version`)
- [Deno](https://deno.com) >= 2 (installed locally as a dev dependency — `npx deno --version`)

## Getting started

```bash
npm install                 # installs supabase CLI + deno as dev dependencies
cp .env.example .env        # then fill in SUPABASE_URL / keys from the dashboard
npx supabase login          # link to your hosted project (optional, for push/deploy)
npx supabase link --project-ref <your-project-ref>
```

## Folder structure

```
supabase/
├── config.toml              # Supabase CLI project config (from `supabase init`)
├── functions/
│   ├── deno.json            # Deno config + import map for edge functions
│   ├── health/index.ts      # sample health-check edge function
│   └── _shared/             # shared edge-function utilities (cors, mod)
└── migrations/              # SQL migrations (empty for now)
shared/                      # shared TS utilities/constants (Node-side)
types/                       # generated Supabase Database types (stub)
docs/ARCHITECTURE.md         # architecture notes
```

## Common commands

| Command                        | What it does                                    |
| ------------------------------ | ----------------------------------------------- |
| `npm run typecheck`            | Typecheck `shared/` and `types/` with `tsc`     |
| `npm run functions:check`      | Typecheck edge functions with `deno check`      |
| `npm run functions:serve`      | Serve `health` locally (`supabase functions serve health`) |
| `npm run start` / `stop`       | Start/stop the local Supabase stack             |
| `npm run db:migration:new`     | Create a new SQL migration file                 |
| `npm run db:push`              | Apply migrations to the linked database         |
| `npm run db:reset`             | Recreate local DB and replay all migrations     |
| `npm run gen:types`            | Regenerate `types/database.generated.ts`        |

## Running functions locally

```bash
npx supabase start                  # boots local Postgres, Auth, Storage, API gateway
npx supabase functions serve health # serves the health function
# then:
curl http://127.0.0.1:54321/functions/v1/health
```

## Applying migrations

```bash
npx supabase migration new create_initial_schema   # creates supabase/migrations/<ts>_create_initial_schema.sql
# edit the SQL file, then:
npx supabase db push        # apply to linked/remote database
npx supabase db reset       # recreate local database from all migrations
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values from
*Supabase Dashboard → Project Settings → API*:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — **server-side only**, bypasses RLS; never expose to clients.

## Testing the APIs (Postman)

All URLs, headers and payloads are documented in **[docs/API.md](docs/API.md)** —
including how to get a user JWT via the Supabase Auth login endpoint.

## Notes

- Edge functions run on Deno and import shared code from `supabase/functions/_shared/`.
- `types/index.ts` is a placeholder stub; regenerate real types with `npm run gen:types`
  once migrations create tables.
