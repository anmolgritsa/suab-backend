/**
 * Suab — shared auth utilities (TypeScript, runtime-agnostic: Node or Deno).
 *
 * AUTH PATTERN — anon key + user JWT only:
 *   - SUPABASE_ANON_KEY is a public identifier; the database is protected by
 *     Row Level Security, so holding it grants access to nothing by itself.
 *   - The end-user's JWT (from Supabase Auth) is forwarded on every request in
 *     the `Authorization: Bearer <jwt>` header. PostgREST then evaluates all
 *     RLS policies as the `authenticated` role with `auth.uid()` bound to the
 *     JWT's `sub` claim.
 *   - SUPABASE_SERVICE_ROLE_KEY bypasses RLS entirely. It must NEVER appear in
 *     frontend-facing code or in this module — only in trusted server
 *     environments (edge functions with secrets, admin jobs). See .env.example.
 *
 * A Deno-specific twin of this module lives at
 * `supabase/functions/_shared/auth.ts` for edge-function imports.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** A Supabase client typed against the Suab database. */
export type SuabClient = SupabaseClient<Database>;

/** Minimal shape of a decoded Supabase Auth JWT context. */
export interface AuthUserContext {
  /** auth.users.id — the JWT `sub` claim. */
  userId: string;
  /** auth.users.email, when present in the token. */
  email: string | null;
  /** Raw JWT (base64 segments), pass as `Authorization: Bearer <jwt>`. */
  jwt: string;
}

/** Result of resolving the caller's labour profile. */
export interface LabourProfileResult {
  profile: Tables<'labour_profiles'> | null;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Client factory (anon key + user JWT)
// ---------------------------------------------------------------------------
/**
 * Create a Supabase client bound to the caller's JWT (anon key + user JWT).
 *
 * All queries through this client are evaluated by RLS as the `authenticated`
 * role — the database enforces company isolation, not this code.
 *
 * @param supabaseUrl Project URL, e.g. https://<ref>.supabase.co
 * @param anonKey     Public anon key (SUPABASE_ANON_KEY) — never the service key.
 * @param jwt         The end-user's Supabase Auth JWT.
 */
export function createClientForUser(supabaseUrl: string, anonKey: string, jwt: string): SuabClient {
  if (!supabaseUrl) throw new Error('createClientForUser: supabaseUrl is required');
  if (!anonKey) throw new Error('createClientForUser: anonKey is required (never pass the service-role key here)');
  if (!jwt) throw new Error('createClientForUser: user JWT is required');

  return createClient<Database>(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: anonKey,
      },
    },
  });
}

/**
 * Build an AuthUserContext from an incoming request's Authorization header.
 * Accepts `Bearer <jwt>` or a bare JWT string.
 */
export function contextFromAuthorizationHeader(header: string | null | undefined): AuthUserContext {
  const raw = (header ?? '').trim();
  const jwt = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;

  if (!jwt) {
    throw new AuthError('Missing Authorization header (expected: Bearer <supabase-jwt>)');
  }

  return decodeJwtContext(jwt);
}

// ---------------------------------------------------------------------------
// JWT decoding
// ---------------------------------------------------------------------------
/** Error thrown when authentication context is missing or malformed. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Decode a Supabase Auth JWT payload without verification (signature
 * verification is performed by the platform: PostgREST validates it, and edge
 * functions can call `supabase.auth.getUser(jwt)` when they need certainty).
 */
export function decodeJwtContext(jwt: string): AuthUserContext {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new AuthError('Malformed JWT: expected three dot-separated segments');
  }

  const payloadB64 = parts[1] as string;
  const json = base64UrlDecode(payloadB64);
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new AuthError('Malformed JWT: payload is not valid JSON');
  }

  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AuthError('Malformed JWT: missing `sub` claim');
  }

  const email = claims['email'];
  return {
    userId: sub,
    email: typeof email === 'string' ? email : null,
    jwt,
  };
}

/** Decode a base64url string to UTF-8 text (Node and Deno compatible). */
function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  if (typeof atob === 'function') {
    // Deno / browsers
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // Node.js
  return Buffer.from(padded, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// Labour profile resolution
// ---------------------------------------------------------------------------
/**
 * Resolve the caller's labour profile via RLS.
 *
 * The SELECT is filtered by the `labour_profiles_select_own` policy, so a
 * worker can only ever fetch their own profile — cross-company or other
 * workers' profiles return null, not an error.
 */
export async function getCurrentLabourProfile(client: SuabClient): Promise<LabourProfileResult> {
  const { data, error } = await client
    .from('labour_profiles')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) {
    return { profile: null, error: new Error(`getCurrentLabourProfile: ${error.message}`) };
  }

  return { profile: data, error: null };
}

/**
 * Resolve the caller's labour profile scoped to a specific company.
 * Returns null when the caller has no profile in that company.
 */
export async function getLabourProfileForCompany(
  client: SuabClient,
  companyId: string,
): Promise<LabourProfileResult> {
  const { data, error } = await client
    .from('labour_profiles')
    .select('*')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();

  if (error) {
    return { profile: null, error: new Error(`getLabourProfileForCompany: ${error.message}`) };
  }

  return { profile: data, error: null };
}

// ---------------------------------------------------------------------------
// Authorization assertions
// ---------------------------------------------------------------------------
/** Thrown by assert* helpers when an authorization requirement fails. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Roles that may manage other workers and company configuration. */
export const PRIVILEGED_ROLES = ['owner', 'admin', 'manager', 'supervisor'] as const;

/** True when the given role string is privileged (case-insensitive). */
export function isPrivilegedRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return (PRIVILEGED_ROLES as readonly string[]).includes(role.toLowerCase());
}

/**
 * Assert the caller has a labour profile in the given company.
 * Throws AuthorizationError when not a member (or profile fetch failed).
 */
export async function assertCompanyMembership(
  client: SuabClient,
  companyId: string,
): Promise<Tables<'labour_profiles'>> {
  const { profile, error } = await getLabourProfileForCompany(client, companyId);

  if (error) throw error;
  if (!profile) {
    throw new AuthorizationError(
      `Caller has no labour profile in company ${companyId} — membership denied`,
    );
  }

  return profile;
}

/**
 * Assert the caller's role in the company is privileged.
 * Throws AuthorizationError for non-members or non-privileged roles.
 */
export async function assertPrivilegedRole(
  client: SuabClient,
  companyId: string,
): Promise<Tables<'labour_profiles'>> {
  const profile = await assertCompanyMembership(client, companyId);

  if (!isPrivilegedRole(profile.role)) {
    throw new AuthorizationError(
      `Role '${profile.role ?? 'none'}' is not privileged for company ${companyId}`,
    );
  }

  return profile;
}

/**
 * Assert the caller's own profile id matches the target (own-record access).
 * Throws AuthorizationError on mismatch.
 */
export function assertOwnProfile(
  profile: Tables<'labour_profiles'>,
  targetProfileId: string,
): void {
  if (profile.id !== targetProfileId) {
    throw new AuthorizationError(
      `Profile ${targetProfileId} does not belong to the caller (own profile: ${profile.id})`,
    );
  }
}
