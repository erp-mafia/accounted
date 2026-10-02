import type { HusDeductionType } from './rot-rut-rules'

/**
 * The "Redo att begäras" tile on /invoices/rot-rut.
 *
 * ROT and RUT invoices are ready: paid and complete, and each one leaves the
 * list the moment its begäran file is generated (the begäran row holds it).
 * Grön teknik is never counted as ready. Its payout is requested in
 * Skatteverkets e-tjänst for grön teknik, which writes nothing back here, so
 * an invoice requested and paid through the e-tjänst would read "ready"
 * forever and invite a second, incorrect claim. The tile shows grön teknik
 * apart instead: paid invoices whose request window (31 January after the
 * payment year) is still open, without claiming that they are unrequested.
 * When the Begaran GRON_TEKNIK file records begäran rows, grön teknik can
 * join the ready count like ROT and RUT.
 */
export interface ReadyTile {
  /** ROT + RUT invoices ready for a begäran file. */
  ready: number
  /** The ROT/RUT kinds with at least one ready invoice, in order. */
  parts: Array<{ kind: HusDeductionType; count: number }>
  /** Paid grön teknik invoices still inside their request window. */
  gronTeknikOpen: number
}

export function readyTileOf(counts: {
  rot: number
  rut: number
  gronTeknikOpen: number
}): ReadyTile {
  const parts = (['rot', 'rut'] as const)
    .map((kind) => ({ kind, count: counts[kind] }))
    .filter((part) => part.count > 0)
  return { ready: counts.rot + counts.rut, parts, gronTeknikOpen: counts.gronTeknikOpen }
}
