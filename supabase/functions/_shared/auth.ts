/**
 * Shared auth helpers for Suab edge functions.
 *
 * PATTERN: public anon key + the caller's user JWT. RLS in the database is
 * the real security boundary. NEVER use the service-role key in a
 * user-facing function — it bypasses RLS.
 */

// Full URL import (not the bare "@supabase/supabase-js" specifier) — the
// Supabase cloud bundler does not read supabase/functions/deno.json, so bare
// specifiers fail at deploy time.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Thrown when the Authorization header is missing or the JWT is malformed. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The user info we need from the JWT: user id + the raw token. */
export interface AuthContext {
  userId: string; // the JWT "sub" claim = auth.users.id
  jwt: string; // raw token, forwarded to Supabase
}

/**
 * Read the Authorization header of an incoming request and decode the JWT.
 * Accepts "Bearer <jwt>" or a bare "<jwt>".
 * Throws AuthError when the header is missing or the JWT is malformed.
 *
 * NOTE: we only decode the payload, we do not verify the signature here —
 * signature verification happens in the database/PostgREST when the token is
 * used. That is enough to know which user is calling.
 */
export function contextFromRequest(req: Request): AuthContext {
  const raw = (req.headers.get('Authorization') ?? '').trim();
  const jwt = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;

  if (!jwt) {
    throw new AuthError('Missing Authorization header (expected: Bearer <supabase-jwt>)');
  }

  // A JWT looks like: header.payload.signature (3 parts, base64url encoded).
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new AuthError('Malformed JWT: expected three dot-separated segments');
  }

  // Decode the middle part (payload) from base64url to JSON.
  let claims: Record<string, unknown>;
  try {
    const b64 = (parts[1] as string).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new AuthError('Malformed JWT: payload is not valid JSON');
  }

  // "sub" is the Supabase user id — this is what RLS uses as auth.uid().
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AuthError('Malformed JWT: missing `sub` claim');
  }

  return { userId: sub, jwt };
}

/**
 * Create a Supabase client that acts as THIS user (anon key + their JWT).
 * Every query runs through RLS, so users can only touch their own rows.
 */
export function createClientForUser(supabaseUrl: string, anonKey: string, jwt: string): SupabaseClient {
  if (!supabaseUrl) throw new AuthError('supabaseUrl is required');
  if (!anonKey) throw new AuthError('anonKey is required (never the service-role key)');
  if (!jwt) throw new AuthError('user JWT is required');

  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}`, apikey: anonKey } },
  });
}
