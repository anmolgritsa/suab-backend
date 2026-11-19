# Suab API Reference (Postman-ready)

Base URL for all endpoints:

```
https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1
```

## Headers for every request

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer <USER_JWT>` | JWT from Supabase Auth login. **Required** for `labour-profile`. |
| `apikey` | `<SUPABASE_ANON_KEY>` | Public anon key (Dashboard → Project Settings → API). |
| `Content-Type` | `application/json` | Only when sending a body (PATCH). |

> Get a `USER_JWT` in Postman: `POST {base}/auth/v1/token?grant_type=password` with body
> `{"email": "...", "password": "..."}` — see the **Auth — login** section below.

---

## 1. Health (no auth)

`GET https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/health`

**Headers:** none needed.

**Response `200`:**
```json
{ "status": "ok", "service": "suab-backend", "function": "health", "timestamp": "2026-11-16T06:00:49.705Z" }
```

---

## 2. Labour profile

### GET — my profile (auth required)

`GET https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/labour-profile`

**Headers:** `Authorization: Bearer <USER_JWT>`, `apikey: <SUPABASE_ANON_KEY>`

**Body:** none

**Response `200`** (profile + company info):
```json
{
  "data": {
    "id": "uuid",
    "company_id": "uuid",
    "user_id": "uuid",
    "full_name": "Renamed Worker",
    "employee_code": "EMP-001",
    "phone": "9876543210",
    "role": "worker",
    "employment_type": "permanent",
    "wage_type": "hourly",
    "hourly_rate": 120.5,
    "status": "active",
    "metadata": {},
    "created_at": "...",
    "updated_at": "...",
    "company": { "id": "uuid", "name": "Acme Ltd", "slug": "acme", "industry": "textile", "size": "medium" }
  }
}
```

**Errors:**

| Status | Body | When |
|---|---|---|
| 401 | `{ "error": "Missing Authorization header (expected: Bearer <supabase-jwt>)" }` | No `Authorization` header |
| 401 | `{ "error": "Malformed JWT: expected three dot-separated segments" }` | Token is not a JWT |
| 404 | `{ "error": "No labour profile exists for the authenticated user" }` | Logged in, but no profile row |
| 500 | `{ "error": "Failed to fetch labour profile" }` | Database error |

### PATCH — update my profile (auth required)

`PATCH https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/labour-profile`

**Headers:** `Authorization: Bearer <USER_JWT>`, `apikey: <SUPABASE_ANON_KEY>`, `Content-Type: application/json`

**Body — only these two fields are allowed:**
```json
{ "full_name": "New Name", "phone": "9876543210" }
```

| Field | Type | Rules |
|---|---|---|
| `full_name` | string | required non-empty, max 200 chars |
| `phone` | string \| null | max 32 chars; digits with optional `+ ( ) - .` and spaces; `""` clears the phone |

Send one or both. Sending `{}` returns 400.

**Response `200`** (the updated profile row):
```json
{ "data": { "id": "uuid", "full_name": "New Name", "phone": "9876543210", "...": "..." } }
```

**Errors:**

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "Request body must be valid JSON" }` | Body is not JSON |
| 400 | `{ "error": "Fields cannot be changed via this endpoint: role. Permitted: full_name, phone", "rejected": ["role"] }` | Any field other than `full_name`/`phone` (e.g. `role`, `status`, `hourly_rate`, `company_id`, `user_id`) |
| 400 | `{ "error": "full_name must not be empty" }` | Empty/whitespace name |
| 400 | `{ "error": "phone contains invalid characters (digits with optional + ( ) - . space)" }` | Bad phone format |
| 400 | `{ "error": "No permitted fields provided. Permitted: full_name, phone" }` | Body `{}` |
| 401 | `{ "error": "..." }` | Missing/malformed JWT (same as GET) |
| 404 | `{ "error": "No labour profile exists for the authenticated user" }` | No profile row |
| 500 | `{ "error": "Failed to update labour profile" }` | Database error |

**Other methods** (`POST`, `PUT`, `DELETE`, ...) → `405`:
```json
{ "error": "Method not allowed. Allowed: GET, PATCH, OPTIONS" }
```

---

## 3. Auth — login (to get a USER_JWT for Postman)

This is a Supabase Auth endpoint (not an edge function), so it uses the project
root URL, not `/functions/v1`:

`POST https://ooyidpdgnelhxpoxjlkv.supabase.co/auth/v1/token?grant_type=password`

**Headers:** `apikey: <SUPABASE_ANON_KEY>`, `Content-Type: application/json`

**Body:**
```json
{ "email": "worker@example.com", "password": "your-password" }
```

**Response `200`:** copy the `access_token` value — that is your `USER_JWT` for the
`Authorization: Bearer` header. It expires (default 1 hour); just log in again.

---

## 4. Attendance (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/attendance`

**Headers:** `Authorization: Bearer <USER_JWT>` (the `apikey` header is optional but harmless).

### POST /attendance/check-in

**Body (JSON):**
```json
{ "latitude": 19.076, "longitude": 72.8777 }
```

| Field | Type | Rules |
|---|---|---|
| `latitude` | number | required, -90..90 |
| `longitude` | number | required, -180..180 |

**Response `201`** (geofence disabled — migration not yet applied):
```json
{
  "data": {
    "id": "uuid", "company_id": "uuid", "labour_profile_id": "uuid",
    "shift_id": null, "date": "2026-11-16",
    "check_in": "2026-11-16T09:48:44.767+00:00", "check_out": null,
    "status": "on_duty", "created_at": "...", "updated_at": "...",
    "location_verified": false, "distance_meters": null
  }
}
```

**Errors:**

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "latitude must be between -90 and 90" }` | GPS out of range / not a number |
| 401 | `{ "error": "..." }` | Missing/malformed JWT |
| 403 | `{ "error": "Attendance not allowed: profile status is '...'" }` | Profile not `active` |
| 403 | `{ "error": "Check-in rejected: you are outside the allowed geofence", "distance_meters": 1234, "allowed_radius_meters": 200 }` | Outside geofence (after migration) |
| 404 | `{ "error": "No labour profile exists for the authenticated user" }` | No profile row |
| 409 | `{ "error": "Attendance already recorded for today", "existing": {...} }` | Duplicate check-in (also for concurrent requests) |
| 500 | `{ "error": "Company geofence is enabled but not fully configured" }` | Geofence on but lat/lng/radius missing |

### POST /attendance/check-out

**Body:** none needed (`{}` is fine).

**Response `200`:** the updated attendance row (now with `check_out` set).

**Errors:** `401` bad JWT · `404` no check-in today · `409` already checked out · `500` DB error.

### GET /attendance/history

**Query params (optional):** `?from=YYYY-MM-DD&to=YYYY-MM-DD` (both validated, max 90 rows).

**Response `200`:**
```json
{ "data": [ { "id": "uuid", "date": "2026-11-16", "check_in": "...", "check_out": "...", "status": "on_duty", "...": "..." } ] }
```

**Errors:** `400` bad date format · `401` bad JWT · `404` no profile · `500` DB error.

**Other methods** → `405`. **Unknown route** → `404` with the list of valid routes.

---

## 5. Assignments (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/assignments`

**Headers:** `Authorization: Bearer <USER_JWT>` (the `apikey` header is optional but harmless).

### GET /assignments

**Query params (optional):** `?status=pending|in_progress|completed|cancelled|overdue`

Returns **your** assignments (current + previous), newest first, max 100. Each row
includes machine number and product type (parsed from the assignment description)
and the company supervisor.

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Weaving line 3 - cotton batch",
      "description": "Machine MC-07 | Product: Cotton fabric 40s",
      "machine_number": "MC-07",
      "product_type": "Cotton fabric 40s",
      "quantity_target": 500,
      "rate_per_unit": "2.50",
      "due_date": "2026-11-23",
      "status": "pending",
      "accepted_at": null,
      "assignment_date": "2026-11-16T...",
      "supervisor": { "name": "Priya Supervisor", "role": "supervisor" }
    }
  ]
}
```

**Errors:** `400` invalid `status` value · `401` bad JWT · `404` no profile · `500` DB error.

### POST /assignments/accept

**Body (JSON):**
```json
{ "assignment_id": "<uuid of the assignment>" }
```

Accepts one of **your own** assignments. Only `pending` assignments can be
accepted; the status becomes `in_progress` and `accepted_at` is recorded.

**Response `200`:** the updated assignment (same shape as above, `status: "in_progress"`).

**Errors:**

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "assignment_id is required (uuid of the assignment to accept)" }` | Missing/empty `assignment_id` |
| 401 | `{ "error": "..." }` | Missing/malformed JWT |
| 403 | `{ "error": "Accepting assignments not allowed: profile status is '...'" }` | Profile not `active` |
| 403 | `{ "error": "Not allowed to accept assignments yet (database policy pending approval)", "hint": "Migration 20261113120001 must be applied first" }` | Worker-accept RLS policy not applied yet |
| 404 | `{ "error": "Assignment not found (or it is not assigned to you)" }` | Unknown id, or the assignment belongs to someone else |
| 409 | `{ "error": "Assignment cannot be accepted: current status is '...'", "current_status": "..." }` | Already accepted / completed / cancelled |

**Other methods** (`PUT`, `DELETE`, ...) → `405`. **Unknown route** → `404`.

---

## 6. Shifts (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/shifts`

**Headers:** `Authorization: Bearer <USER_JWT>` (the `apikey` header is optional but harmless).

> **Note:** real shift sessions need the `shift_sessions` table (migration
> `20261113130001`, DRAFT — not applied yet). Until it is applied:
> `start`/`end` return **503** with a migration hint; `status` returns
> `{ "data": null, "hint": ... }`; `history` returns `{ "data": [], "hint": ... }`.

### POST /shifts/start

Start a shift. Body optional — send `{}` or nothing.

**Body (JSON, optional):**
```json
{ "work_assignment_id": "<uuid of YOUR accepted (in_progress) assignment>" }
```

**Response `201`** (after the migration is applied):
```json
{
  "data": {
    "id": "uuid", "company_id": "uuid", "labour_profile_id": "uuid",
    "work_assignment_id": "uuid | null", "shift_id": null,
    "shift_date": "2026-11-16", "started_at": "2026-11-16T...",
    "ended_at": null, "duration_minutes": null, "notes": null,
    "created_at": "...", "updated_at": "..."
  }
}
```

**Errors:**

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "work_assignment_id must be a non-empty string (uuid)" }` | Bad `work_assignment_id` type |
| 401 | `{ "error": "..." }` | Missing/malformed JWT |
| 403 | `{ "error": "Starting a shift not allowed: profile status is '...'" }` | Profile not `active` |
| 404 | `{ "error": "Assignment not found (or it is not assigned to you)" }` | Unknown id / someone else's assignment |
| 409 | `{ "error": "Assignment cannot be started: current status is '...'" }` | Assignment not `in_progress` (not accepted yet) |
| 409 | `{ "error": "You already have an active shift. End it before starting a new one.", "existing": {...} }` | Duplicate/active shift (also for concurrent requests) |
| 503 | `{ "error": "Shift sessions are not available yet (database table pending approval)", "hint": "Migration 20261113130001 must be applied first" }` | `shift_sessions` table not created yet |

### POST /shifts/end

End the active shift. **Body:** none needed.

**Response `200`:** the session row with `ended_at` set and `duration_minutes` computed.

**Errors:** `401` bad JWT · `404` no active shift · `503` migration pending · `500` DB error.

### GET /shifts/status

**Response `200`:** `{ "data": { ...active shift... } }` or `{ "data": null }` when no shift is active.

### GET /shifts/history

**Query params (optional):** `?limit=1..100` (default 30).

**Response `200`:** `{ "data": [ ...ended shifts, newest first... ] }`.

**Errors:** `400` bad `limit` · `401` bad JWT · `404` no profile.

**Other methods** → `405`. **Unknown route** → `404`.

---

## 7. Half-day requests (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/half-day`

**Headers:** `Authorization: Bearer <USER_JWT>`, `Content-Type: application/json` (apply/approve/reject only).

### POST /half-day/apply  (worker)

**Body (JSON):**
```json
{
  "date": "2026-11-20",
  "session": "morning",
  "reason": "Doctor appointment",
  "attachment_url": "https://example.com/voice-note.m4a"
}
```

| Field | Required | Rules |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, must be a real calendar date |
| `session` | yes | `morning` or `afternoon` |
| `reason` | no | text, max 500 chars |
| `attachment_url` | no | http(s) URL, max 1000 chars (stored via migration `20261113140001`) |

**Response `201`:** `{ "data": { ...request row, status "pending", created_at = submission time... } }`

**Errors:**

| Status | When |
|---|---|
| 400 | Missing/invalid `date`, `session` not `morning`/`afternoon`, `reason` > 500 chars, bad `attachment_url` |
| 401 | Missing/malformed JWT |
| 403 | Profile not `active` |
| 404 | No labour profile for the user |
| 409 | Already a PENDING request for that date (any session), or already APPROVED for that date+session |

### GET /half-day/status  (worker)

**Query params (optional):** `?status=pending|approved|rejected|cancelled`.

**Response `200`:** `{ "data": [ ...my requests, newest first... ] }`.

**Errors:** `400` bad `status` filter · `401` bad JWT · `404` no profile.

### GET /half-day/pending  (supervisor)

Pending requests from the supervisor's company (there is no supervisor→labourer
assignment table, so "assigned labourers" = same company). A supervisor is any
profile with role `owner` / `admin` / `manager` / `supervisor`.

**Response `200`:**
```json
{
  "data": [
    {
      "id": "…",
      "labour_name": "Anmol Worker",
      "employee_code": "EMP-001",
      "date": "2026-11-27",
      "session": "afternoon",
      "reason": "Bank visit with voice note",
      "attachment_url": "https://…",
      "status": "pending",
      "requested_at": "2026-11-17T…"
    }
  ]
}
```

**Errors:** `401` bad JWT · `403` caller is not a supervisor.

### PATCH /half-day/approve  (supervisor)

**Body (JSON):** `{ "request_id": "<id from /pending>" }`

**Response `200`:** `{ "data": { ...updated row: status "approved", reviewed_by = supervisor profile id, reviewed_at = decision time... } }`

### PATCH /half-day/reject  (supervisor)

**Body (JSON):**
```json
{ "request_id": "<id from /pending>", "review_notes": "Team is short-staffed that day" }
```

| Field | Required | Rules |
|---|---|---|
| `request_id` | yes | the pending request's id |
| `review_notes` | yes for reject | rejection reason, max 1000 chars (needs migration `20261113150001`) |

**Response `200`:** `{ "data": { ...updated row: status "rejected", review_notes stored... } }`

**Errors (approve + reject):**

| Status | When |
|---|---|
| 400 | Missing `request_id`; reject without `review_notes`; `review_notes` > 1000 chars |
| 401 | Missing/malformed JWT |
| 403 | Caller is not a supervisor, or tries to decide their OWN request |
| 404 | Unknown `request_id` or the request belongs to another company |
| 409 | Request already decided (`current_status` in the body) or lost a concurrent decision |
| 503 | `review_notes` given but migration `20261113150001` is not applied (approve works without it) |

**Other methods** → `405`. **Unknown route** → `404`.

---

## 8. Overtime requests (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/overtime`

### POST /overtime/apply — submit an overtime request

Body (JSON):

| Field | Required | Rules |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, real calendar date |
| `hours` | yes | number, `0 < hours <= 24`, max 2 decimals (e.g. `2.5`) |
| `reason` | no | text, max 500 chars |

```bash
curl.exe -s -X POST "https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/overtime/apply" -H "Authorization: Bearer USER_JWT" -H "Content-Type: application/json" -d '{"date":"2026-11-26","hours":2.5,"reason":"Shipping deadline"}'
```

`201`:
```json
{ "data": { "id": "…", "date": "2026-11-26", "hours": 2.5, "status": "pending", "created_at": "…" } }
```

Errors: `400` bad/missing date, hours not a number, `hours <= 0`, `hours > 24` ·
`403` profile not active · `404` no labour profile for this user ·
`409` a PENDING or APPROVED request already exists for that date (rejected/cancelled never block) ·
`401` bad token · `405` wrong method.

### GET /overtime/status — my requests, newest first

Optional filter: `?status=pending|approved|rejected|cancelled` (anything else → `400`).

```bash
curl.exe -s "https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/overtime/status" -H "Authorization: Bearer USER_JWT"
```

`200`:
```json
{ "data": [ { "id": "…", "date": "2026-11-26", "hours": 2.5, "reason": "Shipping deadline", "status": "pending", "reviewed_at": null, "created_at": "…" } ] }
```

**Duplicate rule:** one PENDING request per date (any hours value). A concurrent
race is caught by unique index `uq_overtime_requests_pending` (migration
`20261113160001`) — until that migration is applied the function's pre-check is
the only guard.

---

## 9. Work submissions (auth required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/work-submission`

### POST /work-submission — log output against one of my assignments

```json
{
  "work_assignment_id": "uuid — required, must be YOUR assignment",
  "quantity_successful": 120,
  "quantity_rejected": 8,
  "quantity_reusable": 3,
  "attachment_url": "https://example.com/voice-note.m4a",
  "notes": "Line A output"
}
```

- `work_assignment_id` required (UUID). `quantity_successful` defaults to 0;
  at least one of the three quantities must be > 0. `notes` ≤ 500 chars.
  `attachment_url` optional http(s) URL ≤ 1000 chars (voice note or image).
- The assignment must be `in_progress` or `completed` (`pending`/`cancelled`
  → `409`). Multiple submissions per assignment are allowed (piece-rate logs).
- The successful quantity is stored in the existing `quantity` column;
  `quantity_rejected` / `quantity_reusable` / `attachment_url` need migration
  `20261113170001` — until it is applied those fields are accepted but NOT
  stored and the `201` response carries an explicit `warning`.

Errors: `400` bad/missing id, non-integer/negative quantities, all-zero
quantities, bad attachment URL · `403` profile not active · `404` assignment
not found or not yours · `409` assignment not in a submittable state ·
`401` bad token · `405` wrong method.

`201`:
```json
{ "data": { "id": "…", "work_assignment_id": "…",
  "assignment": { "title": "Dyeing unit support - batch 12", "machine_number": "DY-02",
                  "product_type": "Polyester b", "quantity_target": 500, "status": "in_progress" },
  "quantity_successful": 120, "quantity_rejected": 8, "quantity_reusable": 3,
  "attachment_url": "https://…", "notes": "Line A output", "submitted_at": "…" } }
```

### GET /work-submission — my submissions, newest first

Optional filter: `?assignment_id=<uuid>` (anything non-UUID → `400`).

```bash
curl.exe -s "https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/work-submission" -H "Authorization: Bearer USER_JWT"
```

`200`: `{ "data": [ …same shape as the 201 above… ] }` — each row embeds the
assignment (title, machine number, product type, target, status).

---

## 10. Supervisor work history & summary (supervisor role required)

Roles that count: `owner`, `admin`, `manager`, `supervisor` — workers get `403`.
Scope: all labourers in the supervisor's company (no supervisor→labourer
assignment table exists in the schema).

### GET /supervisor/work-history

Filters (all optional): `?labour_id=<uuid>` · `?from=YYYY-MM-DD` · `?to=YYYY-MM-DD`
(dates are company-timezone calendar days; `from > to` → `400`).

```bash
curl.exe -s "https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/supervisor/work-history?from=2026-11-18&to=2026-11-18" -H "Authorization: Bearer SUPERVISOR_JWT"
```

`200`:
```json
{ "data": [ {
    "id": "…",
    "labour": { "id": "…", "name": "Anmol Worker", "employee_code": "EMP-001" },
    "assignment": { "id": "…", "title": "Weaving line 3 - cotton batch",
                    "machine_number": "MC-07", "product_type": "Cotton fabric 40s",
                    "quantity_target": 500, "status": "in_progress" },
    "quantity_successful": 120, "quantity_rejected": null, "quantity_reusable": null,
    "attachment_url": null, "notes": "Line A output",
    "submitted_at": "2026-11-18T07:48:16.110572+00:00" } ] }
```
`quantity_rejected` / `quantity_reusable` / `attachment_url` are `null` until
migration `20261113170001` is applied.

### GET /supervisor/work-summary

Optional `?date=YYYY-MM-DD` — default is **today in the company timezone**
(`Asia/Kolkata` unless `companies.settings.timezone` says otherwise).

```bash
curl.exe -s "https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/supervisor/work-summary?date=2026-11-18" -H "Authorization: Bearer SUPERVISOR_JWT"
```

`200`:
```json
{ "data": { "date": "2026-11-18",
            "totals": { "successful": 480, "rejected": 0, "reusable": 0 },
            "submissions_count": 5, "labourers_count": 1 } }
```

Errors: `401` no/bad token · `403` not a supervisor · `400` bad `labour_id` /
bad date / `from > to` · `404` unknown route · `405` non-GET.

---

## 11. Supervisor attendance (supervisor role required)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1`

### GET /supervisor/attendance

Attendance records for the supervisor's company. Filters (all optional):
`?labour_id=<uuid>` · `?date=YYYY-MM-DD` · `?from=YYYY-MM-DD&to=YYYY-MM-DD`
(inclusive range; `date` and `from/to` are mutually exclusive in practice —
`date` wins as an exact match).

Response `200`:
```json
{
  "data": [
    {
      "id": "d5f79aae-...",
      "labour": { "id": "8acf0cb9-...", "name": "Anmol Worker", "employee_code": "EMP-001" },
      "date": "2026-11-16",
      "status": "on_duty",
      "check_in": "2026-11-16T10:05:00+00:00",
      "check_out": "2026-11-16T18:30:00+00:00",
      "shift_id": null
    }
  ]
}
```
`status` is the `attendance_status` enum: `present / absent / late / half_day /
leave / holiday / on_duty`. Times are UTC ISO strings.

### GET /supervisor/attendance-summary

Counts for one date (default: today in the company timezone). `?date=YYYY-MM-DD`.

Response `200`:
```json
{
  "data": {
    "date": "2026-11-16",
    "totals": { "present": 1, "absent": 0, "half_day": 0, "leave": 0, "holiday": 0 },
    "records_count": 1
  }
}
```
The `present` bucket includes `present`, `late` and `on_duty` (all mean "was at
work"). `records_count` is the raw number of attendance rows that day.

Errors: `401` no/bad token · `403` not a supervisor · `400` bad `labour_id` /
bad date / `from > to` · `404` unknown route · `405` non-GET.

---

## 12. Supervisor — machine assignments (Step 4.11)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/supervisor`
(same function as §10–§11; supervisor token required on all three).

### POST /supervisor/assignments — assign a machine/task

Body (all of `labour_id`, `title`, `machine_number`, `product_type`,
`quantity_target` required; `due_date`, `instructions` optional):

```json
{
  "labour_id": "8acf0cb9-4dcb-4574-8bb6-e0bfa164ee92",
  "title": "Weaving shift A - batch 21",
  "machine_number": "MC-11",
  "product_type": "Cotton fabric 60s",
  "quantity_target": 250,
  "due_date": "2026-11-25",
  "instructions": "Check tension every 2 hours"
}
```

Response `201`:

```json
{
  "data": {
    "id": "cc59e30e-...",
    "title": "Weaving shift A - batch 21",
    "machine_number": "MC-11",
    "product_type": "Cotton fabric 60s",
    "quantity_target": 250,
    "due_date": "2026-11-25",
    "status": "pending",
    "assigned_by": null,
    "assignment_date": "2026-11-18T..."
  }
}
```

Notes:
- The labourer must belong to the supervisor's company and be an **active
  worker** (assigning a supervisor → 400; another company's labourer → 404).
- Machine/product/instructions are stored in `description` using the shared
  `"Machine X | Product: Y | Instructions: Z"` convention (no dedicated
  columns in the schema).
- `assigned_by` stays `null` until migration `20261113180001` is applied;
  until then the response carries a `warning` saying so.

### GET /supervisor/assignments — list (filters optional)

`?labour_id=<uuid>` · `?date=YYYY-MM-DD` (creation day, company timezone) ·
`?status=pending|in_progress|completed|cancelled|overdue`

Response `200`: `{ "data": [ { ...same shape as POST..., "labour": { "id",
"name", "employee_code" } } ] }` — newest first, max 200.

### PATCH /supervisor/assignments — update status

Body: `{ "assignment_id": "<uuid>", "status": "<new status>" }`

Allowed transitions (supervisor-side):

| From | To |
|---|---|
| `pending` | `in_progress`, `cancelled`, `overdue` |
| `in_progress` | `completed`, `cancelled`, `overdue` |
| `overdue` | `in_progress`, `cancelled` |

`completed` and `cancelled` are **frozen** — any change returns `409`. Setting
the same status again → `409`. Invalid transition → `409` with the allowed
list. Unknown id → `404`. Bad UUID / bad status / missing id → `400`.

Errors everywhere: `401` no/bad token · `403` not a supervisor · `404` unknown
route · `405` non-GET/POST/PATCH.

---

## 13. Supervisor — overtime approval (Step 4.12)

Base: `https://ooyidpdgnelhxpoxjlkv.supabase.co/functions/v1/supervisor`
(same function as §10–§12; supervisor token required).

### GET /supervisor/overtime/pending — pending requests

Response `200`:

```json
{
  "data": [
    {
      "id": "d45812ec-...",
      "labour_name": "Anmol Worker",
      "employee_code": "EMP-001",
      "date": "2026-11-29",
      "hours": 1.5,
      "reason": "Shipping deadline",
      "status": "pending",
      "requested_at": "2026-11-19T..."
    }
  ]
}
```

### PATCH /supervisor/overtime/approve — approve one request

Body: `{ "request_id": "<uuid from pending list>" }`

Response `200`: `{ "data": { "id": "...", "status": "approved",
"reviewed_by": "<supervisor profile id>", "reviewed_at": "...", ... } }`

### PATCH /supervisor/overtime/reject — reject one request

Body: `{ "request_id": "<uuid>", "review_notes": "optional rejection reason" }`

`review_notes` is **optional** here (unlike half-day, where it is required).
It stores in `overtime_requests.review_notes` — a column added by migration
`20261113190001`. Until that migration is applied, a reject WITH notes returns
`503` + hint (approve and reject-without-notes work fine).

Shared rules (same model as half-day approval, §7):
- Worker token → `403` "Supervisor role required"
- Self-decision (supervisor's own request) → `403`
- Already decided → `409` with `current_status` (only `pending` can be decided;
  two supervisors racing → one wins, the other gets 409)
- Unknown id / another company's request → `404` (no existence leak)
- Missing id / bad UUID → `400`

---

## 14. Supervisor labourers

Directory of the supervisor's company labourers. "Assigned to the supervisor"
= same company (no supervisor→labourer assignment table exists in the schema).
Sensitive auth data (`user_id`) is never returned.

### GET /supervisor/labourers

Response `200` — one row per worker, each with their current (open) assignment:

```json
{
  "data": [
    {
      "id": "8acf0cb9-...",
      "labour_name": "Anmol Worker",
      "employee_code": "EMP-001",
      "phone": "9998887776",
      "employment_type": "full_time",
      "wage_type": "monthly",
      "hourly_rate": 120.5,
      "profile_status": "active",
      "member_since": "2026-11-16T07:27:29Z",
      "current_assignment": {
        "id": "735863d5-...",
        "title": "Weaving shift B - batch 23",
        "machine_number": "MC-12",
        "product_type": "Cotton fabric 40s",
        "quantity_target": 300,
        "due_date": "2026-11-26",
        "status": "pending",
        "accepted_at": null,
        "assignment_date": "2026-11-19T07:58:57Z"
      }
    }
  ]
}
```

`current_assignment` is `null` when the labourer has no open (pending /
in_progress / overdue) assignment. Supervisors themselves are not listed.

### GET /supervisor/labourers/:id

Response `200` — one labourer's profile plus their 10 most recent assignments
(same shape as `current_assignment`, under `assignments`), plus `role` and
`metadata`.

Errors (both endpoints):
- Worker token → `403` "Supervisor role required"
- No token → `401`
- Non-UUID id → `400` "labourer id must be a valid UUID"
- Unknown id / another company's labourer → `404` (no existence leak)

---

## 15. CORS

All endpoints answer `OPTIONS` with `200` and permissive CORS headers, so you can
also call them from a browser app.
