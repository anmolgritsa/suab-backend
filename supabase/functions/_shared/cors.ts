/**
 * Shared CORS helpers for Suab edge functions.
 *
 * Edge functions run on Deno; keep anything reused across functions here and
 * re-export it from `mod.ts`.
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
} as const;

/** Build a JSON response with CORS headers attached. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

/** Handle an OPTIONS preflight request. Returns null when not a preflight. */
export function OPTIONS(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response('ok', { headers: corsHeaders });
}

/** 405 response listing the methods the function accepts. */
export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: `Method not allowed. Allowed: ${allowed.join(', ')}` }, 405);
}
