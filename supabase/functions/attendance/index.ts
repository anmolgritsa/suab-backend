// Supabase Edge Function: attendance
//
// WHAT IT DOES
//   POST /attendance/check-in   -> mark today's attendance (GPS geofence check)
//   POST /attendance/check-out  -> close today's attendance row
//   GET  /attendance/history    -> my attendance rows, optional ?from= &to=
//
// AUTH
//   Same pattern as labour-profile: anon key + the caller's user JWT.
//   RLS policies (attendance_insert_own_or_privileged etc.) are the real
//   security boundary. The service-role key is NEVER used here.
//
// GEOFENCE
//   companies.geofence_* columns (migration 20261113110001, DRAFT).
//   Server-side haversine distance vs the company radius. The client's
//   claimed "verified" status is ignored — we compute it ourselves.
//
// DATE/TIMEZONE
//   The attendance date is computed from the company timezone in
//   companies.settings.timezone (IANA name, default "Asia/Kolkata").
//   check_in/check_out are stored as real timestamptz (UTC instants).
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }
//   error   -> { "error": "message" }

// deno-lint-ignore-file no-explicit-any
import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// ---------------------------------------------------------------------------
// ENTRYPOINT — routing, CORS, auth
// ---------------------------------------------------------------------------

/** Extract the last path segment: /attendance/check-in -> "check-in". */
function routeName(req: Request): string {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  return path.split('/').pop() ?? '';
}

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
    if (req.method === 'POST' && route === 'check-in') return await handleCheckIn(req, supabase, userId);
    if (req.method === 'POST' && route === 'check-out') return await handleCheckOut(supabase, userId);
    if (req.method === 'GET' && route === 'history') return await handleHistory(req, supabase, userId);
    return json({ error: `Unknown route. Use /attendance/check-in, /attendance/check-out, /attendance/history` }, 404);
  } catch (err) {
    console.error('[attendance] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
export async function handleHistory(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional date filters (?from=YYYY-MM-DD&to=YYYY-MM-DD).
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const dateFilter = /^\d{4}-\d{2}-\d{2}$/; // strict YYYY-MM-DD
  if (from && !dateFilter.test(from)) return json({ error: 'from must be YYYY-MM-DD' }, 400);
  if (to && !dateFilter.test(to)) return json({ error: 'to must be YYYY-MM-DD' }, 400);

  // 3. Query my attendance rows (RLS: company-wide SELECT, but we filter to own profile).
  let query = supabase
    .from('attendance')
    .select('*')
    .eq('labour_profile_id', profile.id)
    .order('date', { ascending: false })
    .limit(90); // ~3 months cap

  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);

  const { data, error } = await query;
  if (error) {
    console.error('[attendance] history error:', error.message);
    return json({ error: 'Failed to fetch attendance history' }, 500);
  }

  return json({ data }, 200);
}
export async function handleCheckOut(
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // Ensure a valid check-in exists before check-out.
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Today's date in the company timezone.
  const company = await loadCompany(supabase, profile.company_id);
  if (!company) return json({ error: 'Company not found for this profile' }, 500);
  const tz = typeof company.settings?.['timezone'] === 'string' ? company.settings['timezone'] as string : undefined;
  const today = attendanceDateFor(tz);

  // 3. Find today's attendance row.
  const { data: existing, error: existingErr } = await checkOutRow(supabase, profile.id, today);
  if (existingErr) throw new Error(`checkout lookup failed: ${existingErr.message}`);
  if (!existing) {
    // No row today -> no check-in happened -> cannot check out.
    return json({ error: 'No check-in found for today. Check in first.' }, 404);
  }
  if (existing.check_out) {
    // Already checked out -> 409.
    return json({ error: 'Already checked out for today', existing }, 409);
  }

  // 4. Record check-out (RLS: own row only).
  const { data: updated, error: updateErr } = await supabase
    .from('attendance')
    .update({ check_out: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('labour_profile_id', profile.id)
    .select()
    .maybeSingle();

  if (updateErr) {
    console.error('[attendance] check-out update error:', updateErr.message);
    return json({ error: 'Failed to record check-out' }, 409);
  }
  if (!updated) return json({ error: 'No check-in found for today. Check in first.' }, 404);

  return json({ data: updated }, 200);
}

/** Fetch today's attendance row for a profile. */
async function checkOutRow(
  supabase: ReturnType<typeof createClientForUser>,
  profileId: string,
  date: string,
): Promise<{ data: AttendanceRow | null; error: { message: string } | null }> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('labour_profile_id', profileId)
    .eq('date', date)
    .maybeSingle();
  return { data: (data as AttendanceRow | null), error };
}
export async function handleCheckIn(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Parse the JSON body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  const input = body as Record<string, unknown>;

  // 2. Validate GPS (server-side; never trust client claims).
  const coords = parseCoordinates(input);
  if ('error' in coords) return json({ error: coords.error }, 400);

  // 3. Load my profile + company geofence config.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Attendance not allowed: profile status is '${profile.status}'` }, 403);
  }

  const company = await loadCompany(supabase, profile.company_id);
  if (!company) return json({ error: 'Company not found for this profile' }, 500);

  // 4. Geofence check (server-side haversine vs company radius).
  let location_verified = false;
  if (company.geofence_enabled === true) {
    const { geofence_latitude: lat, geofence_longitude: lng, geofence_radius_m: radius } = company;
    if (lat === null || lng === null || radius === null) {
      return json({ error: 'Company geofence is enabled but not fully configured' }, 500);
    }
    const distance = haversineMeters(coords.lat, coords.lng, lat, lng);
    if (distance > radius) {
      return json({
        error: 'Check-in rejected: you are outside the allowed geofence',
        distance_meters: Math.round(distance),
        allowed_radius_meters: radius,
      }, 403);
    }
    location_verified = true;
  }

  // 5. Compute the attendance date in the company timezone.
  const tz = typeof company.settings?.['timezone'] === 'string' ? company.settings['timezone'] as string : undefined;
  const today = attendanceDateFor(tz);

  // 6. Duplicate check: is there already a row for me + today?
  const { data: existing, error: existingErr } = await supabase
    .from('attendance')
    .select('id, check_in, check_out, status')
    .eq('labour_profile_id', profile.id)
    .eq('date', today)
    .maybeSingle();
  if (existingErr) throw new Error(`duplicate check failed: ${existingErr.message}`);

  if (existing) {
    // Already checked in today -> 409 Conflict.
    return json({
      error: 'Attendance already recorded for today',
      existing: existing,
    }, 409);
  }

  // 7. Insert the attendance row. RLS (attendance_insert_own_or_privileged)
  //    enforces company + own-profile; the unique index is the final guard
  //    against concurrent duplicate check-ins.
  const { data: inserted, error: insertErr } = await supabase
    .from('attendance')
    .insert({
      company_id: profile.company_id,
      labour_profile_id: profile.id,
      date: today,
      check_in: new Date().toISOString(),
      status: location_verified ? 'present' : 'on_duty',
      // shift_id left null: shift assignment is a future feature.
    })
    .select()
    .maybeSingle();

  if (insertErr) {
    // 23505 = unique_violation: a concurrent request won the race.
    if (insertErr.code === '23505') {
      return json({ error: 'Attendance already recorded for today (concurrent request)' }, 409);
    }
    console.error('[attendance] check-in insert error:', insertErr.message);
    return json({ error: 'Failed to record check-in' }, 500);
  }

  return json({
    data: {
      ...inserted,
      location_verified,
      distance_meters: company.geofence_enabled === true
        ? Math.round(haversineMeters(coords.lat, coords.lng, company.geofence_latitude!, company.geofence_longitude!))
        : null,
    },
  }, 201);
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
 * Fetch the company row (geofence config + settings).
 *
 * Graceful fallback: until migration 20261113110001 is applied, the
 * geofence_* columns do not exist and the first select fails with 42703
 * (undefined_column). In that case we load base columns and treat the
 * geofence as disabled, so check-in/out/history keep working. Once the
 * migration is pushed, geofence enforcement activates automatically.
 */
async function loadCompany(
  supabase: ReturnType<typeof createClientForUser>,
  companyId: string,
): Promise<CompanyGeofence | null> {
  const withGeo = await supabase
    .from('companies')
    .select('id, settings, geofence_enabled, geofence_latitude, geofence_longitude, geofence_radius_m')
    .eq('id', companyId)
    .limit(1)
    .maybeSingle();

  if (!withGeo.error) return (withGeo.data as CompanyGeofence | null);

  // 42703 = undefined_column -> migration not applied yet.
  if (withGeo.error.code === '42703') {
    console.warn('[attendance] geofence columns missing (migration 20261113110001 not applied) — geofence checks disabled');
    const { data, error } = await supabase
      .from('companies')
      .select('id, settings')
      .eq('id', companyId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`company lookup failed: ${error.message}`);
    if (!data) return null;
    return {
      ...(data as { id: string; settings: Record<string, unknown> }),
      geofence_enabled: false,
      geofence_latitude: null,
      geofence_longitude: null,
      geofence_radius_m: null,
    };
  }

  throw new Error(`company lookup failed: ${withGeo.error.message}`);
}

/**
 * Today's date (YYYY-MM-DD) in the company's timezone.
 * Timezone comes from companies.settings.timezone (IANA name); falls back to
 * Asia/Kolkata when unset/invalid. This keeps the attendance date consistent
 * no matter where the server or client runs.
 */
export function attendanceDateFor(timezone: string | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Kolkata' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
  }
}

/** Validate client-supplied GPS coordinates server-side. */
export function parseCoordinates(body: Record<string, unknown>): { lat: number; lng: number } | { error: string } {
  const lat = body['latitude'];
  const lng = body['longitude'];
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return { error: 'latitude must be a number' };
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return { error: 'longitude must be a number' };
  if (lat < -90 || lat > 90) return { error: 'latitude must be between -90 and 90' };
  if (lng < -180 || lng > 180) return { error: 'longitude must be between -180 and 180' };
  return { lat, lng };
}

/** Haversine distance in metres between two lat/lng points. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth mean radius in metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
interface CompanyGeofence {
  id: string;
  geofence_enabled: boolean;
  geofence_latitude: number | null;
  geofence_longitude: number | null;
  geofence_radius_m: number | null;
  settings: Record<string, unknown>;
}

interface LabourProfile {
  id: string;
  company_id: string;
  status: string;
}

interface AttendanceRow {
  id: string;
  company_id: string;
  labour_profile_id: string;
  shift_id: string | null;
  date: string;
  check_in: string | null;
  check_out: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
