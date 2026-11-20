/**
 * The company's skattekonto account for a template, read only when the
 * template names the skattekonto (1630): the ledger's answer to the bank
 * side's categorize and bulk-book doors (PH 175).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingTemplateLibraryLine } from '@/types'
import { getTemplateById, templateSkattekontoAccountFor } from '../booking-templates'
import { libraryLinesForCompanySkattekonto } from '../template-library'

function client(account: string | null, error: { message: string; code?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: account, error }))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

const line = (account: string, side: 'debit' | 'credit'): BookingTemplateLibraryLine =>
  ({ account, label: account, side, type: 'business', ratio: 1 }) as BookingTemplateLibraryLine

describe('templateSkattekontoAccountFor', () => {
  it('reads the company\'s account for a template that names 1630', async () => {
    const { supabase, rpc } = client('2012')
    await expect(templateSkattekontoAccountFor(supabase, 'company-1', getTemplateById('financial_tax_account')!)).resolves.toBe('2012')
    expect(rpc).toHaveBeenCalledWith('company_skattekonto_account', { p_company_id: 'company-1' })
  })

  it('reads nothing for a template that does not', async () => {
    const { supabase, rpc } = client('2012')
    const template = { debit_account: '6110', credit_account: '1930', debit_account_ab: undefined, credit_account_ab: undefined }
    await expect(templateSkattekontoAccountFor(supabase, 'company-1', template)).resolves.toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('throws when the account cannot be read', async () => {
    const { supabase } = client(null, { message: 'boom' })
    await expect(templateSkattekontoAccountFor(supabase, 'company-1', getTemplateById('financial_tax_account')!)).rejects.toThrow(
      'Kunde inte läsa skattekontots konto: boom',
    )
  })
})

describe('libraryLinesForCompanySkattekonto', () => {
  it('books the lines\' 1630 on the company\'s account', async () => {
    const { supabase, rpc } = client('2012')
    const lines = [line('1630', 'debit'), line('1930', 'credit')]
    const out = await libraryLinesForCompanySkattekonto(supabase, 'company-1', lines)
    expect(out.map((l) => l.account)).toEqual(['2012', '1930'])
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('hands back lines without the skattekonto as they are, without a read', async () => {
    const { supabase, rpc } = client('2012')
    const lines = [line('6110', 'debit'), line('1930', 'credit')]
    await expect(libraryLinesForCompanySkattekonto(supabase, 'company-1', lines)).resolves.toBe(lines)
    expect(rpc).not.toHaveBeenCalled()
  })
})
