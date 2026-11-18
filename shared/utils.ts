/**
 * Suab — shared TypeScript utilities.
 * Currently a placeholder; add cross-project helpers here.
 */

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
