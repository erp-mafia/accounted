/**
 * Moved to src/lib/skatteverket/skattekonto-buckets.ts.
 *
 * The bucketing operates on skattekonto_transactions, a core table that a
 * file import fills without any Skatteverket connection, so core routes must
 * be able to read it: core may never import from @/extensions/. The
 * implementation lives in src/lib/; this re-export keeps the extension's own
 * imports and tests unchanged. The re-import direction (extension -> lib) is
 * the allowed one.
 */
export * from '@/lib/skatteverket/skattekonto-buckets'
