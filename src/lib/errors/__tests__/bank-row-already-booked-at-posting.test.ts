/**
 * #205: guard_bank_row_single_booking refuses a verifikat whose bank row
 * another posted verifikat already books, raised by name with PT409
 * (20261113133511). Every booking door posts through the engine, which wraps
 * the refusal in a BookkeepingDatabaseError; the person must read what was
 * refused, not the generic "reload the page" conflict.
 */
import { describe, expect, it } from 'vitest'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { conflictCode, getErrorEntry } from '@/lib/errors/structured-errors'

const SV =
  'Transaktionen är redan bokförd på en annan verifikation, så ingenting bokfördes. Ladda om sidan. Står transaktionen ändå kvar som obokförd är verifikationen bokförd från den men aldrig kopplad till den: koppla den under Avstämning, Matcha manuellt, eller återför den (storno).'

describe('BANK_ROW_ALREADY_BOOKED, the refusal where the verifikat is posted', () => {
  it('is a registered database conflict: its own code, a 409', () => {
    expect(conflictCode('BANK_ROW_ALREADY_BOOKED')).toBe('BANK_ROW_ALREADY_BOOKED')
    expect(getErrorEntry('BANK_ROW_ALREADY_BOOKED')).toMatchObject({ httpStatus: 409, message_sv: SV })
  })

  it('reaches the person through the engine\'s commit error in Swedish and English', () => {
    const err = new BookkeepingDatabaseError('commit_entry', 'BANK_ROW_ALREADY_BOOKED', 'PT409')
    expect(err.code).toBe('BANK_ROW_ALREADY_BOOKED')
    expect(getStructuredError(err).code).toBe('BANK_ROW_ALREADY_BOOKED')
    expect(getErrorMessage(err, { context: 'transaction' })).toBe(SV)
    expect(getErrorMessage(err, { context: 'transaction', locale: 'en' })).toContain(
      'The bank transaction is already booked on another voucher, so nothing was booked.',
    )
  })

  it('reads the same from the raw database error a direct RPC answers with', () => {
    const raw = { code: 'PT409', message: 'BANK_ROW_ALREADY_BOOKED', details: '{"transaction_id":"t","journal_entry_id":"j"}', hint: null }
    expect(getStructuredError(raw).code).toBe('BANK_ROW_ALREADY_BOOKED')
    expect(getErrorMessage(raw)).toBe(SV)
  })
})
