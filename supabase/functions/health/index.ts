// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: health
// Simple status endpoint — verifies the function runtime, CORS handling and
// shared utilities are wired up correctly. No business logic.

import { json, methodNotAllowed, OPTIONS } from '../_shared/mod.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  const preflight = OPTIONS(req);
  if (preflight) return preflight;

  if (req.method !== 'GET') {
    return methodNotAllowed(['GET', 'OPTIONS']);
  }

  const body = {
    status: 'ok',
    service: 'suab-backend',
    function: 'health',
    timestamp: new Date().toISOString(),
  };

  return json(body, 200);
}) as any;
