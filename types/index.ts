/**
 * Suab — database types.
 *
 * The real `Database` type is generated from the linked Supabase project:
 *
 *   npx supabase gen types typescript --remote --schema public > types/database.generated.ts
 *
 * This module re-exports it so application code can do:
 *
 *   import type { Database, Tables, TablesInsert, TablesUpdate } from '../types/index.js';
 *
 * Re-run the command above whenever migrations change the schema.
 */

export * from './database.generated.js';
