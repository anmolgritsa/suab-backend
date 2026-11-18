// Supabase Edge Function: shifts
//
// WHAT IT DOES
//   POST /shifts/start    -> start a shift (optionally linked to an accepted assignment)
//   POST /shifts/end      -> end my active shift (records duration)
//   GET  /shifts/status   -> my current active shift (or null)
//   GET  /shifts/history  -> my past (ended) shifts
//
// AUTH
//   Same pattern as attendance/assignments: anon key + the caller's user JWT.
//   RLS is the real boundary. The service-role key is NEVER used here.
//
// SCHEMA NOTE (verified against the live database before coding)
//   The existing `shifts` table is a TEMPLATE table (name, start_time,
//   end_time, break_minutes per company) — it cannot record real sessions.
//   Real sessions live in `shift_sessions` (migration 20261113130001, DRAFT).
//   Until that migration is applied, start/end return 503 with a clear hint;
//   status/history return empty data instead of failing.
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

interface AssignmentRow {
  id: string;
  status: string;
}

interface ShiftSessionRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  work_assignment_id: string | null;
  shift_id: string | null;
  shift_date: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Last path segment: /shifts/start -> "start". */
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
    if (req.method === 'POST' && route === 'start') return await handleStart(req, supabase, userId);
    if (req.method === 'POST' && route === 'end') return await handleEnd(supabase, userId);
    if (req.method === 'GET' && route === 'status') return await handleStatus(supabase, userId);
    if (req.method === 'GET' && route === 'history') return await handleHistory(req, supabase, userId);
    return json({ error: 'Unknown route. Use /shifts/start, /shifts/end, /shifts/status, /shifts/history' }, 404);
  } catch (err) {
    console.error('[shifts] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /shifts/start — start a shift (one active shift per labourer)
// ---------------------------------------------------------------------------
async function handleStart(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Parse the optional JSON body: { "work_assignment_id": "<uuid>" }.
  let body: Record<string, unknown> = {};
  if ((req.headers.get('content-length') ?? '') !== '0') {
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Request body must be valid JSON' }, 400);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }
  }
  const assignmentId = body['work_assignment_id'];
  if (assignmentId !== undefined && (typeof assignmentId !== 'string' || assignmentId.length === 0)) {
    return json({ error: 'work_assignment_id must be a non-empty string (uuid)' }, 400);
  }
  // If provided, must be a valid UUID — a non-UUID string would make PostgREST
  // throw a cast error (22P02) which would surface as a 500. Copy ids from
  // GET /assignments.
  if (
    typeof assignmentId === 'string' &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)
  ) {
    return json({ error: 'work_assignment_id must be a valid UUID — copy an id from GET /assignments' }, 400);
  }

  // 2. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Starting a shift not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 3. Optional: link to one of MY accepted (in_progress) assignments.
  let assignment: AssignmentRow | null = null;
  if (typeof assignmentId === 'string') {
    const { data, error } = await supabase
      .from('work_assignments')
      .select('*')
      .eq('id', assignmentId)
      .eq('labour_profile_id', profile.id) // only my own assignments
      .maybeSingle();
    if (error) throw new Error(`assignment lookup failed: ${error.message}`);
    assignment = (data as AssignmentRow | null);
    if (!assignment) {
      return json({ error: 'Assignment not found (or it is not assigned to you)' }, 404);
    }
    // Only an ACCEPTED assignment (in_progress) can be worked on.
    if (assignment.status !== 'in_progress') {
      return json({
        error: `Assignment cannot be started: current status is '${assignment.status}' (only 'in_progress' can be started)`,
        current_status: assignment.status,
      }, 409);
    }
  }

  // 4. Duplicate check: do I already have an active (not ended) shift?
  const active = await findActiveSession(supabase, profile.id);
  // Missing table -> migration pending (same hint as the insert below).
  if (active.error?.code === '42P01' || active.error?.code === 'PGRST205') {
    return json({
      error: 'Shift sessions are not available yet (database table pending approval)',
      hint: 'Migration 20261113130001 must be applied first',
    }, 503);
  }
  if (active.error) throw new Error(`active-shift lookup failed: ${active.error.message}`);
  if (active.row) {
    return json({
      error: 'You already have an active shift. End it before starting a new one.',
      existing: active.row,
    }, 409);
  }

  // 5. Insert the session. The partial unique index
  //    (uq_shift_sessions_one_active_per_profile) is the final guard against
  //    concurrent starts -> 23505 means another request won the race.
  const { data: inserted, error: insertErr } = await supabase
    .from('shift_sessions')
    .insert({
      company_id: profile.company_id,
      labour_profile_id: profile.id,
      work_assignment_id: assignment?.id ?? null,
      shift_id: null, // template link is optional; not exposed in the API yet
      shift_date: new Date().toISOString().slice(0, 10), // UTC date; simple + consistent
      started_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (insertErr) {
    if (insertErr.code === '23505') {
      return json({ error: 'You already have an active shift (concurrent request)' }, 409);
    }
    // 42P01 (undefined_table) or PGRST205 (not in schema cache) -> migration
    // 20261113130001 not applied yet.
    if (insertErr.code === '42P01' || insertErr.code === 'PGRST205') {
      return json({
        error: 'Shift sessions are not available yet (database table pending approval)',
        hint: 'Migration 20261113130001 must be applied first',
      }, 503);
    }
    console.error('[shifts] start insert error:', insertErr.message);
    return json({ error: 'Failed to start shift' }, 500);
  }

  return json({ data: inserted }, 201);
}

// ---------------------------------------------------------------------------
// POST /shifts/end — end my active shift and record the duration
// ---------------------------------------------------------------------------
async function handleEnd(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Find my active shift.
  const active = await findActiveSession(supabase, profile.id);
  // Missing table -> migration pending (same hint as the update below).
  if (active.error?.code === '42P01' || active.error?.code === 'PGRST205') {
    return json({
      error: 'Shift sessions are not available yet (database table pending approval)',
      hint: 'Migration 20261113130001 must be applied first',
    }, 503);
  }
  if (active.error) throw new Error(`active-shift lookup failed: ${active.error.message}`);
  if (!active.row) {
    return json({ error: 'No active shift to end. Start a shift first.' }, 404);
  }

  // 3. End it: set ended_at + duration. RLS (own profile) is the boundary.
  const endedAt = new Date();
  const durationMinutes = Math.max(0, Math.round((endedAt.getTime() - new Date(active.row.started_at).getTime()) / 60000));
  const { data: updated, error: updateErr } = await supabase
    .from('shift_sessions')
    .update({ ended_at: endedAt.toISOString(), duration_minutes: durationMinutes })
    .eq('id', active.row.id)
    .eq('labour_profile_id', profile.id)
    .select()
    .maybeSingle();

  if (updateErr) {
    // 42P01 / PGRST205 -> migration not applied yet (same hint as start).
    if (updateErr.code === '42P01' || updateErr.code === 'PGRST205') {
      return json({
        error: 'Shift sessions are not available yet (database table pending approval)',
        hint: 'Migration 20261113130001 must be applied first',
      }, 503);
    }
    console.error('[shifts] end update error:', updateErr.message);
    return json({ error: 'Failed to end shift' }, 500);
  }
  if (!updated) {
    // Row visible on SELECT but 0 rows updated -> RLS filtered the write.
    return json({ error: 'Not allowed to end this shift' }, 403);
  }

  return json({ data: updated }, 200);
}

// ---------------------------------------------------------------------------
// GET /shifts/status — my current active shift (or null)
// ---------------------------------------------------------------------------
async function handleStatus(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. My active shift, if any. Missing table -> report as "no active shift".
  const active = await findActiveSession(supabase, profile.id);
  if (active.error?.code === '42P01' || active.error?.code === 'PGRST205') {
    return json({ data: null, hint: 'Migration 20261113130001 must be applied first' }, 200);
  }
  if (active.error) throw new Error(`active-shift lookup failed: ${active.error.message}`);

  return json({ data: active.row }, 200);
}

// ---------------------------------------------------------------------------
// GET /shifts/history — my ended shifts, newest first
// ---------------------------------------------------------------------------
async function handleHistory(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional ?limit= (1..100, default 30).
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  let limit = 30;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return json({ error: 'limit must be an integer between 1 and 100' }, 400);
    }
    limit = parsed;
  }

  // 3. My ended shifts (ended_at not null), newest first.
  const { data, error } = await supabase
    .from('shift_sessions')
    .select('*')
    .eq('labour_profile_id', profile.id)
    .not('ended_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) {
    // Missing table -> empty history instead of a failure.
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return json({ data: [], hint: 'Migration 20261113130001 must be applied first' }, 200);
    }
    console.error('[shifts] history error:', error.message);
    return json({ error: 'Failed to fetch shift history' }, 500);
  }

  return json({ data }, 200);
}

// ---------------------------------------------------------------------------
// Small helpers
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

/** Find my one active (not ended) shift session, if any. */
async function findActiveSession(
  supabase: ReturnType<typeof createClientForUser>,
  profileId: string,
): Promise<{ row: ShiftSessionRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await supabase
    .from('shift_sessions')
    .select('*')
    .eq('labour_profile_id', profileId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { row: (data as ShiftSessionRow | null), error };
}
