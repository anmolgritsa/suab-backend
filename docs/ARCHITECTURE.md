# Suab — Backend Architecture

## Stack

| Layer            | Technology                                    |
| ---------------- | --------------------------------------------- |
| Database         | Supabase PostgreSQL                           |
| API / Compute    | Supabase Edge Functions (Deno, TypeScript)    |
| Authentication   | Supabase Auth                                 |
| File storage     | Supabase Storage                              |
| Type safety      | TypeScript (strict) + generated `Database` types |

No business functionality is implemented yet — this repository is the scaffold.

## Folder structure

```
suab-backend/
├── supabase/
│   ├── config.toml            # Supabase CLI project config (created by `supabase init`)
│   ├── functions/             # Edge Functions (Deno runtime)
│   │   ├── deno.json          # Deno config + import map for functions
│   │   ├── health/            # Sample health-check function
│   │   │   └── index.ts
│   │   └── _shared/           # Code shared between edge functions
│   │       ├── mod.ts
│   │       └── cors.ts
│   └── migrations/            # SQL migrations (empty; use `supabase migration new`)
├── shared/                    # TypeScript utilities/constants (Node-side)
├── types/                     # Generated Supabase `Database` types (stub for now)
├── docs/                      # Architecture & other documentation
├── tsconfig.json              # Strict TypeScript config (shared/, types/)
├── package.json               # Scripts: typecheck, functions:serve, db:*, gen:types
├── .env.example               # SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY
└── README.md
```

## Conventions

- **Edge functions** live in `supabase/functions/<name>/index.ts`, run on Deno, and
  share code via `supabase/functions/_shared/`. The import map in
  `supabase/functions/deno.json` pins remote dependencies (e.g. `@supabase/supabase-js`).
- **Migrations** are plain SQL files in `supabase/migrations/`, applied with
  `supabase db push` (or automatically by `supabase db reset` locally).
- **Database types** in `types/` are generated from the live schema with
  `npm run gen:types` — never hand-edit `database.generated.ts`.
- **Secrets** live in `.env` (git-ignored). The `service_role` key must only ever be
  used server-side (edge functions with a service client), never in client apps.

## Request flow (target)

```
Client ──▶ Supabase Auth (JWT)
              │
              ▼
        Edge Function (Deno) ──▶ PostgreSQL (RLS enforced)
              │
              ├──▶ Storage (files, storage policies)
              └──▶ service_role client (trusted server-side writes only)
```
