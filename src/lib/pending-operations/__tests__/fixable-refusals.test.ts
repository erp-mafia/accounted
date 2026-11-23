import { describe, it, expect } from 'vitest'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { FIXABLE_REFUSALS, fixableRefusalFor } from '../fixable-refusals'

describe('fixable refusals', () => {
  it('lists registered codes only', () => {
    for (const code of Object.keys(FIXABLE_REFUSALS)) expect(hasErrorEntry(code), code).toBe(true)
  })

  it('is fixable only for the operation types named for the code', () => {
    expect(fixableRefusalFor('create_voucher', 'VOUCHER_NEEDS_CONFIRMATION')).not.toBeNull()
    expect(fixableRefusalFor('correct_entry', 'VOUCHER_NEEDS_CONFIRMATION')).toBeNull()
    expect(fixableRefusalFor('submit_agi', 'SKATTEVERKET_NOT_CONNECTED')?.fixHref).toBe('/settings/skatteverket')
    expect(fixableRefusalFor('mark_invoice_sent', 'INVOICE_NUMBER_SERIES_BEHIND')?.fixHref).toBe('/settings/invoicing')
    // Written to before the refusal: never kept.
    expect(fixableRefusalFor('send_invoice', 'INVOICE_NUMBER_SERIES_BEHIND')).toBeNull()
    expect(fixableRefusalFor('convert_to_invoice', 'INVOICE_NUMBER_SERIES_BEHIND')).toBeNull()
    expect(fixableRefusalFor('send_invoice', 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')).not.toBeNull()
    expect(fixableRefusalFor('send_invoice', 'INVOICE_SEND_VAT_NUMBER_MISSING')?.fixHref).toBe('/settings/tax')
    // Another SIE import in the way: the job RPC rolled back, the proposal
    // waits, and the link opens the import history.
    expect(fixableRefusalFor('import_sie', 'SIE_IMPORT_UNFINISHED')?.fixHref).toBe('/import?history=sie')
    expect(fixableRefusalFor('create_voucher', 'SIE_IMPORT_UNFINISHED')).toBeNull()
    // A staged bank row on a turned-off invoice payee: refused before the
    // account or the row is written, and an owner or admin turns it on in the
    // bookkeeping settings.
    expect(fixableRefusalFor('create_transaction', 'CASH_ACCOUNT_DISABLED_PAYEE')?.fixHref).toBe('/settings/bookkeeping')
    expect(fixableRefusalFor('categorize_transaction', 'CASH_ACCOUNT_DISABLED_PAYEE')).toBeNull()
  })

  it('is null for an unlisted code, no code, and an inherited property name', () => {
    expect(fixableRefusalFor('create_voucher', 'INBOX_ITEM_ALREADY_BOOKED')).toBeNull()
    expect(fixableRefusalFor('create_voucher', undefined)).toBeNull()
    expect(fixableRefusalFor('create_voucher', null)).toBeNull()
    expect(fixableRefusalFor('create_voucher', 'constructor')).toBeNull()
  })
})
