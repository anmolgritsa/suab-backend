// Supabase Edge Function: supervisor
//
// WHAT IT DOES (supervisor-side only)
//   GET /supervisor/work-history        -> work submissions from my company's labourers
//                                          (filters: ?labour_id= ?from= ?to=)
//   GET /supervisor/work-summary        -> quantity totals for one date (?date=YYYY-MM-DD,
//                                          default = today in the company timezone)
//   GET /supervisor/attendance          -> attendance records for my company's labourers
//                                          (filters: ?labour_id= ?date= ?from= ?to=)
//   GET /supervisor/attendance-summary  -> present/absent/half-day counts for one date
//                                          (?date=YYYY-MM-DD, default = today)
//   GET /supervisor/labourers           -> labourers in my company, each with their
//                                          current (open) assignment
//   GET /supervisor/labourers/<uuid>    -> one labourer's details + recent assignments
//   POST   /supervisor/assignments      -> assign a machine/task to a labourer
//   GET    /supervisor/assignments      -> assignments I created (?labour_id= ?date= ?status=)
//   PATCH  /supervisor/assignments      -> update one assignment's status
//   GET    /supervisor/overtime/pending -> pending overtime requests (my company)
//   PATCH  /supervisor/overtime/approve -> approve one pending overtime request
//   PATCH  /supervisor/overtime/reject  -> reject one (optional reason in review_notes)
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
//
// SCHEMA NOTES (verified against the live database before coding)
//   work_submissions: id, company_id, work_assignment_id, labour_profile_id,
//   quantity (successful output), submitted_at, notes, created_at, updated_at.
//   - quantity_rejected / quantity_reusable / attachment_url only exist after
//     migration 20261113170001 (DRAFT, not applied yet). We select * and read
//     those fields defensively (?? null) so the API works before AND after.
//   - Machine/product are parsed from the assignment description (same
//     convention as the assignments + work-submission functions).
//   attendance: id, company_id, labour_profile_id, shift_id, date (plain date),
//   check_in/check_out (timestamptz), status (attendance_status enum:
//   present/absent/late/half_day/leave/holiday/on_duty), timestamps.
//   - attendance.date is already the company-timezone calendar day (the
//     attendance function writes it that way), so date filters compare directly.
//   work_assignments: id, company_id, labour_profile_id, title, description,
//   quantity_target, rate_per_unit, due_date, status, accepted_at, timestamps.
//   - No machine/product columns: they are parsed from description
//     ("Machine MC-07 | Product: ...") — same convention everywhere.
//   - No supervisor column either: migration 20261113180001 (DRAFT, not
//     applied) adds assigned_by -> labour_profiles.id. Until then the create
//     endpoint skips that column and says so in the response.
//   - assignment_status enum: pending | in_progress | completed | cancelled
//     | overdue.
//   overtime_requests: id, company_id, labour_profile_id, date, hours
//   numeric(4,2) CHECK (>0), reason (the WORKER's reason), status
//   (request_status: pending/approved/rejected/cancelled), reviewed_by,
//   reviewed_at, timestamps. Partial unique index uq_overtime_requests_pending
//   (labour_profile_id, date) WHERE status='pending' — one pending request per
//   labourer per date.
//   - No rejection-reason column: migration 20261113190001 (DRAFT, not
//     applied) adds review_notes. Until then reject stores status/reviewer
//     and says the note was not stored.
//
// DATE HANDLING
//   ?date / ?from / ?to are company-timezone calendar dates (companies.settings
//   .timezone, default Asia/Kolkata) — consistent with the attendance function.
//   They are converted to UTC instants to filter on submitted_at (timestamptz).
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }    error -> { "error": "message" }

// deno-lint-ignore-file no-explicit-any
import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// --- small row types --------------------------------------------------------
interface SupervisorProfile {
  id: string;
  company_id: string;
  status: string;
  role: string | null;
}

// Valid values of the assignment_status enum (transitions are enforced in the PATCH handler).
const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'overdue'] as const;

// Row shape for labourer profiles (subset used by the labourers endpoints).
interface LabourerProfileRow {
  id: string;
  full_name: string;
  employee_code: string;
  phone: string | null;
  role: string | null;
  employment_type: string;
  wage_type: string;
  hourly_rate: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

// Row shape for the open-assignment lookup (subset of work_assignments).
interface OpenAssignmentRow {
  id: string;
  labour_profile_id?: string;
  title: string;
  description: string | null;
  quantity_target: number | null;
  due_date: string | null;
  status: string;
  accepted_at?: string | null;
  created_at: string;
}

// Valid update types (must match the labour_update_type enum in migration
// 20261113200001 — same list as the labour-side /updates function).
const UPDATE_TYPES = ['machine_maintenance', 'machine_breakdown', 'raw_material_defect', 'other'] as const;

// Row shape for a labour_updates row (migration 20261113200001).
interface UpdateRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  update_type: string;
  description: string;
  voice_note_url: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Shape one open assignment for the labourers endpoints (machine/product parsed). */
function shapeOpenAssignment(a: OpenAssignmentRow): Record<string, unknown> {
  const { machine_number, product_type } = parseMachineProduct(a.description);
  return {
    id: a.id,
    title: a.title,
    machine_number,
    product_type,
    quantity_target: a.quantity_target,
    due_date: a.due_date,
    status: a.status,
    accepted_at: a.accepted_at ?? null,
    assignment_date: a.created_at,
  };
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
  assigned_by?: string | null; // exists after migration 20261113180001
  created_at: string;
  updated_at: string;
}

interface SubmissionRow {
  id: string;
  work_assignment_id: string;
  labour_profile_id: string;
  quantity: number; // successful output
  quantity_rejected?: number | null; // exists after migration 20261113170001
  quantity_reusable?: number | null; // exists after migration 20261113170001
  attachment_url?: string | null; // exists after migration 20261113170001
  notes: string | null;
  submitted_at: string;
  labour_profiles?: { id: string; full_name: string; employee_code: string } | null;
  work_assignments?: { id: string; title: string; description: string | null; status: string; quantity_target: number | null } | null;
}

/** Last path segment: /supervisor/work-history -> "work-history". */
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

  // Supported methods: GET (read), POST (create assignment), PATCH (update
  // assignment status). Everything else -> 405.
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
    if (route === 'work-history') return await handleWorkHistory(req, supabase, userId);
    if (route === 'work-summary') return await handleSummary(req, supabase, userId);
    if (route === 'attendance') return await handleAttendance(req, supabase, userId);
    if (route === 'attendance-summary') return await handleAttendanceSummary(req, supabase, userId);
    if (route === 'assignments') {
      if (req.method === 'POST') return await handleCreateAssignment(req, supabase, userId);
      if (req.method === 'PATCH') return await handleUpdateAssignment(req, supabase, userId);
      return await handleListAssignments(req, supabase, userId); // GET
    }
    // Overtime approval: /supervisor/overtime/<action> — action is the last
    // segment (pending | approve | reject). Strip the action from the path and
    // confirm the segment before it is "overtime" (so /assignments/... etc.
    // never collide).
    if (route === 'pending' || route === 'approve' || route === 'reject') {
      const prev = new URL(req.url).pathname.replace(/\/+$/, '').split('/').slice(-2, -1)[0];
      if (prev === 'overtime') {
        if (route === 'pending') return await handleOvertimePending(supabase, userId);
        return await handleOvertimeDecision(req, supabase, userId, route === 'approve' ? 'approved' : 'rejected');
      }
    }
    // Labour updates feed: /supervisor/updates — field reports from my
    // company's labourers (filters: ?labour_id= ?type= ?from= ?to=).
    if (route === 'updates') return await handleUpdates(req, supabase, userId);
    // Labourer directory: /supervisor/labourers (list) and
    // /supervisor/labourers/<uuid> (detail). The detail route's last segment is
    // a UUID, so route !== 'labourers' there — check the segment before it.
    if (route === 'labourers') return await handleLabourers(supabase, userId);
    const prevSeg = new URL(req.url).pathname.replace(/\/+$/, '').split('/').slice(-2, -1)[0];
    if (prevSeg === 'labourers') return await handleLabourerDetail(req, supabase, userId, route);
    return json({ error: 'Unknown route. Use /supervisor/work-history, /supervisor/work-summary, /supervisor/attendance, /supervisor/attendance-summary, /supervisor/assignments or /supervisor/labourers' }, 404);
  } catch (err) {
    console.error('[supervisor] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /supervisor/work-history — submissions from my company's labourers
// ---------------------------------------------------------------------------
async function handleWorkHistory(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Validate the optional query filters.
  //    ?labour_id=  -> one labourer's submissions (must be a valid UUID — a
  //                    non-UUID would make PostgREST throw a cast error (22P02)
  //                    that would surface as a 500).
  //    ?from/?to    -> company-timezone calendar dates (YYYY-MM-DD).
  const url = new URL(req.url);
  const labourId = url.searchParams.get('labour_id');
  if (labourId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labour_id must be a valid UUID' }, 400);
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && !isValidDate(from)) return json({ error: 'from must be a valid date in YYYY-MM-DD format' }, 400);
  if (to && !isValidDate(to)) return json({ error: 'to must be a valid calendar date in YYYY-MM-DD format' }, 400);
  if (from && to && from > to) return json({ error: 'from must be on or before to' }, 400);

  // 3. Company timezone — needed to turn ?from/?to into UTC instants.
  const tz = await companyTimezone(supabase, supervisor.company_id);

  // 4. Query submissions in MY company, newest first, with the labourer and
  //    assignment embedded. RLS (company-wide SELECT) makes this legal.
  let query = supabase
    .from('work_submissions')
    .select('*, labour_profiles(id, full_name, employee_code), work_assignments(id, title, description, status, quantity_target)')
    .eq('company_id', supervisor.company_id)
    .order('submitted_at', { ascending: false })
    .limit(200);

  if (labourId) query = query.eq('labour_profile_id', labourId);
  if (from) query = query.gte('submitted_at', dayStartUtc(from, tz));
  if (to) query = query.lte('submitted_at', dayEndUtc(to, tz));

  const { data, error } = await query;
  if (error) throw new Error(`work-history query failed: ${error.message}`);

  // 5. Shape each row: flatten the joins, parse machine/product from the
  //    assignment description, read the migration-only columns defensively.
  const rows = ((data ?? []) as SubmissionRow[]).map(shapeSubmission);
  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// GET /supervisor/work-summary — quantity totals for one date
// ---------------------------------------------------------------------------
async function handleSummary(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. ?date= is optional — default is TODAY in the company timezone (same
  //    convention as the attendance function).
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const tz = await companyTimezone(supabase, supervisor.company_id);
  const date = dateParam ?? attendanceDateFor(tz);
  if (!isValidDate(date)) return json({ error: 'date must be a valid calendar date in YYYY-MM-DD format' }, 400);

  // 3. All submissions for that company-day (UTC window from the calendar date).
  //    select(*) — naming quantity_rejected/quantity_reusable here would fail
  //    with PGRST204 until migration 20261113170001 adds them; with * the
  //    columns simply appear once the migration is applied.
  const { data, error } = await supabase
    .from('work_submissions')
    .select('*')
    .eq('company_id', supervisor.company_id)
    .gte('submitted_at', dayStartUtc(date, tz))
    .lte('submitted_at', dayEndUtc(date, tz));
  if (error) throw new Error(`summary query failed: ${error.message}`);

  // 4. Sum in JS (small row counts; keeps the query simple). Missing columns
  //    (migration 20261113170001 not applied) count as 0.
  let successful = 0;
  let rejected = 0;
  let reusable = 0;
  const labourers = new Set<string>();
  for (const r of ((data ?? []) as SubmissionRow[])) {
    successful += r.quantity ?? 0;
    rejected += r.quantity_rejected ?? 0;
    reusable += r.quantity_reusable ?? 0;
    labourers.add(r.labour_profile_id);
  }

  // 5. Totals + how many submissions/labourers they came from.
  return json({
    data: {
      date,
      totals: { successful, rejected, reusable },
      submissions_count: (data ?? []).length,
      labourers_count: labourers.size,
    },
  }, 200);
}

interface AttendanceRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  shift_id: string | null;
  date: string; // plain calendar date (already company-timezone day)
  check_in: string | null;
  check_out: string | null;
  status: string; // attendance_status enum: present/absent/late/half_day/leave/holiday/on_duty
  created_at: string;
  updated_at: string;
  labour_profiles?: { id: string; full_name: string; employee_code: string } | null;
}

// ---------------------------------------------------------------------------
// GET /supervisor/attendance — attendance records for my company's labourers
// ---------------------------------------------------------------------------
async function handleAttendance(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Validate the optional query filters.
  //    ?labour_id=  -> one labourer (must be a valid UUID, else PostgREST 22P02 -> 500)
  //    ?date=       -> one calendar day (attendance.date is a plain date column)
  //    ?from/?to=   -> inclusive calendar-date range
  const url = new URL(req.url);
  const labourId = url.searchParams.get('labour_id');
  if (labourId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labour_id must be a valid UUID' }, 400);
  }
  const date = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (date && !isValidDate(date)) return json({ error: 'date must be a valid calendar date in YYYY-MM-DD format' }, 400);
  if (from && !isValidDate(from)) return json({ error: 'from must be a valid date in YYYY-MM-DD format' }, 400);
  if (to && !isValidDate(to)) return json({ error: 'to must be a valid calendar date in YYYY-MM-DD format' }, 400);
  if (from && to && from > to) return json({ error: 'from must be on or before to' }, 400);

  // 3. Query attendance in MY company, newest day first, labourer embedded.
  //    RLS (company-wide SELECT) makes this legal. attendance.date is a plain
  //    date column, so calendar-date filters compare directly — no tz math.
  let query = supabase
    .from('attendance')
    .select('*, labour_profiles(id, full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .order('date', { ascending: false })
    .limit(200);

  if (labourId) query = query.eq('labour_profile_id', labourId);
  if (date) query = query.eq('date', date);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);

  const { data, error } = await query;
  if (error) throw new Error(`attendance query failed: ${error.message}`);

  // 4. Shape each row: flatten the join, keep times as stored (UTC ISO).
  const rows = ((data ?? []) as AttendanceRow[]).map((r) => {
    const lp = r.labour_profiles ?? null;
    return {
      id: r.id,
      labour: lp ? { id: lp.id, name: lp.full_name, employee_code: lp.employee_code } : null,
      date: r.date,
      status: r.status,
      check_in: r.check_in,
      check_out: r.check_out,
      shift_id: r.shift_id,
    };
  });
  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// GET /supervisor/attendance-summary — present/absent/half-day counts for a date
// ---------------------------------------------------------------------------
async function handleAttendanceSummary(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. ?date= optional — default is TODAY in the company timezone.
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const tz = await companyTimezone(supabase, supervisor.company_id);
  const date = dateParam ?? attendanceDateFor(tz);
  if (!isValidDate(date)) return json({ error: 'date must be a valid calendar date in YYYY-MM-DD format' }, 400);

  // 3. All attendance rows for that company-day. date is a plain date column,
  //    so a simple equality works — no UTC window conversion needed.
  const { data, error } = await supabase
    .from('attendance')
    .select('status, labour_profile_id')
    .eq('company_id', supervisor.company_id)
    .eq('date', date);
  if (error) throw new Error(`attendance-summary query failed: ${error.message}`);

  // 4. Count by status in JS (small row counts; keeps the query simple).
  //    "present" bucket = present + late + on_duty (all mean "was at work").
  let present = 0;
  let absent = 0;
  let halfDay = 0;
  let leave = 0;
  let holiday = 0;
  for (const r of ((data ?? []) as { status: string; labour_profile_id: string }[])) {
    if (r.status === 'present' || r.status === 'late' || r.status === 'on_duty') present++;
    else if (r.status === 'absent') absent++;
    else if (r.status === 'half_day') halfDay++;
    else if (r.status === 'leave') leave++;
    else if (r.status === 'holiday') holiday++;
  }

  // 5. Totals + the raw per-status breakdown for transparency.
  return json({
    data: {
      date,
      totals: { present, absent, half_day: halfDay, leave, holiday },
      records_count: (data ?? []).length,
    },
  }, 200);
}

// ---------------------------------------------------------------------------
// POST /supervisor/assignments — assign a machine/task to a labourer
// ---------------------------------------------------------------------------
// Body: { labour_id, title, machine_number, product_type, quantity_target,
//         due_date?, instructions? }
// The machine + product are stored in `description` using the shared
// "Machine X | Product: Y" convention (the schema has no dedicated columns).
async function handleCreateAssignment(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Parse the JSON body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  const b = body as Record<string, unknown>;

  // 3. Required fields: labour_id (uuid), title, machine_number,
  //    product_type, quantity_target (positive whole number).
  const labourId = b['labour_id'];
  if (typeof labourId !== 'string' || labourId.length === 0) {
    return json({ error: 'labour_id is required (uuid of the labourer profile)' }, 400);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labour_id must be a valid UUID' }, 400);
  }
  const title = typeof b['title'] === 'string' ? b['title'].trim() : '';
  if (!title) return json({ error: 'title is required' }, 400);
  if (title.length > 200) return json({ error: 'title must be 200 characters or fewer' }, 400);
  const machine = typeof b['machine_number'] === 'string' ? b['machine_number'].trim() : '';
  if (!machine) return json({ error: 'machine_number is required' }, 400);
  if (machine.length > 60) return json({ error: 'machine_number must be 60 characters or fewer' }, 400);
  const product = typeof b['product_type'] === 'string' ? b['product_type'].trim() : '';
  if (!product) return json({ error: 'product_type is required' }, 400);
  if (product.length > 200) return json({ error: 'product_type must be 200 characters or fewer' }, 400);
  const target = b['quantity_target'];
  if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0) {
    return json({ error: 'quantity_target must be a positive whole number' }, 400);
  }

  // 4. Optional fields: due_date (calendar date) and instructions (text).
  const dueDate = typeof b['due_date'] === 'string' ? b['due_date'].trim() : '';
  if (dueDate && !isValidDate(dueDate)) {
    return json({ error: 'due_date must be a valid calendar date in YYYY-MM-DD format' }, 400);
  }
  const instructions = typeof b['instructions'] === 'string' ? b['instructions'].trim() : '';
  if (instructions.length > 500) {
    return json({ error: 'instructions must be 500 characters or fewer' }, 400);
  }

  // 5. The labourer must exist, belong to MY company, and be a worker.
  const { data: labour, error: labourErr } = await supabase
    .from('labour_profiles')
    .select('id, company_id, role, status')
    .eq('id', labourId)
    .maybeSingle();
  if (labourErr) throw new Error(`labour lookup failed: ${labourErr.message}`);
  const worker = labour as { id: string; company_id: string; role: string | null; status: string } | null;
  if (!worker || worker.company_id !== supervisor.company_id) {
    // Same 404 for "unknown" and "another company's" labourer — no leak.
    return json({ error: 'Labourer not found in your company' }, 404);
  }
  const workerRole = (worker.role ?? '').toLowerCase();
  if ((SUPERVISOR_ROLES as readonly string[]).includes(workerRole)) {
    return json({ error: 'Assignments can only be given to labourers (not supervisors)' }, 400);
  }
  if (worker.status !== 'active') {
    return json({ error: `Labourer profile status is '${worker.status}' — only active labourers can be assigned` }, 400);
  }

  // 6. Insert. assigned_by only exists after migration 20261113180001 —
  //    retry without it so the endpoint works before the migration too.
  const description = `Machine ${machine} | Product: ${product}${instructions ? ` | Instructions: ${instructions}` : ''}`;
  const insert: Record<string, unknown> = {
    company_id: supervisor.company_id,
    labour_profile_id: worker.id,
    title,
    description,
    quantity_target: target,
    status: 'pending',
  };
  if (dueDate) insert['due_date'] = dueDate;
  insert['assigned_by'] = supervisor.id;

  let created: { data: AssignmentRow[] | null; error: { message: string; code?: string } | null } =
    await supabase.from('work_assignments').insert(insert).select();

  // Missing column -> PGRST204 (schema cache) or 42703 (undefined column).
  if (created.error?.code === 'PGRST204' || created.error?.code === '42703') {
    delete insert['assigned_by'];
    created = await supabase.from('work_assignments').insert(insert).select();
  }
  if (created.error) {
    console.error('[supervisor] assignment insert error:', created.error.message);
    return json({ error: 'Failed to create assignment' }, 500);
  }
  const row = (created.data ?? [])[0] as AssignmentRow | undefined;
  if (!row) return json({ error: 'Failed to create assignment' }, 500);

  // 7. Tell the caller when the supervisor-attribution column is missing.
  const response: Record<string, unknown> = { data: shapeAssignment(row) };
  if (!('assigned_by' in insert)) {
    response['warning'] = 'assigned_by was NOT stored — migration 20261113180001 must be applied first';
  }
  return json(response, 201);
}

// ---------------------------------------------------------------------------
// GET /supervisor/assignments — assignments I created (with filters)
// ---------------------------------------------------------------------------
async function handleListAssignments(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Validate the optional filters: ?labour_id= ?date= ?status=.
  const url = new URL(req.url);
  const labourId = url.searchParams.get('labour_id');
  if (labourId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labour_id must be a valid UUID' }, 400);
  }
  const date = url.searchParams.get('date');
  if (date && !isValidDate(date)) {
    return json({ error: 'date must be a valid calendar date in YYYY-MM-DD format' }, 400);
  }
  const status = url.searchParams.get('status');
  if (status && !STATUSES.includes(status as typeof STATUSES[number])) {
    return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  }

  // 3. Query assignments in MY company, newest first, labourer embedded.
  //    RLS (company-wide SELECT) makes this legal.
  let query = supabase
    .from('work_assignments')
    .select('*, labour_profiles(id, full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (labourId) query = query.eq('labour_profile_id', labourId);
  if (date) {
    // ?date= filters on the assignment's creation day (company timezone ->
    // UTC window, same convention as the other date filters).
    const tz = await companyTimezone(supabase, supervisor.company_id);
    query = query.gte('created_at', dayStartUtc(date, tz)).lte('created_at', dayEndUtc(date, tz));
  }
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`assignments query failed: ${error.message}`);

  // 4. Shape each row (machine/product parsed from description).
  const rows = ((data ?? []) as (AssignmentRow & { labour_profiles?: { id: string; full_name: string; employee_code: string } | null })[])
    .map((r) => {
      const shaped = shapeAssignment(r);
      const lp = r.labour_profiles ?? null;
      return { ...shaped, labour: lp ? { id: lp.id, name: lp.full_name, employee_code: lp.employee_code } : null };
    });
  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// PATCH /supervisor/assignments — update one assignment's status
// ---------------------------------------------------------------------------
// Body: { assignment_id, status } — status must be a valid enum value and a
// permitted transition. Completed/cancelled assignments are frozen.
async function handleUpdateAssignment(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Parse the JSON body: { assignment_id, status }.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  const b = body as Record<string, unknown>;
  const assignmentId = b['assignment_id'];
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    return json({ error: 'assignment_id is required (uuid of the assignment to update)' }, 400);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assignmentId)) {
    return json({ error: 'assignment_id must be a valid UUID — copy an id from GET /supervisor/assignments' }, 400);
  }
  const nextStatus = b['status'];
  if (typeof nextStatus !== 'string' || !STATUSES.includes(nextStatus as typeof STATUSES[number])) {
    return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  }

  // 3. Load the assignment — must exist in MY company.
  const { data: found, error: findErr } = await supabase
    .from('work_assignments')
    .select('*')
    .eq('id', assignmentId)
    .eq('company_id', supervisor.company_id)
    .maybeSingle();
  if (findErr) throw new Error(`assignment lookup failed: ${findErr.message}`);
  const assignment = found as AssignmentRow | null;
  if (!assignment) return json({ error: 'Assignment not found in your company' }, 404);

  // 4. Completed and cancelled assignments are frozen — no further changes.
  if (assignment.status === 'completed' || assignment.status === 'cancelled') {
    return json({
      error: `Assignment is '${assignment.status}' and can no longer be changed`,
      current_status: assignment.status,
    }, 409);
  }

  // 5. No-op guard: setting the same status is rejected as a conflict.
  if (assignment.status === nextStatus) {
    return json({ error: `Assignment is already '${nextStatus}'`, current_status: assignment.status }, 409);
  }

  // 6. Allowed transitions (supervisor-side):
  //      pending      -> in_progress | cancelled | overdue
  //      in_progress  -> completed    | cancelled | overdue
  //      overdue      -> in_progress | cancelled   (reopen or cancel)
  const ALLOWED: Record<string, string[]> = {
    pending: ['in_progress', 'cancelled', 'overdue'],
    in_progress: ['completed', 'cancelled', 'overdue'],
    overdue: ['in_progress', 'cancelled'],
  };
  const allowed = ALLOWED[assignment.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    return json({
      error: `Invalid status transition: '${assignment.status}' -> '${nextStatus}' (allowed: ${allowed.join(', ')})`,
      current_status: assignment.status,
    }, 409);
  }

  // 7. Apply the update (RLS company-wide UPDATE policy covers supervisors).
  const { data: updated, error: updateErr } = await supabase
    .from('work_assignments')
    .update({ status: nextStatus })
    .eq('id', assignment.id)
    .eq('company_id', supervisor.company_id)
    .select();
  if (updateErr) {
    console.error('[supervisor] assignment update error:', updateErr.message);
    return json({ error: 'Failed to update assignment' }, 500);
  }
  const row = (updated ?? [])[0] as AssignmentRow | undefined;
  if (!row) return json({ error: 'Failed to update assignment' }, 500);
  return json({ data: shapeAssignment(row) }, 200);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Roles that count as a supervisor (same list as the DB helper has_privileged_role). */
const SUPERVISOR_ROLES = ['owner', 'admin', 'manager', 'supervisor'] as const;

/**
 * Load the caller's profile and check they hold a supervisor role.
 * Returns null when the caller may not act here (caller sends the 403).
 */
async function requireSupervisor(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<SupervisorProfile | null> {
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

/** YYYY-MM-DD that is also a real calendar date (2026-02-30 fails). */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Company timezone (companies.settings.timezone, default Asia/Kolkata). */
async function companyTimezone(
  supabase: ReturnType<typeof createClientForUser>,
  companyId: string,
): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('companies')
    .select('settings')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
  return typeof settings?.['timezone'] === 'string' ? settings['timezone'] as string : undefined;
}

/** Today (YYYY-MM-DD) in the given timezone — same logic as attendance. */
function attendanceDateFor(timezone: string | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Kolkata' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
  }
}

/**
 * UTC instant of the company-timezone day START (00:00 local) as ISO string.
 * Fixed-offset zones (like Asia/Kolkata, UTC+5:30) are computed directly;
 * anything else falls back to a plain UTC midnight (documented simplification).
 */
function dayStartUtc(date: string, tz: string | undefined): string {
  const offsetMin = tzOffsetMinutes(date, tz);
  const ms = Date.parse(`${date}T00:00:00Z`) - offsetMin * 60_000;
  return new Date(ms).toISOString();
}

/** UTC instant of the company-timezone day END (23:59:59.999 local). */
function dayEndUtc(date: string, tz: string | undefined): string {
  const offsetMin = tzOffsetMinutes(date, tz);
  const ms = Date.parse(`${date}T23:59:59.999Z`) - offsetMin * 60_000;
  return new Date(ms).toISOString();
}

/**
 * Offset of the timezone from UTC, in minutes, for that date. Uses Intl to
 * format the zone's local time and derives the offset from the difference.
 * Falls back to 0 (UTC) when the zone name is unknown.
 */
function tzOffsetMinutes(date: string, tz: string | undefined): number {
  if (!tz) return 0;
  try {
    // Format the UTC instant of local midnight AS SEEN IN tz, then compare.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(`${date}T12:00:00Z`));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - Date.parse(`${date}T12:00:00Z`)) / 60_000);
  } catch {
    return 0; // unknown zone -> treat as UTC
  }
}

/**
 * Shape one submission row for the API response: flatten the joins, parse
 * machine/product from the assignment description, and read the migration-only
 * columns defensively (they are absent until 20261113170001 is applied).
 */
function shapeSubmission(s: SubmissionRow): Record<string, unknown> {
  const a = s.work_assignments ?? null;
  const { machine_number, product_type } = parseMachineProduct(a?.description ?? null);
  const lp = s.labour_profiles ?? null;
  return {
    id: s.id,
    labour: lp ? { id: lp.id, name: lp.full_name, employee_code: lp.employee_code } : null,
    assignment: a ? {
      id: a.id,
      title: a.title,
      machine_number,
      product_type,
      quantity_target: a.quantity_target,
      status: a.status,
    } : null,
    quantity_successful: s.quantity,
    quantity_rejected: s.quantity_rejected ?? null, // after migration 20261113170001
    quantity_reusable: s.quantity_reusable ?? null, // after migration 20261113170001
    attachment_url: s.attachment_url ?? null,       // after migration 20261113170001
    notes: s.notes,
    submitted_at: s.submitted_at,
  };
}

/**
 * Shape one assignment row for the API response: flatten the labourer join,
 * parse machine/product from the description, include the assignment date.
 */
function shapeAssignment(
  a: AssignmentRow,
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
    assigned_by: a.assigned_by ?? null, // after migration 20261113180001
    assignment_date: a.created_at,
  };
}

/**
 * Parse "Machine MC-07 | Product: Cotton fabric 40s" from the assignment
 * description (same convention as the assignments + work-submission functions
 * — the schema has no dedicated machine/product columns).
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

// ---------------------------------------------------------------------------
// GET /supervisor/overtime/pending — pending overtime requests (my company)
// ---------------------------------------------------------------------------
/**
 * Pending overtime requests from my company's labourers, newest first.
 * Shows labour name, requested hours, request date, request time, reason.
 */
async function handleOvertimePending(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Pending requests in my company, newest first, labourer embedded.
  //    RLS (company-wide SELECT) makes this query legal for a supervisor.
  const { data, error } = await supabase
    .from('overtime_requests')
    .select('id, date, hours, reason, status, created_at, labour_profiles(full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`overtime pending query failed: ${error.message}`);

  // 3. Flatten the join for a simple response shape.
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const out = rows.map((r) => {
    const lp = r['labour_profiles'] as { full_name?: string; employee_code?: string } | null;
    return {
      id: r['id'],
      labour_name: lp?.full_name ?? null,
      employee_code: lp?.employee_code ?? null,
      date: r['date'],
      hours: r['hours'],
      reason: r['reason'],
      status: r['status'],
      requested_at: r['created_at'],
    };
  });
  return json({ data: out }, 200);
}

// ---------------------------------------------------------------------------
// PATCH /supervisor/overtime/approve | /supervisor/overtime/reject
// ---------------------------------------------------------------------------
/**
 * Decide a pending overtime request: status -> approved | rejected.
 * Records reviewed_by (supervisor profile id) + reviewed_at, and review_notes
 * (the optional rejection reason) when the column exists.
 */
async function handleOvertimeDecision(
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
  // Must be a valid UUID — a non-UUID would make PostgREST throw a cast
  // error (22P02) that surfaces as a 500. Copy ids from
  // GET /supervisor/overtime/pending.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return json({ error: 'request_id must be a valid UUID — copy an id from GET /supervisor/overtime/pending' }, 400);
  }
  // Optional supervisor note (mainly the rejection reason). The task allows
  // rejecting WITHOUT a reason, so unlike half-day this is not required.
  const notes = body['review_notes'];
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 1000)) {
    return json({ error: 'review_notes must be a string of at most 1000 characters' }, 400);
  }

  // 3. Load the request. RLS (company-wide SELECT) lets a supervisor read it;
  //    filtering by company_id keeps the scope tight.
  const { data: row, error: rowErr } = await supabase
    .from('overtime_requests')
    .select('id, company_id, labour_profile_id, status')
    .eq('id', requestId)
    .eq('company_id', supervisor.company_id)
    .limit(1)
    .maybeSingle();
  if (rowErr) throw new Error(`overtime lookup failed: ${rowErr.message}`);
  if (!row) {
    // Unknown id OR another company's request — same 404, no existence leak.
    return json({ error: 'Overtime request not found in your company' }, 404);
  }
  const req0 = row as { labour_profile_id: string; status: string };

  // 4. A supervisor can never decide their own request.
  if (req0.labour_profile_id === supervisor.id) {
    return json({ error: 'You cannot approve or reject your own overtime request' }, 403);
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
    .from('overtime_requests')
    .update(updates)
    .eq('id', requestId)
    .eq('status', 'pending') // in the WHERE: two supervisors racing -> one wins
    .eq('company_id', supervisor.company_id)
    .select()
    .maybeSingle();

  if (updateErr) {
    // PGRST204 = column not found -> review_notes migration not applied yet.
    if (updateErr.code === 'PGRST204' && 'review_notes' in updates) {
      return json({
        error: 'review_notes cannot be stored yet — migration 20261113190001 (overtime review notes) is not applied',
        hint: 'Apply migration 20261113190001 to store rejection reasons. Approve works without it.',
      }, 503);
    }
    console.error('[supervisor] overtime update error:', updateErr.message);
    return json({ error: 'Failed to update overtime request' }, 500);
  }

  // 7. 0 rows updated = lost a race (another supervisor decided first) or RLS
  //    blocked the write. Both surface as 409 with the fresh status.
  if (!updated) {
    const { data: fresh } = await supabase
      .from('overtime_requests')
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

// ---------------------------------------------------------------------------
// GET /supervisor/labourers — labourers in my company (with current assignment)
// ---------------------------------------------------------------------------
/**
 * Directory of my company's labourers: name, id, phone, profile details and
 * their CURRENT (open) assignment. "Assigned to the supervisor" = same company
 * (no supervisor->labourer assignment table exists in the schema).
 * Sensitive auth data (user_id) is never returned.
 */
async function handleLabourers(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. All labourer profiles in MY company (RLS company-wide SELECT makes this
  //    legal). Only workers — supervisors are not "labourers".
  const { data, error } = await supabase
    .from('labour_profiles')
    .select('id, full_name, employee_code, phone, role, employment_type, wage_type, hourly_rate, status, created_at')
    .eq('company_id', supervisor.company_id)
    .order('employee_code', { ascending: true });
  if (error) throw new Error(`labourers query failed: ${error.message}`);

  const profiles = (data ?? []) as LabourerProfileRow[];
  const workers = profiles.filter((p) => !(SUPERVISOR_ROLES as readonly string[]).includes((p.role ?? '').toLowerCase()));
  if (workers.length === 0) return json({ data: [] }, 200);

  // 3. Open assignments (pending/in_progress/overdue) for those labourers —
  //    one small query instead of one per labourer (no N+1).
  const { data: openRows, error: openErr } = await supabase
    .from('work_assignments')
    .select('id, labour_profile_id, title, description, quantity_target, due_date, status, created_at')
    .eq('company_id', supervisor.company_id)
    .in('labour_profile_id', workers.map((w) => w.id))
    .in('status', ['pending', 'in_progress', 'overdue'])
    .order('created_at', { ascending: false });
  if (openErr) throw new Error(`open assignments query failed: ${openErr.message}`);

  // 4. Map each labourer to their most recent open assignment (if any).
  const openByLabour = new Map<string, OpenAssignmentRow>();
  for (const a of (openRows ?? []) as OpenAssignmentRow[]) {
    const lid = a.labour_profile_id;
    if (lid && !openByLabour.has(lid)) openByLabour.set(lid, a);
  }

  // 5. Shape the response rows.
  const rows = workers.map((p) => {
    const a = openByLabour.get(p.id);
    const shaped = a ? shapeOpenAssignment(a) : null;
    return {
      id: p.id,
      labour_name: p.full_name,
      employee_code: p.employee_code,
      phone: p.phone,
      employment_type: p.employment_type,
      wage_type: p.wage_type,
      hourly_rate: p.hourly_rate,
      profile_status: p.status,
      member_since: p.created_at,
      current_assignment: shaped,
    };
  });
  return json({ data: rows }, 200);
}

// ---------------------------------------------------------------------------
// GET /supervisor/labourers/<uuid> — one labourer's details
// ---------------------------------------------------------------------------
/**
 * One labourer's profile + their recent assignments (newest first).
 * 404 for unknown ids AND other companies' labourers (no existence leak).
 */
async function handleLabourerDetail(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
  labourId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. The id must be a valid UUID — a non-UUID would make PostgREST throw a
  //    cast error (22P02) that surfaces as a 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labourer id must be a valid UUID — copy an id from GET /supervisor/labourers' }, 400);
  }

  // 3. Load the profile — must be in MY company.
  const { data: profile, error: pErr } = await supabase
    .from('labour_profiles')
    .select('id, full_name, employee_code, phone, role, employment_type, wage_type, hourly_rate, status, metadata, created_at')
    .eq('id', labourId)
    .eq('company_id', supervisor.company_id)
    .maybeSingle();
  if (pErr) throw new Error(`labourer lookup failed: ${pErr.message}`);
  const p = profile as LabourerProfileRow | null;
  if (!p) return json({ error: 'Labourer not found in your company' }, 404);

  // 4. Their assignments, newest first (RLS company-wide SELECT makes this
  //    legal). Limited to 10 — this is a profile view, not a full history.
  const { data: assignments, error: aErr } = await supabase
    .from('work_assignments')
    .select('id, title, description, quantity_target, due_date, status, accepted_at, created_at')
    .eq('labour_profile_id', p.id)
    .eq('company_id', supervisor.company_id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (aErr) throw new Error(`labourer assignments query failed: ${aErr.message}`);

  // 5. Shape the response. user_id is deliberately excluded (auth data).
  return json({
    data: {
      id: p.id,
      labour_name: p.full_name,
      employee_code: p.employee_code,
      phone: p.phone,
      role: p.role,
      employment_type: p.employment_type,
      wage_type: p.wage_type,
      hourly_rate: p.hourly_rate,
      profile_status: p.status,
      metadata: p.metadata ?? null,
      member_since: p.created_at,
      assignments: ((assignments ?? []) as OpenAssignmentRow[]).map(shapeOpenAssignment),
    },
  }, 200);
}

// ---------------------------------------------------------------------------
// GET /supervisor/updates — field reports from my company's labourers
// ---------------------------------------------------------------------------
/**
 * Labour updates (machine maintenance / breakdown / raw-material defects /
 * other), newest first. Filters: ?labour_id= ?type= ?from= ?to=.
 * "Assigned to the supervisor" = same company (no supervisor->labourer
 * assignment table exists in the schema).
 * The labour_updates table only exists after migration 20261113200001 — until
 * then this returns an empty list with a hint instead of a 500.
 */
async function handleUpdates(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Validate the optional filters.
  //    ?labour_id= -> one labourer (must be a valid UUID, else PostgREST
  //                   22P02 -> 500)
  //    ?type=      -> one update type (must match the enum)
  //    ?from/?to=  -> calendar-date range on created_at (company timezone ->
  //                   UTC window, same convention as the other endpoints)
  const url = new URL(req.url);
  const labourId = url.searchParams.get('labour_id');
  if (labourId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
    return json({ error: 'labour_id must be a valid UUID' }, 400);
  }
  const type = url.searchParams.get('type');
  if (type && !UPDATE_TYPES.includes(type as typeof UPDATE_TYPES[number])) {
    return json({ error: `type must be one of: ${UPDATE_TYPES.join(', ')}` }, 400);
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && !isValidDate(from)) return json({ error: 'from must be a valid date in YYYY-MM-DD format' }, 400);
  if (to && !isValidDate(to)) return json({ error: 'to must be a valid calendar date in YYYY-MM-DD format' }, 400);
  if (from && to && from > to) return json({ error: 'from must be on or before to' }, 400);

  // 3. Query updates in MY company, newest first, labourer embedded.
  //    RLS (company-wide SELECT) makes this legal.
  let query = supabase
    .from('labour_updates')
    .select('*, labour_profiles(id, full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (labourId) query = query.eq('labour_profile_id', labourId);
  if (type) query = query.eq('update_type', type);
  const tz = await companyTimezone(supabase, supervisor.company_id);
  if (from) query = query.gte('created_at', dayStartUtc(from, tz));
  if (to) query = query.lte('created_at', dayEndUtc(to, tz));

  const { data, error } = await query;
  // Table missing -> migration 20261113200001 not applied; empty list + hint.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    return json({
      data: [],
      hint: 'Migration 20261113200001 (labour_updates) is not applied yet — no updates exist to show',
    }, 200);
  }
  if (error) throw new Error(`updates query failed: ${error.message}`);

  // 4. Shape each row: flatten the join.
  const rows = ((data ?? []) as (UpdateRow & { labour_profiles?: { id: string; full_name: string; employee_code: string } | null })[])
    .map((r) => {
      const lp = r.labour_profiles ?? null;
      return {
        id: r.id,
        labour: lp ? { id: lp.id, name: lp.full_name, employee_code: lp.employee_code } : null,
        update_type: r.update_type,
        description: r.description,
        voice_note_url: r.voice_note_url,
        image_url: r.image_url,
        submitted_at: r.created_at,
      };
    });
  return json({ data: rows }, 200);
}
