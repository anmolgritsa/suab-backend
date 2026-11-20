// Supabase Edge Function: emergency
//
// WHAT IT DOES
//   POST /emergency      -> a labourer triggers an SOS alert (GPS + type)
//   GET  /emergency      -> supervisors: the alert queue of their company
//   PATCH /emergency/<id>-> supervisors: acknowledge or resolve an alert
//
// AUTH
//   Same pattern as the other functions: anon key + the caller's user JWT.
//   RLS is the real boundary. The service-role key is NEVER used here.
//   company_id and labour_profile_id are ALWAYS derived from the caller's own
//   profile — never trusted from the request body.
//
// SCHEMA (migration 20261113210001 — see supabase/migrations/)
//   emergency_alerts: id, company_id, labour_profile_id, emergency_type
//   (emergency_type enum: accident | medical | fire | other), latitude,
//   longitude, status (emergency_status enum: pending | acknowledged |
//   resolved), acknowledged_by/at, resolved_by/at, created_at, updated_at.
//
// NOTIFICATIONS
//   For now the notification channel IS the pending queue (GET /emergency,
//   pending first). Real push/email needs an external service + secret —
//   separate step, like the factory bell.
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

interface SupervisorProfile {
  id: string;
  company_id: string;
  status: string;
  role: string | null;
}

interface AlertRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  emergency_type: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  labour_profiles?: { id: string; full_name: string; employee_code: string } | null;
}

// Valid emergency types (must match the emergency_type enum in the migration).
const EMERGENCY_TYPES = ['accident', 'medical', 'fire', 'other'] as const;

// Allowed status transitions. resolved is frozen; no going back.
const TRANSITIONS: Record<string, string[]> = {
  pending: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

/** Last path segment: /emergency/<uuid> -> "<uuid>". */
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

  // Route: the function root ("/emergency") carries POST + GET; a UUID last
  // segment is the PATCH detail route. Anything else is a 404.
  const route = routeName(req);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(route);
  try {
    if (route === 'emergency') {
      if (req.method === 'POST') return await handleTrigger(req, supabase, userId);
      return await handleList(req, supabase, userId); // GET
    }
    if (isUuid && req.method === 'PATCH') return await handleManage(req, supabase, userId, route);
    if (req.method === 'PATCH') {
      return json({ error: 'alert id must be a valid UUID — copy an id from GET /emergency' }, 400);
    }
    return json({ error: 'Unknown route. Use /emergency (POST to trigger, GET for the queue) or PATCH /emergency/<alert id>' }, 404);
  } catch (err) {
    console.error('[emergency] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ### section-trigger
// ---------------------------------------------------------------------------
// POST /emergency — a labourer triggers an SOS
// ---------------------------------------------------------------------------
async function handleTrigger(
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

  // 2. Validate "emergency_type" — required, one of the four enum values.
  const type = body['emergency_type'];
  if (typeof type !== 'string' || !(EMERGENCY_TYPES as readonly string[]).includes(type)) {
    return json({ error: `emergency_type is required and must be one of: ${EMERGENCY_TYPES.join(', ')}` }, 400);
  }

  // 3. Validate the GPS coordinates (numbers, bounded). Optional: a failed
  //    fix must never block an SOS.
  const lat = validateCoord(body['latitude'], 'latitude', -90, 90);
  if (lat.error) return json({ error: lat.error }, 400);
  const lon = validateCoord(body['longitude'], 'longitude', -180, 180);
  if (lon.error) return json({ error: lon.error }, 400);

  // 4. Load MY profile. company_id and labour_profile_id are ALWAYS derived
  //    from the authenticated user — never trusted from the body.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `SOS not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 5. Duplicate guard: one OPEN (pending) SOS per labourer at a time.
  //    Acknowledged/resolved alerts never block a new emergency.
  const { data: existing, error: dupErr } = await supabase
    .from('emergency_alerts')
    .select('id, emergency_type, created_at')
    .eq('labour_profile_id', profile.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dupErr) {
    console.error('[emergency] duplicate check failed:', dupErr.message);
    return json({ error: 'Failed to check for an existing SOS' }, 500);
  }
  if (existing) {
    return json({
      error: 'You already have a PENDING emergency alert. Supervisors have been notified — wait for it to be acknowledged.',
      existing_alert: existing,
    }, 409);
  }

  // 6. Insert. Status defaults to 'pending' in the DB; created_at too.
  const payload: Record<string, unknown> = {
    company_id: profile.company_id,
    labour_profile_id: profile.id,
    emergency_type: type,
  };
  if (lat.value !== undefined) payload['latitude'] = lat.value;
  if (lon.value !== undefined) payload['longitude'] = lon.value;

  const { data, error } = await supabase
    .from('emergency_alerts')
    .insert(payload)
    .select()
    .maybeSingle();

  // 42P01 / PGRST205 -> migration 20261113210001 not applied yet.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    return json({
      error: 'SOS cannot be stored yet — migration 20261113210001 (emergency_alerts) is not applied',
      hint: 'Apply migration 20261113210001 to enable emergency alerts.',
    }, 503);
  }
  if (error) {
    console.error('[emergency] insert error:', error.message);
    return json({ error: 'Failed to trigger SOS' }, 500);
  }

  // 201 Created. The notification channel is the pending queue itself
  // (GET /emergency) — push/email is a separate step.
  return json({ data: data as AlertRow | null }, 201);
}

// ### endsection

// ### section-list
// ---------------------------------------------------------------------------
// GET /emergency — the alert queue (supervisor side)
// ---------------------------------------------------------------------------
async function handleList(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Optional filters: ?status= (enum) and ?labour_id= (UUID).
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  // Three FKs point to labour_profiles (labour_profile_id, acknowledged_by,
  // resolved_by) — the embed must name the constraint or PostgREST refuses
  // with PGRST201 (ambiguous relationship).
  let query = supabase
    .from('emergency_alerts')
    .select('*, labour_profiles!emergency_alerts_labour_profile_id_fkey(id, full_name, employee_code)')
    .eq('company_id', supervisor.company_id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (statusParam !== null) {
    if (!['pending', 'acknowledged', 'resolved'].includes(statusParam)) {
      return json({ error: 'status must be one of: pending, acknowledged, resolved' }, 400);
    }
    query = query.eq('status', statusParam);
  }
  const labourId = url.searchParams.get('labour_id');
  if (labourId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labourId)) {
      return json({ error: 'labour_id must be a valid UUID' }, 400);
    }
    query = query.eq('labour_profile_id', labourId);
  }

  const { data, error } = await query;
  // Table missing -> migration not applied; empty list with a hint.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    return json({
      data: [],
      hint: 'Migration 20261113210001 (emergency_alerts) is not applied yet — no alerts exist to show',
    }, 200);
  }
  if (error) throw new Error(`alerts query failed: ${error.message}`);

  // Shape rows like the other supervisor endpoints: labour fields at the top
  // level instead of the raw PostgREST embed object.
  const shaped = (data ?? []).map((row) => {
    const r = { ...(row as Record<string, unknown>) };
    const embed = r['labour_profiles'] as { full_name?: string; employee_code?: string } | null;
    delete r['labour_profiles'];
    return {
      ...r,
      labour_name: embed?.full_name ?? null,
      employee_code: embed?.employee_code ?? null,
    };
  });
  return json({ data: shaped }, 200);
}

// ### endsection

// ### section-manage
// ---------------------------------------------------------------------------
// PATCH /emergency/<id> — acknowledge or resolve an alert (supervisor side)
// ---------------------------------------------------------------------------
async function handleManage(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
  alertId: string,
): Promise<Response> {
  // 1. Must be a supervisor.
  const supervisor = await requireSupervisor(supabase, userId);
  if (!supervisor) return json({ error: 'Supervisor role required' }, 403);

  // 2. Parse the JSON body.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }

  // 3. Validate "status" — the only field a supervisor can change here.
  const status = body['status'];
  if (typeof status !== 'string' || !['acknowledged', 'resolved'].includes(status)) {
    return json({ error: 'status is required and must be one of: acknowledged, resolved' }, 400);
  }

  // 4. Load the alert — must be in MY company (RLS company-wide SELECT).
  const { data: alert, error: aErr } = await supabase
    .from('emergency_alerts')
    .select('*')
    .eq('id', alertId)
    .eq('company_id', supervisor.company_id)
    .maybeSingle();
  if (aErr) throw new Error(`alert lookup failed: ${aErr.message}`);
  const current = alert as AlertRow | null;
  if (!current) return json({ error: 'Alert not found in your company' }, 404);

  // 5. Enforce the status transitions. resolved is frozen; no going back.
  const allowed = TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(status)) {
    return json({
      error: `Alert cannot move from '${current.status}' to '${status}'. Allowed from '${current.status}': ${allowed.length ? allowed.join(', ') : 'nothing (already resolved)'}`,
      current_status: current.status,
    }, 409);
  }

  // 6. Update with the transition condition in the WHERE — two supervisors
  //    racing on the same alert: only one wins, the other gets 0 rows.
  const patch: Record<string, unknown> = { status };
  if (status === 'acknowledged') {
    patch['acknowledged_by'] = supervisor.id;
    patch['acknowledged_at'] = new Date().toISOString();
  } else {
    patch['resolved_by'] = supervisor.id;
    patch['resolved_at'] = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('emergency_alerts')
    .update(patch)
    .eq('id', alertId)
    .eq('company_id', supervisor.company_id)
    .eq('status', current.status) // race guard: only from the state we just read
    .select()
    .maybeSingle();

  if (error) {
    console.error('[emergency] update error:', error.message);
    return json({ error: 'Failed to update alert' }, 500);
  }
  if (!data) {
    // 0 rows = someone else decided first (or RLS blocked). Same 409 either way.
    return json({ error: 'Alert already processed by someone else', current_status: current.status }, 409);
  }
  return json({ data: data as AlertRow }, 200);
}

// ### endsection

// ### section-helpers
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

/** Validate a GPS coordinate: number, bounded. Returns {value} or {error}. */
function validateCoord(raw: unknown, field: string, min: number, max: number): { value?: number; error?: string } {
  if (raw === undefined || raw === null) return {}; // optional
  if (typeof raw !== 'number' || Number.isNaN(raw)) return { error: `${field} must be a number` };
  if (raw < min || raw > max) return { error: `${field} must be between ${min} and ${max}` };
  return { value: raw };
}

// ### endsection
