import type { DeductionType } from '@/types'

/**
 * The "Redo att begäras" tile on /invoices/rot-rut.
 *
 * An invoice is ready when it is paid and complete for its kind's begäran
 * file, and it leaves the list the moment that file is generated (the
 * begäran row holds it). ROT and RUT go in a HUS file, grön teknik in its own
 * Begaran file (gron-teknik-file.ts); all three are counted the same way.
 */
export interface ReadyTile {
  /** Invoices ready for a begäran file, every kind. */
  ready: number
  /** The kinds with at least one ready invoice, in order. */
  parts: Array<{ kind: DeductionType; count: number }>
}

export function readyTileOf(counts: Record<DeductionType, number>): ReadyTile {
  const parts = (['rot', 'rut', 'gron_teknik'] as const)
    .map((kind) => ({ kind, count: counts[kind] }))
    .filter((part) => part.count > 0)
  return { ready: parts.reduce((sum, part) => sum + part.count, 0), parts }
}
