// Supabase Edge Function: labour-profile
//
// WHAT IT DOES
//   GET   -> returns the logged-in worker's own labour profile (+ company name)
//   PATCH -> updates ONLY full_name and phone on that profile
//
// AUTH (how every request is checked)
//   1. Client sends:  Authorization: Bearer <user JWT>   (from Supabase Auth login)
//   2. We decode the JWT to get the user id ("sub" claim).
//   3. We create a Supabase client with the PUBLIC anon key + the user's JWT.
//      Row Level Security (RLS) in the database makes sure a user can only
//      read/update their OWN profile row. We never use the service-role key
//      here — it bypasses RLS and must stay server-side only.
//
// RESPONSE SHAPES (always JSON)
//   success -> { "data": ... }
//   error   -> { "error": "message" }
//
// PATCH RULE (documented decision): we REJECT (400) any field other than
// full_name / phone instead of silently ignoring it, so clients find their
// bugs immediately. The DB also has a trigger + RLS as backup protection.

import { createClientForUser, contextFromRequest, AuthError } from '../_shared/auth.ts';
import { json, methodNotAllowed, OPTIONS } from '../_shared/cors.ts';

// ---------------------------------------------------------------------------
// GET — return the caller's own profile
// ---------------------------------------------------------------------------
async function handleGet(supabase: ReturnType<typeof createClientForUser>, userId: string) {
  // ".eq('user_id', userId)" = only this user's row.
  // "company:companies(...)" = also pull the company name in the same query.
  const { data, error } = await supabase
    .from('labour_profiles')
    .select('*, company:companies ( id, name, slug, industry, size )')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle(); // maybeSingle = null instead of error when no row exists

  if (error) {
    console.error('[labour-profile] GET error:', error.message);
    return json({ error: 'Failed to fetch labour profile' }, 500);
  }

  // User is logged in but has no labour profile yet.
  if (!data) {
    return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  }

  return json({ data }, 200);
}

// ---------------------------------------------------------------------------
// PATCH — update full_name and/or phone on the caller's own profile
// ---------------------------------------------------------------------------
async function handlePatch(
  req: Request,
  supabase: ReturnType<typeof createClientForUser>,
  userId: string,
) {
  // 1. Read the JSON body (must be valid JSON).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400);
  }

  // 2. Validate the body (see validatePatch below).
  const result = validatePatch(body);
  if (!result.ok) {
    return json({ error: result.error, ...(result.rejected ? { rejected: result.rejected } : {}) }, 400);
  }

  // 3. Update the row. RLS + ".eq('user_id', userId)" make sure a user can
  //    only ever update their OWN profile.
  const { data, error } = await supabase
    .from('labour_profiles')
    .update(result.patch)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[labour-profile] PATCH error:', error.message);
    return json({ error: 'Failed to update labour profile' }, 500);
  }

  if (!data) {
    return json({ error: 'No labour profile exists for the authenticated user' }, 404);
  }

  return json({ data }, 200);
}

// ---------------------------------------------------------------------------
// PATCH validation — the only fields a worker may change: full_name, phone.
// Anything else -> 400 with the list of rejected fields.
// ---------------------------------------------------------------------------
function validatePatch(body: unknown):
  | { ok: true; patch: { full_name?: string; phone?: string | null } }
  | { ok: false; error: string; rejected?: string[] } {
  // Body must be a JSON object like { "full_name": "...", "phone": "..." }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const input = body as Record<string, unknown>;

  // Reject any field that is not full_name / phone (e.g. role, status, hourly_rate).
  const rejected = Object.keys(input).filter((k) => k !== 'full_name' && k !== 'phone');
  if (rejected.length > 0) {
    return {
      ok: false,
      error: `Fields cannot be changed via this endpoint: ${rejected.join(', ')}. Permitted: full_name, phone`,
      rejected,
    };
  }

  const patch: { full_name?: string; phone?: string | null } = {};

  // full_name: required to be a non-empty string, max 200 chars.
  if ('full_name' in input) {
    const v = input['full_name'];
    if (typeof v !== 'string') return { ok: false, error: 'full_name must be a string' };
    const trimmed = v.trim();
    if (trimmed.length === 0) return { ok: false, error: 'full_name must not be empty' };
    if (trimmed.length > 200) return { ok: false, error: 'full_name must be at most 200 characters' };
    patch.full_name = trimmed;
  }

  // phone: string or null. Empty string "" is treated as "clear the phone".
  if ('phone' in input) {
    const v = input['phone'];
    if (v !== null && typeof v !== 'string') return { ok: false, error: 'phone must be a string or null' };
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (trimmed === '') {
      patch.phone = null; // clear it
    } else if (trimmed.length > 32) {
      return { ok: false, error: 'phone must be at most 32 characters' };
    } else if (!/^\+?[0-9()\-\s.]{2,}$/.test(trimmed)) {
      // digits, optional leading +, and ( ) - . space separators only
      return { ok: false, error: 'phone contains invalid characters (digits with optional + ( ) - . space)' };
    } else {
      patch.phone = trimmed;
    }
  }

  // Nothing valid to update (e.g. body was {}).
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No permitted fields provided. Permitted: full_name, phone' };
  }

  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// ENTRYPOINT — routing, CORS, auth
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight (browsers send OPTIONS first).
  const preflight = OPTIONS(req);
  if (preflight) return preflight;

  // Only GET and PATCH are supported here.
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return methodNotAllowed(['GET', 'PATCH', 'OPTIONS']);
  }

  // Read + decode the JWT from the Authorization header.
  // Throws AuthError when the header is missing or the JWT is malformed.
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

  // Build a Supabase client as THIS user (anon key + their JWT).
  // SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically by Supabase.
  const supabase = createClientForUser(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, jwt);

  try {
    if (req.method === 'GET') return await handleGet(supabase, userId);
    return await handlePatch(req, supabase, userId);
  } catch (err) {
    console.error('[labour-profile] unhandled error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
