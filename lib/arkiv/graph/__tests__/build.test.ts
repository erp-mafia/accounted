import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildCompanyGraph } from '../build'

const mock = createQueuedMockSupabase()
const { enqueue, reset } = mock
const supabase = mock.supabase as unknown as SupabaseClient
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TODAY = '2026-10-01'

/** The reads buildCompanyGraph makes, in order. Defaults answer "nothing" so a test fills only what it needs. */
function enqueueAll(input: Partial<Record<'company' | 'accounts' | 'lines' | 'parties' | 'customers' | 'suppliers' | 'invoices' | 'supplierInvoices' | 'agreements' | 'obligations' | 'transactions' | 'facts' | 'documents' | 'links' | 'employees' | 'deadlines' | 'expected', unknown>>) {
  enqueue({ data: input.company ?? { name: 'Exempelbolaget AB' } })
  for (const key of ['accounts', 'lines', 'parties', 'customers', 'suppliers', 'invoices', 'supplierInvoices', 'agreements', 'obligations', 'transactions', 'facts', 'documents', 'links', 'employees', 'deadlines', 'expected'] as const) enqueue({ data: input[key] ?? [] })
}

const line = (account_number: string, entry_date: string, journal_entry_id: string, debit = 0, credit = 0, source_type = 'manual', source_id: string | null = null) => ({ account_number, entry_date, journal_entry_id, debit_amount: debit, credit_amount: credit, journal_entries: { entry_date, status: 'posted', source_type, source_id, company_id: CO } })

beforeEach(() => reset())

describe('buildCompanyGraph', () => {
  it('draws accounts with movement, counterparties from what invoices booked, and folds the rest', async () => {
    enqueueAll({
      accounts: [{ account_number: '3010', account_name: 'Konsultintäkter' }, { account_number: '1930', account_name: 'Företagskonto' }],
      lines: [line('3010', '2026-09-15', 'je-1', 0, 60000, 'invoice_created', 'inv-1'), line('1930', '2026-09-15', 'je-1', 60000, 0, 'invoice_created', 'inv-1'), line('5010', '2026-08-25', 'je-2', 12500)],
      parties: [{ id: 'p-1', display_name: 'Startplattan AB', kind: 'company' }, { id: 'p-2', display_name: 'Quiet AB', kind: 'company' }],
      customers: [{ id: 'c-1', party_id: 'p-1' }],
      invoices: [{ id: 'inv-1', customer_id: 'c-1' }],
      documents: [{ id: 'd-1', file_name: 'kvitto.pdf', doc_type: 'receipt', created_at: '2026-08-25', journal_entry_id: 'je-2' }, { id: 'd-2', file_name: 'kvitto2.pdf', doc_type: 'receipt', created_at: '2026-08-26', journal_entry_id: null }],
    })
    const g = await buildCompanyGraph(supabase, CO, TODAY)
    const refs = g.nodes.map((n) => n.ref)
    expect(refs).toEqual(expect.arrayContaining(['account:3010', 'account:1930', 'account:5010', 'party:p-1', 'parties:others', 'documents:receipts_invoices', 'authority:skatteverket', 'authority:bolagsverket']))
    expect(refs).not.toContain('party:p-2')
    expect(g.nodes.find((n) => n.ref === 'account:3010')?.label).toBe('3010 Konsultintäkter')
    expect(g.nodes.find((n) => n.ref === 'documents:receipts_invoices')?.meta).toMatchObject({ count: 2 })
    expect(g.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'party:p-1', target: 'account:3010', kind: 'posting', evidence: expect.objectContaining({ amount: 60000, entries: 1 }) }),
        expect.objectContaining({ source: 'documents:receipts_invoices', target: 'account:5010', kind: 'posting', evidence: expect.objectContaining({ amount: 12500, documents: 1 }) }),
      ]),
    )
    expect(g.series['account:3010'][g.months.indexOf('2026-09')]).toBe(60000)
    expect(g.clusters.find((c) => c.id === 'ledger')?.count).toBe(3)
    expect(g.truncated).toBe(false)
  })

  it('ties an agreement to its counterparty, its source, the accounts that paid it, and what it produces next', async () => {
    enqueueAll({
      lines: [line('2350', '2026-09-30', 'je-9', 10417), line('8410', '2026-09-30', 'je-9', 4625), line('1930', '2026-09-30', 'je-9', 0, 15042)],
      parties: [{ id: 'p-almi', display_name: 'Almi Stockholm AB', kind: 'company' }],
      agreements: [{ id: 'a-1', title: 'Låneavtal Almi', kind: 'loan', status: 'active', ends_on: '2031-01-31', amount: null, period: null, principal: 500000, counterparty_party_id: 'p-almi', counterparty_name: 'Almi', source_document_id: 'd-lan' }],
      obligations: [
        { id: 'o-1', agreement_id: 'a-1', kind: 'amortisation', due_on: '2026-09-30', amount: 10417, status: 'matched', transaction_id: 't-1', direction: 'out' },
        { id: 'o-2', agreement_id: 'a-1', kind: 'amortisation', due_on: '2026-10-31', amount: 10417, status: 'expected', transaction_id: null, direction: 'out' },
      ],
      transactions: [{ id: 't-1', journal_entry_id: 'je-9' }],
      facts: [{ id: 'f-1', predicate: 'org_number', value_text: '5595386219', valid_from: '2026-03-04', source_document_id: 'd-reg' }],
      documents: [
        { id: 'd-lan', file_name: 'Skuldebrev.pdf', doc_type: 'agreement.loan', created_at: '2026-01-10', journal_entry_id: null },
        { id: 'd-reg', file_name: 'Registreringsbevis.pdf', doc_type: 'registration.bolagsverket', created_at: '2026-03-04', journal_entry_id: null },
      ],
      employees: [{ id: 'e-1', first_name: 'Markus', last_name: 'H', employment_type: 'employee', employment_end: null }],
      deadlines: [{ id: 'dl-1', title: 'Momsdeklaration', due_date: '2026-11-12', deadline_type: 'vat_return', status: 'upcoming' }],
      expected: [{ id: 'x-1', detail: { rule: 'rent', expected_type: 'agreement.rental', evidence: { accounts: ['5010'] } } }],
    })
    const g = await buildCompanyGraph(supabase, CO, TODAY)
    const has = (source: string, target: string, kind: string) => g.links.some((l) => l.source === source && l.target === target && l.kind === kind)
    expect(has('agreement:a-1', 'party:p-almi', 'party')).toBe(true)
    expect(has('agreement:a-1', 'document:d-lan', 'source')).toBe(true)
    expect(has('agreement:a-1', 'account:2350', 'matched')).toBe(true)
    expect(has('agreement:a-1', 'account:8410', 'matched')).toBe(true)
    expect(has('agreement:a-1', 'obligation:o-2', 'upcoming')).toBe(true)
    expect(g.nodes.some((n) => n.ref === 'obligation:o-1')).toBe(false)
    expect(has('fact:f-1', 'document:d-reg', 'source')).toBe(true)
    expect(has('authority:bolagsverket', 'fact:f-1', 'authority')).toBe(true)
    expect(has('authority:skatteverket', 'deadline:dl-1', 'authority')).toBe(true)
    expect(g.nodes.find((n) => n.ref === 'expected:x-1')?.meta).toMatchObject({ missing: true, rule: 'rent' })
    expect(g.nodes.some((n) => n.ref === 'person:e-1')).toBe(true)
    expect(g.nodes.filter((n) => n.cluster === 'document').map((n) => n.ref).sort()).toEqual(['document:d-lan', 'document:d-reg'])
  })

  it('surfaces a read error instead of drawing half a company', async () => {
    enqueue({ data: { name: 'X' } })
    enqueue({ data: null, error: { message: 'permission denied' } })
    for (let i = 0; i < 15; i++) enqueue({ data: [] })
    await expect(buildCompanyGraph(supabase, CO, TODAY)).rejects.toThrow(/graph read failed: permission denied/)
  })
})
