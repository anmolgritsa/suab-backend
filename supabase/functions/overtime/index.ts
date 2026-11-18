// Supabase Edge Function: overtime
//
// WHAT IT DOES (labour-side only)
//   POST /overtime/apply   -> submit an overtime request (status = pending)
//   GET  /overtime/status  -> my overtime requests (optionally filtered by status)
//
// AUTH
//   Same pattern as the other functions: anon key + the caller's user JWT.
//   RLS is the real boundary. The service-role key is NEVER used here.
//
// SCHEMA (verified against the live database before coding)
//   overtime_requests: id, company_id, labour_profile_id, date,
//     hours numeric(4,2) CHECK (hours > 0), reason, status, reviewed_by,
//     reviewed_at, created_at, updated_at
//   status enum (request_status): 'pending' | 'approved' | 'rejected' | 'cancelled'
//   created_at = submission time (set by the database)
//   reviewed_by / reviewed_at are filled later by a supervisor endpoint.
//
// VALIDATION
//   date  : required, YYYY-MM-DD, must be a real calendar date
//   hours : required number, 0 < hours <= 24 (a day has 24 hours),
//           rounded to 2 decimals (the column is numeric(4,2), max 99.99)
//   reason: optional text, max 500 chars
//
// DUPLICATE / CONFLICT RULES (enforced here, before insert)
//   - a PENDING request for the same date blocks a new one  -> 409
//   - an APPROVED request for the same date blocks a new one -> 409
//   - rejected/cancelled requests never block (you may re-apply)
//   NOTE: unlike half_day_requests there is NO unique index on
//   (labour_profile_id, date) yet — migration 20261113160001 (DRAFT) adds one
//   as a hard guard against two simultaneous requests. Until it is applied the
//   pre-check below is the only guard, so a true race could slip through.
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }
//   error   -> { "error": "message" }

// deno-lint-ignore-file no-explicit-any
import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// --- small row types --------------------------------------------------------
interface LabourProfile {
  id: string;
  company_id: string;
  status: string;
}

interface OvertimeRequestRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  date: string;
  hours: number;
  reason: string | null;
  status: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Valid ?status= filter values for GET /overtime/status (must match the enum).
const VALID_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** Last path segment: /overtime/apply -> "apply". */
function routeName(req: Request): string {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  return path.split('/').pop() ?? '';
}

// ---------------------------------------------------------------------------
// ENTRYPOINT — routing, CORS, auth
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight (browsers send OPTIONS first).
  const preflight = OPTIONS(req);
  if (preflight) return preflight;

  // Only GET and POST are supported.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(['GET', 'POST', 'OPTIONS']);
  }

  // Read + decode the JWT from the Authorization header.
  let userId: string;
  let jwt: string;
  try {
    const ctx = contextFromRequest(req);
    userId = ctx.userId;
    jwt = ctx.jwt;
  } catch (err) {
    const message = err instanceof AuthError ? err.message : 'Unauthorized: missing or malformed Authorization header';
    return json({ error: message }, 401);
  }

  // Supabase client as THIS user (anon key + their JWT). RLS is the boundary.
  const supabase = createClientForUser(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, jwt);

  // Route by the last path segment.
  const route = routeName(req);
  try {
    if (req.method === 'POST' && route === 'apply') return await handleApply(req, supabase, userId);
    if (req.method === 'GET' && route === 'status') return await handleStatus(req, supabase, userId);
    return json({ error: 'Unknown route. Use /overtime/apply (POST) or /overtime/status (GET)' }, 404);
  } catch (err) {
    console.error('[overtime] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /overtime/apply — submit an overtime request
// ---------------------------------------------------------------------------
async function handleApply(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Parse the JSON body.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }

  // 2. Validate "date" — required, YYYY-MM-DD, must be a real calendar date.
  const dateRaw = body['date'];
  if (typeof dateRaw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return json({ error: 'date is required in YYYY-MM-DD format' }, 400);
  }
  const parsedDate = new Date(`${dateRaw}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dateRaw) {
    return json({ error: `date is not a valid calendar date: ${dateRaw}` }, 400);
  }

  // 3. Validate "hours" — required number, 0 < hours <= 24, 2 decimals max.
  const hoursRaw = body['hours'];
  if (typeof hoursRaw !== 'number' || !Number.isFinite(hoursRaw)) {
    return json({ error: 'hours is required and must be a number (e.g. 2.5)' }, 400);
  }
  const hours = Math.round(hoursRaw * 100) / 100; // numeric(4,2) holds 2 decimals
  if (hours <= 0) return json({ error: 'hours must be greater than 0' }, 400);
  if (hours > 24) return json({ error: 'hours cannot exceed 24 for a single day' }, 400);

  // 4. Validate optional "reason" (text, max 500 chars).
  const reason = body['reason'];
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    return json({ error: 'reason must be a string of at most 500 characters' }, 400);
  }

  // 5. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Applying not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 6. Duplicate / conflict check for the same date.
  const { data: sameDay, error: dupErr } = await supabase
    .from('overtime_requests')
    .select('id, date, status')
    .eq('labour_profile_id', profile.id)
    .eq('date', dateRaw);
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  for (const r of (sameDay ?? []) as { status: string }[]) {
    if (r.status === 'pending') {
      return json({
        error: `You already have a PENDING overtime request for ${dateRaw}. Wait for a decision or ask your supervisor to reject it.`,
        existing_status: r.status,
      }, 409);
    }
    if (r.status === 'approved') {
      return json({
        error: `Overtime is already APPROVED for ${dateRaw}.`,
        existing_status: r.status,
      }, 409);
    }
  }

  // 7. Insert the request. status defaults to 'pending' in the database;
  //    created_at (submission time) is set by the database too.
  const payload = {
    company_id: profile.company_id,
    labour_profile_id: profile.id,
    date: dateRaw,
    hours,
    reason: typeof reason === 'string' ? reason : null,
    status: 'pending',
  };
  const { data, error } = await supabase
    .from('overtime_requests')
    .insert(payload)
    .select()
    .maybeSingle();

  if (error) {
    // 23505 -> the partial unique index (migration 20261113160001) caught a race.
    if (error.code === '23505') {
      return json({ error: 'You already have a pending overtime request for this date (concurrent request)' }, 409);
    }
    console.error('[overtime] insert error:', error.message);
    return json({ error: 'Failed to submit overtime request' }, 500);
  }

  // 201 Created.
  return json({ data: data as OvertimeRequestRow | null }, 201);
}

// ---------------------------------------------------------------------------
// GET /overtime/status — my requests, newest first
// ---------------------------------------------------------------------------
async function handleStatus(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional ?status= filter (pending | approved | rejected | cancelled).
  const statusParam = new URL(req.url).searchParams.get('status');
  let query = supabase
    .from('overtime_requests')
    .select('*')
    .eq('labour_profile_id', profile.id) // only MY requests, even though RLS allows the whole company
    .order('created_at', { ascending: false });
  if (statusParam !== null) {
    if (!(VALID_STATUSES as readonly string[]).includes(statusParam)) {
      return json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
    }
    query = query.eq('status', statusParam);
  }

  const { data, error } = await query;
  if (error) throw new Error(`status query failed: ${error.message}`);
  return json({ data }, 200);
}

// ---------------------------------------------------------------------------
// Small helper
// ---------------------------------------------------------------------------

/** Fetch the caller's own labour profile (RLS limits this to their row). */
async function loadProfile(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<LabourProfile | null> {
  const { data, error } = await supabase
    .from('labour_profiles')
    .select('id, company_id, status')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return (data as LabourProfile | null);
}
