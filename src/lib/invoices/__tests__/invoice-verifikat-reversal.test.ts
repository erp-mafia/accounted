/**
 * A storno of a customer invoice's verifikat: refused before the storno once
 * the invoice is sent or paid (Kreditera is the way), and once it is credited
 * or written off (its sale is out of the ledger already: Ångra kreditering or
 * the storno of the kundförlust verifikat undoes that); a verifikat whose
 * invoice is a draft or cancelled, or that no invoice points at, passes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { IssuedInvoiceStornoError, WithdrawnInvoiceStornoError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { assertInvoiceVerifikatReversible } from '../invoice-verifikat-reversal'

const COMPANY = 'company-1'

function invoice(status: string, overrides: Record<string, unknown> = {}) {
  return { id: 'inv-1', company_id: COMPANY, journal_entry_id: 'je-sale', status, ...overrides }
}

beforeEach(() => vi.clearAllMocks())

describe('assertInvoiceVerifikatReversible', () => {
  it.each(['sent', 'overdue', 'partially_paid', 'paid'])('refuses the verifikat of a %s invoice', async (status) => {
    const { supabase } = createRowsMockSupabase({ invoices: [invoice(status)] })
    const refusal = assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')
    await expect(refusal).rejects.toBeInstanceOf(IssuedInvoiceStornoError)
    await expect(refusal).rejects.toMatchObject({ code: 'INVOICE_STORNO_ISSUED', invoiceId: 'inv-1' })
  })

  it.each(['credited', 'written_off'])('refuses the verifikat of a %s invoice: the sale is out of the ledger already', async (status) => {
    const { supabase } = createRowsMockSupabase({ invoices: [invoice(status)] })
    const refusal = assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')
    await expect(refusal).rejects.toBeInstanceOf(WithdrawnInvoiceStornoError)
    await expect(refusal).rejects.toMatchObject({ code: 'INVOICE_STORNO_WITHDRAWN', invoiceId: 'inv-1', invoiceStatus: status })
  })

  it.each(['draft', 'cancelled'])('lets the verifikat of a %s invoice through', async (status) => {
    const { supabase } = createRowsMockSupabase({ invoices: [invoice(status)] })
    await expect(assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')).resolves.toBeUndefined()
  })

  it('lets a verifikat no invoice points at through (a Bokför orphan that lost its link race)', async () => {
    const { supabase } = createRowsMockSupabase({ invoices: [invoice('sent', { journal_entry_id: 'je-other' })] })
    await expect(assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')).resolves.toBeUndefined()
  })

  it('reads only the invoice that points at the verifikat: a credited invoice holds no other verifikat', async () => {
    // Ångra kreditering reverses the credit note's own verifikat (source_type
    // credit_note: this hook never runs on it). A credited invoice refuses
    // the storno of its own verifikat, never of another one.
    const { supabase } = createRowsMockSupabase({
      invoices: [invoice('credited'), invoice('draft', { id: 'inv-2', journal_entry_id: 'je-draft' })],
    })
    await expect(assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-draft')).resolves.toBeUndefined()
  })

  it('reads company-scoped, by the invoice pointer', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ invoices: [] })
    await assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')
    expect(findCalls('invoices', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['journal_entry_id', 'je-sale'],
    ])
  })

  it('throws on a failed read: unknown is never reversible', async () => {
    const { supabase } = createTableMockSupabase({ invoices: { data: null, error: { message: 'boom' } } })
    await expect(assertInvoiceVerifikatReversible(supabase as never, COMPANY, 'je-sale')).rejects.toThrow(/lookup by voucher failed/)
  })

  it('names Kreditera in the Swedish refusal and Credit in the English one', () => {
    const refusal = new IssuedInvoiceStornoError('inv-1')
    expect(getErrorMessage(refusal)).toMatch(/Kreditera fakturan i stället/)
    expect(getErrorMessage(refusal, { locale: 'en' })).toMatch(/Credit the invoice instead/)
  })

  it('names what undoes a credit or a kundförlust, never Kreditera, in Swedish and in English', () => {
    const refusal = new WithdrawnInvoiceStornoError('inv-1', 'credited')
    const sv = getErrorMessage(refusal)
    expect(sv).toMatch(/redan krediterad eller avskriven som kundförlust/)
    expect(sv).toMatch(/Ångra kreditering på fakturan/)
    expect(sv).toMatch(/kundförlustens verifikation återförs/)
    expect(sv).not.toMatch(/Kreditera /)
    const en = getErrorMessage(refusal, { locale: 'en' })
    expect(en).toMatch(/already credited or written off/)
    expect(en).toMatch(/Undo credit/)
    expect(en).toMatch(/reversing its customer loss voucher/)
  })
})
