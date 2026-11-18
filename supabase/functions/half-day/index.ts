// Supabase Edge Function: half-day
//
// WHAT IT DOES
//   WORKER
//     POST /half-day/apply    -> submit a half-day leave request (status = pending)
//     GET  /half-day/status   -> my half-day requests (optionally filtered by status)
//   SUPERVISOR
//     GET   /half-day/pending -> pending requests from my company's labourers
//     PATCH /half-day/approve -> approve a pending request (reviewed_by + reviewed_at)
//     PATCH /half-day/reject  -> reject a pending request (+ rejection reason)
//
// AUTH
//   Same pattern as the other functions: anon key + the caller's user JWT.
//   RLS is the real boundary. The service-role key is NEVER used here.
//
// SUPERVISOR MODEL
//   There is no supervisor->labourer assignment table in the schema, so
//   "assigned labourers" = the supervisor's COMPANY (RLS: is_company_member).
//   A supervisor is any profile whose role is owner/admin/manager/supervisor
//   (same list as the DB helper has_privileged_role). Workers get 403.
//   A supervisor can never approve/reject their OWN request (403).
//
// SCHEMA (verified against the live database before coding)
//   half_day_requests: id, company_id, labour_profile_id, date, session,
//     reason, status, reviewed_by, reviewed_at, created_at, updated_at,
//     attachment_url (migration 20261113140001, applied),
//     review_notes   (migration 20261113150001 — DRAFT, not applied yet)
//   session enum  : 'morning' | 'afternoon'
//   status enum   : 'pending' | 'approved' | 'rejected' | 'cancelled'
//   created_at    = submission time (set by the database)
//   DB CHECK: approved/rejected rows MUST have reviewed_at set.
//   reviewed_by = the supervisor's labour_profiles.id (no FK on the column).
//
// DUPLICATE / CONFLICT RULES (enforced here, before insert)
//   - a PENDING request for the same date (any session) blocks a new one
//   - an APPROVED request for the same date + session blocks a new one
//   - rejected/cancelled requests never block (you may re-apply)
//   APPROVE/REJECT: only PENDING requests can be decided — approving or
//   rejecting an already-decided request returns 409.
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

interface HalfDayRequestRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  date: string;
  session: string;
  reason: string | null;
  attachment_url?: string | null; // only present after migration 20261113140001
  status: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Valid ?status= filter values for GET /half-day/status (must match the enum).
const VALID_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** Last path segment: /half-day/apply -> "apply". */
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

  // Only GET, POST and PATCH are supported.
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH') {
    return methodNotAllowed(['GET', 'POST', 'PATCH', 'OPTIONS']);
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
    if (req.method === 'GET' && route === 'pending') return await handlePending(supabase, userId);
    if (req.method === 'PATCH' && route === 'approve') return await handleDecision(req, supabase, userId, 'approved');
    if (req.method === 'PATCH' && route === 'reject') return await handleDecision(req, supabase, userId, 'rejected');
    return json({ error: 'Unknown route. Use /half-day/apply (POST), /half-day/status (GET), /half-day/pending (GET), /half-day/approve (PATCH) or /half-day/reject (PATCH)' }, 404);
  } catch (err) {
    console.error('[half-day] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /half-day/apply — submit a half-day request
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

  // 3. Validate "session" — required, must be the enum label.
  const session = body['session'];
  if (session !== 'morning' && session !== 'afternoon') {
    return json({ error: "session is required and must be 'morning' or 'afternoon'" }, 400);
  }

  // 4. Validate optional "reason" (text, max 500 chars).
  const reason = body['reason'];
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    return json({ error: 'reason must be a string of at most 500 characters' }, 400);
  }

  // 5. Validate optional "attachment_url" (voice note etc., http(s) only).
  const attachmentUrl = body['attachment_url'];
  if (attachmentUrl !== undefined && attachmentUrl !== null) {
    if (typeof attachmentUrl !== 'string' || attachmentUrl.length > 1000 ||
        !/^https?:\/\//.test(attachmentUrl)) {
      return json({ error: 'attachment_url must be an http(s) URL of at most 1000 characters' }, 400);
    }
  }

  // 6. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Applying not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 7. Duplicate / conflict check for the same date.
  const { data: sameDay, error: dupErr } = await supabase
    .from('half_day_requests')
    .select('id, date, session, status')
    .eq('labour_profile_id', profile.id)
    .eq('date', dateRaw);
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  for (const r of (sameDay ?? []) as { session: string; status: string }[]) {
    if (r.status === 'pending') {
      return json({
        error: `You already have a PENDING half-day request for ${dateRaw} (${r.session}). Wait for a decision or ask your supervisor to reject it.`,
        existing_status: r.status,
        existing_session: r.session,
      }, 409);
    }
    if (r.status === 'approved' && r.session === session) {
      return json({
        error: `Half-day already APPROVED for ${dateRaw} (${session}).`,
        existing_status: r.status,
        existing_session: r.session,
      }, 409);
    }
  }

  // 8. Insert the request. status defaults to 'pending' in the database;
  //    created_at (submission time) is set by the database too.
  const payload: Record<string, unknown> = {
    company_id: profile.company_id,
    labour_profile_id: profile.id,
    date: dateRaw,
    session,
    reason: typeof reason === 'string' ? reason : null,
    status: 'pending',
  };
  // attachment_url only exists after migration 20261113140001 — send it when given.
  if (typeof attachmentUrl === 'string') payload['attachment_url'] = attachmentUrl;

  let inserted = await insertRequest(supabase, payload);

  // Column missing (migration not applied) -> retry WITHOUT the attachment and
  // tell the caller it was not stored. Nothing is silently dropped.
  let warning: string | undefined;
  if (inserted.error?.code === 'PGRST204' && 'attachment_url' in payload) {
    delete payload['attachment_url'];
    warning = 'attachment_url was NOT stored — migration 20261113140001 (half-day attachment) is not applied yet';
    inserted = await insertRequest(supabase, payload);
  }

  if (inserted.error) {
    // 23505 -> two requests raced in and the partial unique index
    // (uq_half_day_requests_pending, added by migration 20261113140001) caught it.
    if (inserted.error.code === '23505') {
      return json({ error: 'You already have a pending half-day request for this date (concurrent request)' }, 409);
    }
    console.error('[half-day] insert error:', inserted.error.message);
    return json({ error: 'Failed to submit half-day request' }, 500);
  }

  // 201 Created. Include the warning when the attachment could not be stored.
  return json(warning ? { data: inserted.row, warning } : { data: inserted.row }, 201);
}

// ---------------------------------------------------------------------------
// GET /half-day/status — my requests, newest first
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
    .from('half_day_requests')
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

/** Insert one half-day request and return the inserted row (or the error). */
async function insertRequest(
  supabase: ReturnType<typeof createClientForUser>,
  payload: Record<string, unknown>,
): Promise<{ row: HalfDayRequestRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await supabase
    .from('half_day_requests')
    .insert(payload)
    .select()
    .maybeSingle();
  return { row: (data as HalfDayRequestRow | null), error };
}

// ===========================================================================
// SUPERVISOR ENDPOINTS
// ===========================================================================

// Roles that count as a supervisor (same list as the DB helper
// has_privileged_role — owner/admin/manager/supervisor).
const SUPERVISOR_ROLES = ['owner', 'admin', 'manager', 'supervisor'] as const;

interface SupervisorProfile extends LabourProfile {
  role: string | null;
}

/**
 * Load the caller's profile and check they hold a supervisor role.
 * Returns null when the caller may not act here (caller sends the 403/404).
 */
async function requireSupervisor(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<SupervisorProfile | null> {
  // Same lookup as loadProfile but also fetching the role column.
  const { data, error } = await supabase
    .from('labour_profiles')
    .select('id, company_id, status, role')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);

  const profile = data as SupervisorProfile | null;
  if (!profile) return null; // no profile at all

  // Role check (case-insensitive, same list as has_privileged_role in the DB).
  const role = (profile.role ?? '').toLowerCase();
  if (!(SUPERVISOR_ROLES as readonly string[]).includes(role)) return null; // worker
  return profile;
}

/**
 * GET /half-day/pending — pending requests from my company's labourers.
 * Shows labour name, request date, session, reason, submission time.
 */
async function handlePending(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Pending requests in my company, newest first, with the labourer's name.
  //    RLS (company-wide SELECT) makes this query legal for a supervisor.
  const { data, error } = await supabase
    .from('half_day_requests')
    .select('id, date, session, reason, status, created_at, attachment_url, labour_profiles(full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`pending query failed: ${error.message}`);

  // 3. Flatten the join for a simple response shape.
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const out = rows.map((r) => {
    const lp = r['labour_profiles'] as { full_name?: string; employee_code?: string } | null;
    return {
      id: r['id'],
      labour_name: lp?.full_name ?? null,
      employee_code: lp?.employee_code ?? null,
      date: r['date'],
      session: r['session'],
      reason: r['reason'],
      attachment_url: r['attachment_url'] ?? null,
      status: r['status'],
      requested_at: r['created_at'],
    };
  });
  return json({ data: out }, 200);
}

/**
 * PATCH /half-day/approve | /half-day/reject — decide a pending request.
 * Records reviewed_by (supervisor profile id) + reviewed_at, and review_notes
 * (the rejection reason) when the column exists.
 */
async function handleDecision(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
  decision: 'approved' | 'rejected',
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Parse + validate the body: request_id required; review_notes optional.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  const requestId = body['request_id'];
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return json({ error: 'request_id is required' }, 400);
  }
  // Must be a valid UUID — a non-UUID string would make PostgREST throw a
  // cast error (22P02) which would surface as a 500. Copy ids from
  // GET /half-day/pending.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return json({ error: 'request_id must be a valid UUID — copy an id from GET /half-day/pending' }, 400);
  }
  const notes = body['review_notes'];
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 1000)) {
    return json({ error: 'review_notes must be a string of at most 1000 characters' }, 400);
  }
  if (decision === 'rejected' && (typeof notes !== 'string' || notes.trim().length === 0)) {
    return json({ error: 'review_notes (rejection reason) is required when rejecting' }, 400);
  }

  // 3. Load the request. RLS (company-wide SELECT) lets a supervisor read it;
  //    filtering by company_id keeps the scope tight.
  const { data: row, error: rowErr } = await supabase
    .from('half_day_requests')
    .select('id, company_id, labour_profile_id, status')
    .eq('id', requestId)
    .eq('company_id', supervisor.company_id)
    .limit(1)
    .maybeSingle();
  if (rowErr) throw new Error(`request lookup failed: ${rowErr.message}`);
  if (!row) {
    // Unknown id OR another company's request — same 404, no existence leak.
    return json({ error: 'Half-day request not found in your company' }, 404);
  }
  const req0 = row as { labour_profile_id: string; status: string };

  // 4. A supervisor can never decide their own request.
  if (req0.labour_profile_id === supervisor.id) {
    return json({ error: 'You cannot approve or reject your own half-day request' }, 403);
  }

  // 5. Only PENDING requests can be decided (prevents duplicate approvals).
  if (req0.status !== 'pending') {
    return json({
      error: `Request cannot be ${decision}: current status is '${req0.status}' (only 'pending' can be decided)`,
      current_status: req0.status,
    }, 409);
  }

  // 6. Build the update. reviewed_at is set by us (the DB CHECK requires it);
  //    reviewed_by = the supervisor's labour_profiles.id.
  const updates: Record<string, unknown> = {
    status: decision,
    reviewed_by: supervisor.id,
    reviewed_at: new Date().toISOString(),
  };
  if (typeof notes === 'string') updates['review_notes'] = notes;

  const { data: updated, error: updateErr } = await supabase
    .from('half_day_requests')
    .update(updates)
    .eq('id', requestId)
    .eq('status', 'pending') // in the WHERE: two supervisors racing -> one wins, the other updates 0 rows
    .eq('company_id', supervisor.company_id)
    .select()
    .maybeSingle();

  if (updateErr) {
    // PGRST204 = column not found -> review_notes migration not applied yet.
    if (updateErr.code === 'PGRST204' && 'review_notes' in updates) {
      return json({
        error: 'review_notes cannot be stored yet — migration 20261113150001 (half-day review notes) is not applied',
        hint: 'Apply migration 20261113150001 to store rejection reasons. Approve works without it.',
      }, 503);
    }
    console.error('[half-day] update error:', updateErr.message);
    return json({ error: 'Failed to update half-day request' }, 500);
  }

  // 7. 0 rows updated = lost a race (another supervisor decided first) or RLS
  //    blocked the write. Both surface as 409 with the fresh status.
  if (!updated) {
    const { data: fresh } = await supabase
      .from('half_day_requests')
      .select('status')
      .eq('id', requestId)
      .limit(1);
    const freshStatus = (fresh as { status: string }[] | null)?.[0]?.status ?? 'unknown';
    return json({
      error: `Request was just decided by someone else (current status: '${freshStatus}')`,
      current_status: freshStatus,
    }, 409);
  }

  // 8. Success — return the updated row.
  return json({ data: updated }, 200);
}
