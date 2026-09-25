/**
 * Moved to src/lib/skatteverket/skattekonto-match.ts: it reads core tables
 * (skattekonto_transactions, journal entries) and needs no Skatteverket API,
 * so core routes must be able to use it. Core may never import from
 * @/extensions/. This re-export keeps the extension's imports and tests
 * unchanged.
 */
export * from '@/lib/skatteverket/skattekonto-match'
