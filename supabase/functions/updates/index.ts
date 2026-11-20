// Supabase Edge Function: updates
//
// WHAT IT DOES (labour-side only)
//   POST /updates  -> submit a field report: machine maintenance, machine
//                     breakdown, raw-material defect, or other work activity
//   GET  /updates  -> my own updates, newest first (optional ?type= filter)
//
// AUTH
//   Same pattern as the other functions: anon key + the caller's user JWT.
//   RLS is the real boundary. The service-role key is NEVER used here.
//
// SCHEMA (migration 20261113200001 — DRAFT, not applied yet)
//   labour_updates: id, company_id, labour_profile_id, update_type
//   (labour_update_type enum: machine_maintenance | machine_breakdown |
//   raw_material_defect | other), description, voice_note_url, image_url,
//   created_at, updated_at.
//   Until the migration is applied the table does not exist: POST returns 503
//   with a hint, GET returns an empty list with the same hint. No redeploy is
//   needed after the migration — the endpoints start working immediately.
//
// VALIDATION
//   update_type    : required, one of the four enum values
//   description    : required text, 1..2000 chars
//   voice_note_url : optional http(s) URL, max 1000 chars
//   image_url      : optional http(s) URL, max 1000 chars
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

// Valid update types (must match the labour_update_type enum in the migration).
const UPDATE_TYPES = ['machine_maintenance', 'machine_breakdown', 'raw_material_defect', 'other'] as const;

/** Last path segment: /updates/apply -> "apply". */
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

  // Route by the last path segment. Only the function root ("/updates") is
  // valid — anything else (e.g. /updates/unknown) is a 404, same as the
  // supervisor function.
  const route = routeName(req);
  try {
    if (route !== 'updates') {
      return json({ error: 'Unknown route. Use /updates (POST to submit, GET for my history)' }, 404);
    }
    if (req.method === 'POST') return await handleSubmit(req, supabase, userId);
    if (req.method === 'GET') return await handleMyUpdates(req, supabase, userId);
    return json({ error: 'Unknown route. Use /updates (POST to submit, GET for my history)' }, 404);
  } catch (err) {
    console.error('[updates] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /updates — submit a field report
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

  // 2. Validate "update_type" — required, one of the four enum values.
  const type = body['update_type'];
  if (typeof type !== 'string' || !(UPDATE_TYPES as readonly string[]).includes(type)) {
    return json({ error: `update_type is required and must be one of: ${UPDATE_TYPES.join(', ')}` }, 400);
  }

  // 3. Validate "description" — required, 1..2000 chars.
  const description = typeof body['description'] === 'string' ? body['description'].trim() : '';
  if (!description) return json({ error: 'description is required' }, 400);
  if (description.length > 2000) return json({ error: 'description must be 2000 characters or fewer' }, 400);

  // 4. Validate the optional attachment URLs (http(s), max 1000 chars).
  const voiceNote = validateUrl(body['voice_note_url'], 'voice_note_url');
  if (voiceNote.error) return json({ error: voiceNote.error }, 400);
  const imageUrl = validateUrl(body['image_url'], 'image_url');
  if (imageUrl.error) return json({ error: imageUrl.error }, 400);

  // 5. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  if (profile.status !== 'active') {
    return json({ error: `Submitting not allowed: profile status is '${profile.status}'` }, 403);
  }

  // 6. Insert. company_id comes from my profile; created_at is set by the DB.
  const payload = {
    company_id: profile.company_id,
    labour_profile_id: profile.id,
    update_type: type,
    description,
    voice_note_url: voiceNote.url,
    image_url: imageUrl.url,
  };
  const { data, error } = await supabase
    .from('labour_updates')
    .insert(payload)
    .select()
    .maybeSingle();

  // 42P01 (undefined_table) / PGRST205 (not in schema cache) -> migration
  // 20261113200001 not applied yet. Say so clearly instead of a raw 500.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    return json({
      error: 'Updates cannot be stored yet — migration 20261113200001 (labour_updates) is not applied',
      hint: 'Apply migration 20261113200001 to enable labour updates.',
    }, 503);
  }
  if (error) {
    console.error('[updates] insert error:', error.message);
    return json({ error: 'Failed to submit update' }, 500);
  }

  // 201 Created.
  return json({ data: data as UpdateRow | null }, 201);
}

// ---------------------------------------------------------------------------
// GET /updates — my own updates, newest first
// ---------------------------------------------------------------------------
async function handleMyUpdates(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
): Promise<Response> {
  // 1. Load my profile.
  const profile = await loadProfile(supabase, userId);
  if (!profile) return json({ error: 'No labour profile exists for the authenticated user' }, 404);

  // 2. Optional ?type= filter (must match the enum).
  const typeParam = new URL(req.url).searchParams.get('type');
  let query = supabase
    .from('labour_updates')
    .select('*')
    .eq('labour_profile_id', profile.id) // only MY updates, even though RLS allows the whole company
    .order('created_at', { ascending: false })
    .limit(200);
  if (typeParam !== null) {
    if (!(UPDATE_TYPES as readonly string[]).includes(typeParam)) {
      return json({ error: `type must be one of: ${UPDATE_TYPES.join(', ')}` }, 400);
    }
    query = query.eq('update_type', typeParam);
  }

  const { data, error } = await query;
  // Table missing -> migration not applied; return an empty list with a hint.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
    return json({
      data: [],
      hint: 'Migration 20261113200001 (labour_updates) is not applied yet — no updates exist to show',
    }, 200);
  }
  if (error) throw new Error(`updates query failed: ${error.message}`);
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

/** Validate an optional attachment URL: http(s), max 1000 chars. */
function validateUrl(raw: unknown, field: string): { url?: string; error?: string } {
  if (raw === undefined || raw === null) return {}; // optional
  if (typeof raw !== 'string') return { error: `${field} must be a string URL` };
  const url = raw.trim();
  if (!url) return {}; // empty string treated as "not provided"
  if (!/^https?:\/\/.+/i.test(url)) return { error: `${field} must be an http(s) URL` };
  if (url.length > 1000) return { error: `${field} must be 1000 characters or fewer` };
  return { url };
}
