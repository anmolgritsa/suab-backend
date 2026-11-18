// Supabase Edge Function: work-submission
//
// WHAT IT DOES (labour-side only)
//   POST /work-submission -> log output against one of MY assignments
//   GET  /work-submission -> my submission history (with assignment details)
//
// AUTH
//   Anon key + the caller's user JWT (same pattern as the other functions).
//   RLS in the database is the real security boundary. The service-role key
//   is NEVER used in this function.
//
// SCHEMA NOTES (verified against the live database before coding)
//   work_submissions: id, company_id, work_assignment_id, labour_profile_id,
//   quantity integer NOT NULL CHECK (quantity > 0), submitted_at, notes,
//   created_at, updated_at.
//   - The table has ONE quantity column. This API needs three (successful /
//     rejected / reusable), so migration 20261113170001 (DRAFT, not applied)
//     adds quantity_rejected, quantity_reusable and attachment_url.
//   - Mapping: the SUCCESSFUL quantity is stored in the existing `quantity`
//     column. Until the migration is applied the other fields are accepted
//     but NOT stored — the POST response carries an explicit "warning".
//
// BUSINESS RULES
//   - The assignment must exist AND belong to the caller (404 otherwise —
//     same response for "unknown id" and "someone else's assignment").
//   - Its status must be 'in_progress' or 'completed': 'pending' was never
//     accepted and 'cancelled' was withdrawn (409 otherwise).
//   - Multiple submissions per assignment are allowed (piece-rate logs).
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }    error -> { "error": "message" }

// deno-lint-ignore-file no-explicit-any
import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// Postgres `integer` column limit — reject bigger numbers with a clear 400.
const MAX_INT = 2147483647;

// --- small row types --------------------------------------------------------
interface LabourProfile {
  id: string;
  company_id: string;
  status: string;
}

interface AssignmentRow {
  id: string;
  title: string;
  description: string | null;
  quantity_target: number | null;
  status: string;
}

interface SubmissionRow {
  id: string;
  work_assignment_id: string;
  quantity: number;
  quantity_rejected?: number | null;   // exists after migration 20261113170001
  quantity_reusable?: number | null;   // exists after migration 20261113170001
  attachment_url?: string | null;      // exists after migration 20261113170001
  notes: string | null;
  submitted_at: string;
  created_at: string;
  assignment?: AssignmentRow | null;   // embedded via PostgREST (GET history)
}

/** Last path segment: /work-submission -> "work-submission". */
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

  // Both operations live on /work-submission itself — any sub-path is unknown.
  if (routeName(req) !== 'work-submission') {
    return json({ error: 'Unknown route. Use POST /work-submission or GET /work-submission' }, 404);
  }

  try {
    if (req.method === 'POST') return await handleSubmit(req, supabase, userId);
    return await handleHistory(req, supabase, userId);
  } catch (err) {
    console.error('[work-submission] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /work-submission — log output against one of my assignments
// ---------------------------------------------------------------------------
async function handleSubmit(
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

  // 2. Validate "work_assignment_id" — required, must be a valid UUID.
  //    (A non-UUID string would make PostgREST throw a cast error (22P02)
  //    that would surface as a 500.)
  const assignmentId = body['work_assignment_id'];
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    return json({ error: 'work_assignment_id is required (uuid of your assignment)' }, 400);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
    return json({ error: 'work_assignment_id must be a valid UUID — copy an id from GET /assignments' }, 400);
  }

  // 3. Validate the three quantities. All three are optional in the request
  //    (default 0) but at least one must be > 0 — a submission of nothing
  //    is not a submission.
  const successful = readInt(body, 'quantity_successful', 0);
  if (typeof successful === 'string') return json({ error: successful }, 400);
  const rejected = readInt(body, 'quantity_rejected', 0);
  if (typeof rejected === 'string') return json({ error: rejected }, 400);
  const reusable = readInt(body, 'quantity_reusable', 0);
  if (typeof reusable === 'string') return json({ error: reusable }, 400);
  if (successful + rejected + reusable <= 0) {
    return json({ error: 'At least one quantity must be greater than 0' }, 400);
  }

  // 4. Validate optional "notes" (text, max 500 chars).
  const notes = body['notes'];
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
    return json({ error: 'notes must be a string of at most 500 characters' }, 400);
  }

  // 5. Validate optional "attachment_url" (voice note / image, http(s) only).
  const attachment = body['attachment_url'];
  if (attachment !== undefined && attachment !== null) {
    if (typeof attachment !== 'string' || !/^https?:\/\/\S+$/.test(attachment) || attachment.length > 1000) {
      return json({ error: 'attachment_url must be an http(s) URL of at most 1000 characters' }, 400);
    }
  }

  // 6. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Submitting work not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 7. Load the assignment — it must exist AND belong to me.
  const { data: found, error: findErr } = await supabase
    .from('work_assignments')
    .select('id, title, description, quantity_target, status')
    .eq('id', assignmentId)
    .eq('labour_profile_id', profile.id) // labour can only submit against their OWN assignment
    .maybeSingle();
  if (findErr) {
    console.error('[work-submission] assignment lookup error:', findErr.message);
    return json({ error: 'Failed to load assignment' }, 500);
  }
  const assignment = found as AssignmentRow | null;
  if (!assignment) {
    return json({ error: 'Assignment not found (or it is not assigned to you)' }, 404);
  }

  // 8. Only accepted work can take submissions: 'pending' was never accepted,
  //    'cancelled' was withdrawn. 'in_progress' and 'completed' are fine
  //    (piece-rate logs often arrive after completion).
  if (assignment.status !== 'in_progress' && assignment.status !== 'completed') {
    return json({
      error: `Assignment cannot take submissions: current status is '${assignment.status}' (must be 'in_progress' or 'completed')`,
      current_status: assignment.status,
    }, 409);
  }

  // 9. Insert. The SUCCESSFUL quantity goes into the existing `quantity`
  //    column (NOT NULL, CHECK > 0). quantity_rejected / quantity_reusable /
  //    attachment_url only exist after migration 20261113170001 — until then
  //    we insert without them and warn in the response.
  const payload: Record<string, unknown> = {
    company_id: profile.company_id,
    work_assignment_id: assignment.id,
    labour_profile_id: profile.id,
    quantity: successful,
    notes: typeof notes === 'string' ? notes : null,
  };
  if (rejected > 0) payload['quantity_rejected'] = rejected;
  if (reusable > 0) payload['quantity_reusable'] = reusable;
  if (typeof attachment === 'string' && attachment.length > 0) payload['attachment_url'] = attachment;

  let insert = await supabase.from('work_submissions').insert(payload).select().maybeSingle();

  // Missing column arrives as PGRST204 (PostgREST schema cache) or 42703
  // (undefined_column) -> migration 20261113170001 not applied yet.
  if (insert.error?.code === 'PGRST204' || insert.error?.code === '42703') {
    delete payload['quantity_rejected'];
    delete payload['quantity_reusable'];
    delete payload['attachment_url'];
    insert = await supabase.from('work_submissions').insert(payload).select().maybeSingle();
  }

  if (insert.error) {
    console.error('[work-submission] insert error:', insert.error.message);
    return json({ error: 'Failed to save work submission' }, 500);
  }

  const row = insert.data as SubmissionRow | null;
  if (!row) return json({ error: 'Failed to save work submission' }, 500);

  // 10. 201 Created. If the extra columns were dropped, say so explicitly —
  //     never silently discard client data.
  const warning = insert.error ? null
    : (payload['quantity_rejected'] === undefined && rejected > 0)
      || (payload['quantity_reusable'] === undefined && reusable > 0)
      || (payload['attachment_url'] === undefined && typeof attachment === 'string' && attachment.length > 0)
      ? 'quantity_rejected / quantity_reusable / attachment_url were NOT stored — migration 20261113170001 must be applied first'
      : null;

  return json({
    data: decorate(row, assignment),
    ...(warning ? { warning } : {}),
  }, 201);
}

// ---------------------------------------------------------------------------
// GET /work-submission — my submission history, newest first
// ---------------------------------------------------------------------------
async function handleHistory(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional ?assignment_id= filter (must be a valid UUID if given).
  const url = new URL(req.url);
  const assignmentFilter = url.searchParams.get('assignment_id');
  if (assignmentFilter && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentFilter)) {
    return json({ error: 'assignment_id must be a valid UUID' }, 400);
  }

  // 3. Query MY submissions only (explicit .eq — RLS alone would also allow
  //    company-wide rows for privileged callers), newest first.
  let query = supabase
    .from('work_submissions')
    .select('*, work_assignments(id, title, description, quantity_target, status)')
    .eq('labour_profile_id', profile.id)
    .order('submitted_at', { ascending: false })
    .limit(100);

  if (assignmentFilter) query = query.eq('work_assignment_id', assignmentFilter);

  const { data, error } = await query;
  if (error) {
    console.error('[work-submission] history error:', error.message);
    return json({ error: 'Failed to fetch work submissions' }, 500);
  }

  // 4. Decorate with machine/product parsed from the assignment description.
  //    PostgREST returns the embed under the key "work_assignments" (the table
  //    name), so read that — falling back to "assignment" if aliased.
  const rows = ((data ?? []) as (SubmissionRow & { work_assignments?: AssignmentRow | null })[])
    .map((s) => decorate(s, s.work_assignments ?? s.assignment ?? null));
  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Read an optional integer quantity from the body. Returns the number, or an
 * error string when the value is invalid. Defaults to 0 when absent/null.
 */
function readInt(body: Record<string, unknown>, key: string, defaultValue: number): number | string {
  const raw = body[key];
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return `${key} must be a whole number (e.g. 120)`;
  }
  if (raw < 0) return `${key} cannot be negative`;
  if (raw > MAX_INT) return `${key} exceeds the maximum allowed value`;
  return raw;
}

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
 * Parse "Machine MC-07 | Product: Cotton fabric 40s" from the assignment
 * description (same convention as the assignments function — the schema has
 * no dedicated machine/product columns).
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

/** Shape one submission row for the API response. */
function decorate(
  s: SubmissionRow,
  assignment: AssignmentRow | null,
): Record<string, unknown> {
  const { machine_number, product_type } = parseMachineProduct(assignment?.description ?? null);
  return {
    id: s.id,
    work_assignment_id: s.work_assignment_id,
    assignment: assignment ? {
      title: assignment.title,
      machine_number,
      product_type,
      quantity_target: assignment.quantity_target,
      status: assignment.status,
    } : null,
    quantity_successful: s.quantity,          // existing column = successful output
    quantity_rejected: s.quantity_rejected ?? null,  // after migration 20261113170001
    quantity_reusable: s.quantity_reusable ?? null,  // after migration 20261113170001
    attachment_url: s.attachment_url ?? null,        // after migration 20261113170001
    notes: s.notes,
    submitted_at: s.submitted_at,
    created_at: s.created_at,
  };
}
