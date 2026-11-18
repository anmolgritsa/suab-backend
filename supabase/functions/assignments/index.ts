// Supabase Edge Function: assignments
//
// WHAT IT DOES
//   GET  /assignments          -> my assignments (current + previous)
//   POST /assignments/accept   -> accept one of my PENDING assignments
//
// AUTH
//   Anon key + the caller's user JWT (same pattern as labour-profile and
//   attendance). RLS in the database is the real security boundary.
//   The service-role key is NEVER used in this function.
//
// SCHEMA NOTES (verified against the live database before coding)
//   work_assignments columns: id, company_id, labour_profile_id, title,
//   description, quantity_target, rate_per_unit, due_date, status,
//   created_at, updated_at.
//   - There is NO machine/product/supervisor column. Machine number and
//     product type are parsed out of `description` ("Machine MC-07 | Product: ...").
//   - Supervisor = the company's first privileged profile (owner/admin/
//     manager/supervisor) — shown for context on every row.
//   - assignment_status enum: pending | in_progress | completed | cancelled
//     | overdue. There is no 'accepted' value, so ACCEPTED == 'in_progress'.
//   - accepted_at needs migration 20261113120001 (DRAFT, not applied yet);
//     the function works without it and just skips that column.
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }
//   error   -> { "error": "message" }

// deno-lint-ignore-file no-explicit-any
import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// Valid values of the assignment_status enum (used for the ?status= filter).
const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'overdue'] as const;

// --- small types for the rows we read/write --------------------------------
interface LabourProfile {
  id: string;
  company_id: string;
  status: string;
}

interface AssignmentRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  title: string;
  description: string | null;
  quantity_target: number | null;
  rate_per_unit: string | null;
  due_date: string | null;
  status: string;
  accepted_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Last path segment: /assignments/accept -> "accept". */
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

  // Route: GET anything under /assignments, POST only /assignments/accept.
  const route = routeName(req);
  try {
    if (req.method === 'GET') return await handleList(req, supabase, userId);
    if (req.method === 'POST' && route === 'accept') return await handleAccept(req, supabase, userId);
    return json({ error: 'Unknown route. Use GET /assignments or POST /assignments/accept' }, 404);
  } catch (err) {
    console.error('[assignments] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /assignments — my assignments (current + previous)
// ---------------------------------------------------------------------------
async function handleList(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile (RLS limits this to my own row).
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional ?status= filter — must be a valid enum value.
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  if (status && !STATUSES.includes(status as typeof STATUSES[number])) {
    return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  }

  // 3. Query MY assignments only (explicit .eq — RLS alone would also allow
  //    company-wide rows for privileged callers).
  let query = supabase
    .from('work_assignments')
    .select('*')
    .eq('labour_profile_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    console.error('[assignments] list error:', error.message);
    return json({ error: 'Failed to fetch assignments' }, 500);
  }

  // 4. Decorate each row with machine/product (parsed from description) and
  //    the company supervisor (same for every row — fetch once).
  const supervisor = await loadSupervisor(supabase, profile.company_id);
  const rows = ((data ?? []) as AssignmentRow[]).map((a) => decorate(a, supervisor));

  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// POST /assignments/accept — accept one of my PENDING assignments
// ---------------------------------------------------------------------------
async function handleAccept(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Parse the JSON body: { "assignment_id": "<uuid>" }.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  const assignmentId = (body as Record<string, unknown>)['assignment_id'];
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    return json({ error: 'assignment_id is required (uuid of the assignment to accept)' }, 400);
  }
  // Must be a valid UUID — a non-UUID string would make PostgREST throw a
  // cast error (22P02) which would surface as a 500. Copy ids from
  // GET /assignments.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
    return json({ error: 'assignment_id must be a valid UUID — copy an id from GET /assignments' }, 400);
  }

  // 2. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Accepting assignments not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 3. Load the assignment — it must exist AND belong to me.
  const { data: found, error: findErr } = await supabase
    .from('work_assignments')
    .select('*')
    .eq('id', assignmentId)
    .eq('labour_profile_id', profile.id) // labour can only accept their OWN assignment
    .maybeSingle();
  if (findErr) {
    console.error('[assignments] accept lookup error:', findErr.message);
    return json({ error: 'Failed to load assignment' }, 500);
  }
  const assignment = found as AssignmentRow | null;
  if (!assignment) {
    return json({ error: 'Assignment not found (or it is not assigned to you)' }, 404);
  }

  // 4. Only PENDING assignments can be accepted. Already accepted
  //    (in_progress), completed and cancelled are all rejected.
  if (assignment.status !== 'pending') {
    return json({
      error: `Assignment cannot be accepted: current status is '${assignment.status}' (only 'pending' can be accepted)`,
      current_status: assignment.status,
    }, 409);
  }

  // 5. Accept it: status -> in_progress, record the acceptance time.
  //    accepted_at only exists after migration 20261113120001 is applied —
  //    until then we retry without it so the endpoint still works.
  const acceptedAt = new Date().toISOString();
  let update: { data: AssignmentRow[] | null; error: { message: string; code?: string } | null } = await supabase
    .from('work_assignments')
    .update({ status: 'in_progress', accepted_at: acceptedAt })
    .eq('id', assignment.id)
    .eq('labour_profile_id', profile.id)
    .select();

  // Missing column arrives as PGRST204 (PostgREST schema cache) or 42703
  // (undefined_column) -> accepted_at not there yet (migration pending).
  if (update.error?.code === 'PGRST204' || update.error?.code === '42703') {
    update = await supabase
      .from('work_assignments')
      .update({ status: 'in_progress' })
      .eq('id', assignment.id)
      .eq('labour_profile_id', profile.id)
      .select();
  }

  if (update.error) {
    console.error('[assignments] accept update error:', update.error.message);
    return json({ error: 'Failed to accept assignment' }, 500);
  }

  const updated = (update.data ?? [])[0] as AssignmentRow | undefined;
  if (!updated) {
    // No error but 0 rows updated. The row exists and is visible to us
    // (we just SELECTed it), so this means RLS silently filtered the
    // UPDATE — the worker-accept policy (migration 20261113120001) is not
    // applied yet. PostgREST does NOT raise 42501 in this case, it just
    // updates nothing.
    return json({
      error: 'Not allowed to accept assignments yet (database policy pending approval)',
      hint: 'Migration 20261113120001 must be applied first',
    }, 403);
  }

  const supervisor = await loadSupervisor(supabase, profile.company_id);
  return json({ data: decorate(updated, supervisor) }, 200);
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

/**
 * The company's supervisor = first privileged profile (owner/admin/manager/
 * supervisor). There is no supervisor_id column on work_assignments, so this
 * is the company-level supervisor shown for context on every row.
 */
async function loadSupervisor(
  supabase: ReturnType<typeof createClientForUser>,
  companyId: string,
): Promise<{ id: string; full_name: string; role: string } | null> {
  const { data, error } = await supabase
    .from('labour_profiles')
    .select('id, full_name, role')
    .eq('company_id', companyId)
    .in('role', ['owner', 'admin', 'manager', 'supervisor'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null; // non-fatal: supervisor is display-only
  return (data as { id: string; full_name: string; role: string } | null);
}

/**
 * Parse "Machine MC-07 | Product: Cotton fabric 40s" from the description.
 * The schema has no dedicated machine/product columns, so this convention is
 * used. Anything unparsed stays null — the raw description is always included.
 */
function parseMachineProduct(description: string | null): { machine_number: string | null; product_type: string | null } {
  if (!description) return { machine_number: null, product_type: null };
  const machine = description.match(/machine\s*[:#-]?\s*([A-Za-z0-9-]+)/i);
  const product = description.match(/product\s*[:#-]?\s*([^|]+)/i);
  return {
    machine_number: machine ? machine[1].trim() : null,
    product_type: product ? product[1].trim() : null,
  };
}

/** Shape one assignment row for the API response. */
function decorate(
  a: AssignmentRow,
  supervisor: { id: string; full_name: string; role: string } | null,
): Record<string, unknown> {
  const { machine_number, product_type } = parseMachineProduct(a.description);
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    machine_number,
    product_type,
    quantity_target: a.quantity_target,
    rate_per_unit: a.rate_per_unit,
    due_date: a.due_date,
    status: a.status,
    accepted_at: a.accepted_at ?? null,
    assignment_date: a.created_at,
    supervisor: supervisor ? { name: supervisor.full_name, role: supervisor.role } : null,
  };
}
