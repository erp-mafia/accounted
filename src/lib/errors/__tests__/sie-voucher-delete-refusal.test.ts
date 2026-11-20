/**
 * Deleting a verifikation that belongs to an SIE import (PH 212). The voucher
 * DELETE route hands the raw supabase-js error from delete_last_voucher to
 * getErrorMessage(); the toast on the voucher page shows the route's text.
 *   - an imported verifikation: retain_sie_batch_entry refuses (55000). The
 *     raw English used to reach the user; now the sentence names the undo.
 *   - a storno of an undone import: retain_sie_undo_reversal refuses
 *     (P0001), with a sentence that says why and what to do instead.
 */
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../get-error-message'

const BATCH_REFUSAL = {
  code: '55000',
  message: 'SIE batch entries cannot be deleted; use batch storno',
  details: null,
  hint: null,
}

const UNDONE_REFUSAL = {
  code: 'P0001',
  message: 'Voucher of an undone SIE import cannot be restored; its storno must stay',
  details: null,
  hint: null,
}

describe('getErrorMessage: deleting a verifikation of an SIE import', () => {
  it('names the whole-import undo for an imported verifikation, never the raw English', () => {
    const message = getErrorMessage(BATCH_REFUSAL, { context: 'journal_entry', statusCode: 400 })
    expect(message).toMatch(/^Verifikationen kommer från en SIE-import/)
    expect(message).toContain('Importhistorik')
    expect(message).not.toMatch(/batch|storno$/i)
    expect(message).not.toContain(BATCH_REFUSAL.message)
  })

  it('explains the refusal for a storno of an undone import and points at a new import', () => {
    const message = getErrorMessage(UNDONE_REFUSAL, { context: 'journal_entry', statusCode: 400 })
    expect(message).toMatch(/^Verifikationen makulerar en ångrad SIE-import/)
    expect(message).toContain('Importera/Exportera')
    expect(message).toContain('Gör om migrering')
    expect(message).not.toContain(UNDONE_REFUSAL.message)
  })

  it('keeps the route sentence when the voucher page maps the route body again', () => {
    const routeText = getErrorMessage(UNDONE_REFUSAL, { context: 'journal_entry', statusCode: 400 })
    expect(getErrorMessage({ error: routeText }, { context: 'journal_entry' })).toBe(routeText)
    const batchText = getErrorMessage(BATCH_REFUSAL, { context: 'journal_entry', statusCode: 400 })
    expect(getErrorMessage({ error: batchText }, { context: 'journal_entry' })).toBe(batchText)
  })

  it('leaves the other delete refusals as they were', () => {
    expect(getErrorMessage({ code: 'P0001', message: 'Cannot delete voucher in a locked fiscal period' }))
      .toBe('Verifikationen kan inte raderas: perioden är låst.')
  })
})
