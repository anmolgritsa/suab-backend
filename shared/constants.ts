/**
 * Suab — shared constants used across the backend
 * (Node-side scripts, generated types tooling, and as a reference for edge functions).
 *
 * Edge functions run on Deno and import from `supabase/functions/_shared/`;
 * keep anything that must be shared with Deno code in `_shared/` and re-export
 * pure constants from here if needed.
 */

export const APP_NAME = 'Suab' as const;

/** Default schema used by the Supabase client and generated types. */
export const DEFAULT_SCHEMA = 'public' as const;

/** Standard JSON content type for edge function responses. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8' as const;
