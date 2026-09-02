import { z } from 'zod'

// Commit-boundary re-validation for the staged set_voucher_note operation
// (gnubok_set_voucher_note). Notes are annotation metadata alongside the
// verifikat, not räkenskapsinformation: the journal_entries immutability
// trigger (migration 20260608120000) allows a notes-only UPDATE on committed
// entries and rejects anything that touches a bookkeeping field, so this
// schema only has to bound the shape. Max length matches the dashboard
// PATCH route (app/api/bookkeeping/journal-entries/[id]/notes/route.ts).

export const SetVoucherNoteParamsSchema = z.object({
  journal_entry_id: z.string().uuid(),
  // null clears the note; empty/whitespace-only strings are normalised to
  // null so the column never stores visually-empty annotations.
  notes: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(2000).nullable(),
  ),
})
