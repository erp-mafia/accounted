import { describe, expect, it } from 'vitest'
import { CASH_ACCOUNT_ARCHIVABLE_REMOVAL_CODES } from '@/lib/cash-accounts/archive-codes'
import { CASH_ACCOUNT_REMOVAL_CODES, CASH_ACCOUNT_ARCHIVE_CODES } from '@/lib/cash-accounts/manage'
import { hasErrorEntry } from '@/lib/errors/structured-errors'

/**
 * PH 222: the dialog offers archiving exactly for the removal refusals
 * archive_cash_account accepts (rows that must stay), never for a connected
 * or primary account, whose way out is to disconnect or make another primary.
 */
describe('archivable removal refusals', () => {
  it('are the refusals where the rows must stay', () => {
    expect([...CASH_ACCOUNT_ARCHIVABLE_REMOVAL_CODES].sort()).toEqual(
      [
        CASH_ACCOUNT_REMOVAL_CODES.booked,
        CASH_ACCOUNT_REMOVAL_CODES.ignored,
        CASH_ACCOUNT_REMOVAL_CODES.match_history,
        CASH_ACCOUNT_REMOVAL_CODES.in_use,
        CASH_ACCOUNT_REMOVAL_CODES.ledger_history,
      ].sort(),
    )
    expect(CASH_ACCOUNT_ARCHIVABLE_REMOVAL_CODES).not.toContain(CASH_ACCOUNT_REMOVAL_CODES.primary)
    expect(CASH_ACCOUNT_ARCHIVABLE_REMOVAL_CODES).not.toContain(CASH_ACCOUNT_REMOVAL_CODES.bank_connected)
  })

  it('every archive refusal maps to a registered error', () => {
    for (const code of Object.values(CASH_ACCOUNT_ARCHIVE_CODES)) expect(hasErrorEntry(code)).toBe(true)
  })
})
