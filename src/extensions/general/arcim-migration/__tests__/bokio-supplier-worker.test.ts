import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'
import { enrichBokioSupplierInvoice } from '@/lib/providers/bokio/supplier-evidence'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), hydrate: vi.fn(), refresh: vi.fn(), link: vi.fn(), list: vi.fn() }))
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: mocks.rows }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({ hydrateSupplierInvoices: mocks.hydrate, fetchSupplierInvoicesDirect: mocks.list }))
vi.mock('../lib/refresh-migrated-payment-state', () => ({ refreshMigratedSupplierPaymentState: mocks.refresh }))
vi.mock('@/lib/invoices/link-migrated-registration-vouchers', () => ({ linkMigratedRegistrationVouchers: mocks.link }))
vi.mock('@/lib/documents/voucher-ref-resolver', () => ({
  fetchVouchersForNumbers: vi.fn().mockResolvedValue([]), fetchFiscalPeriods: vi.fn().mockResolvedValue([]),
  buildVoucherIndex: vi.fn(), resolveDatedRef: vi.fn().mockReturnValue('local-entry'),
}))
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { completeBokioSupplierInvoices, runBokioSupplierCompletion, type BokioSupplierSnapshot } from '../lib/complete-bokio-supplier-invoices'

function snapshot() {
  const dto = mapBokioToSupplierInvoice({ id: 'source', invoiceNumber: '1001', invoiceDate: '2026-01-02', currency: 'SEK',
    totalAmount: 1250, remainingAmount: 1250, supplierRef: { id: 'source-party', name: 'Supplier' },
    journalEntryRef: { id: 'source-entry' }, lineItems: [{ quantity: 1, unitPrice: 1000, taxRate: null }] })
  const hydrated = enrichBokioSupplierInvoice(dto, { id: 'source-entry', series: 'V', number: 7, date: '2026-01-02',
    reversingJournalEntryId: null, reversedByJournalEntryId: null, items: [
      { account: '4000', debit: 1000, credit: 0 }, { account: '2641', debit: 250, credit: 0 }, { account: '2440', debit: 0, credit: 1250 },
    ] })
  mocks.hydrate.mockResolvedValue({ invoices: [hydrated], unhydratedIds: new Set(), hydration: {} })
  return { connection: { accessToken: 'token', providerCompanyId: 'provider-company', consent: { provider: 'bokio' } }, invoices: [dto] } as BokioSupplierSnapshot
}
function database(progress: { invoice_id: string; next_attempt_at: string; outcome: string; created_at: string }[] = []) {
  const row = { id: 'invoice', user_id: 'user', supplier_id: 'supplier', supplier_invoice_number: '1001', invoice_date: '2026-01-02',
    total: 1250, total_sek: 1250, subtotal: 1250, vat_amount: 0, currency: 'SEK', is_credit_note: false,
    status: 'registered', paid_at: null, created_at: '2026-01-03', updated_at: '2026-01-03', document_id: null,
    registration_journal_entry_id: null, payment_journal_entry_id: null, supplier_invoice_items: [] }
  mocks.rows.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ id: 'supplier', name: 'Supplier' }])
    .mockResolvedValueOnce([]).mockResolvedValueOnce(progress).mockResolvedValueOnce([row])
  const rpc = vi.fn(async (name: string) => ({ data: name === 'claim_bokio_supplier_completion'
    ? { claimed: true } : { outcome: 'completed', changed: true, rows: 1 }, error: null }))
  return { rpc, supabase: { rpc } as unknown as SupabaseClient }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows.mockReset()
  mocks.refresh.mockResolvedValue({ updated: 0 }); mocks.link.mockResolvedValue({ linked: 1 })
})

describe('Bokio completion orchestration', () => {
  it('previews with one shared provider snapshot and no enrollment', async () => {
    const db = database(); const source = snapshot()
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent', snapshot: source })
    expect(result).toMatchObject({ dryRun: true, attempted: 1, changed: 1, rows: 1, pending: 0 })
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ snapshot: source, eligibleInvoiceIds: new Set(['invoice']), dryRun: true }))
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('complete_bokio_supplier_invoice', expect.objectContaining({
      p_dry_run: true, p_plan: expect.objectContaining({ voucher_id: 'local-entry', header: { subtotal: 1000, vat_amount: 250 } }),
    }))
    expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })
  it('does no work when another run owns the lease', async () => {
    const db = database(); db.rpc.mockResolvedValue({ data: { claimed: false }, error: null } as never)
    expect(await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent', snapshot: snapshot(), dryRun: false }))
      .toMatchObject({ busy: true, attempted: 0 })
    expect(mocks.rows).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it('reads the atomic receipt after an uncertain write and releases the lease', async () => {
    const db = database(); let attempts = 0
    db.rpc.mockImplementation(async (name: string) => {
      if (name === 'claim_bokio_supplier_completion') return { data: { claimed: true }, error: null }
      if (++attempts === 1) throw new Error('lost response')
      return { data: { outcome: 'completed', changed: true, rows: 1 }, error: null }
    })
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent', snapshot: snapshot(), dryRun: false, start: true })
    expect(result).toMatchObject({ changed: 1, attempted: 1, pending: 0 })
    expect(db.rpc).toHaveBeenLastCalledWith('claim_bokio_supplier_completion', expect.objectContaining({ p_release: true }))
    expect(mocks.link).not.toHaveBeenCalled()
  })
  it('does not derive a split from a voucher claimed by another source invoice outside the batch', async () => {
    const db = database(); const source = snapshot()
    source.invoices.push({ ...source.invoices[0], id: 'other-source', invoiceNumber: 'other-number' })
    await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent', snapshot: source })
    const args = (db.rpc.mock.calls[0] as unknown as [string, { p_plan: Record<string, unknown> }])[1]
    expect(args.p_plan.voucher_id).toBeUndefined(); expect(args.p_plan.header).toBeUndefined()
    expect(mocks.link).not.toHaveBeenCalled()
  })
  it('defers an exhausted deadline before any query or provider request', async () => {
    const db = database()
    expect(await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent', deadline: Date.now() - 1 }))
      .toMatchObject({ partial: true, attempted: 0 })
    expect(db.rpc).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled()
  })
})

describe('Bokio completion end condition (unattended pass)', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
  const tried = (outcome: string, created: string, next: string) => ({ invoice_id: 'invoice', outcome, created_at: created, next_attempt_at: next })

  it('retires an invoice tried for a week and says the company has no work left', async () => {
    const db = database([tried('unmatched_or_ambiguous', daysAgo(30), daysAgo(1))])
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent',
      snapshot: snapshot(), dryRun: false, retireAfterDays: 7 })
    expect(result).toMatchObject({ attempted: 0, retired: 1, pending: 0, nextAttemptAt: 'infinity' })
    expect(db.rpc).not.toHaveBeenCalledWith('complete_bokio_supplier_invoice', expect.anything())
  })
  it('keeps a short deferral open and names when it is due', async () => {
    const next = new Date(Date.now() + 10 * 60_000).toISOString()
    const db = database([tried('provider_evidence_deferred', daysAgo(30), next)])
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent',
      snapshot: snapshot(), dryRun: false, retireAfterDays: 7 })
    expect(result).toMatchObject({ attempted: 0, retired: 0, nextAttemptAt: next })
  })
  it('still tries an invoice first tried within the week', async () => {
    const db = database([tried('unmatched_or_ambiguous', daysAgo(3), daysAgo(0.01))])
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent',
      snapshot: snapshot(), dryRun: false, retireAfterDays: 7 })
    expect(result).toMatchObject({ attempted: 1, retired: 0, nextAttemptAt: null })
  })
  it('retries everything when a person asks (no retirement outside the cron)', async () => {
    const db = database([tried('unmatched_or_ambiguous', daysAgo(30), daysAgo(1))])
    const result = await completeBokioSupplierInvoices({ supabase: db.supabase, companyId: 'company', consentId: 'consent',
      snapshot: snapshot(), dryRun: false, start: true })
    expect(result).toMatchObject({ attempted: 1, retired: 0, nextAttemptAt: null })
  })
  it('parks a company with nothing left after the release, and only while no run holds it', async () => {
    database([tried('unmatched_or_ambiguous', daysAgo(30), daysAgo(1))])
    const source = snapshot()
    vi.mocked(resolveConsent).mockResolvedValue(source.connection)
    mocks.list.mockResolvedValue(source.invoices)
    const update = vi.fn(); const is = vi.fn()
    const builder = (result: unknown) => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'not', 'lte', 'order', 'limit', 'eq', 'abortSignal']) chain[method] = () => chain
      chain.update = (values: unknown) => { update(values); return chain }
      chain.is = (column: string, value: unknown) => { is(column, value); return chain }
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
      return chain
    }
    const from = vi.fn()
      .mockReturnValueOnce(builder({ data: [{ company_id: 'company', consent_id: 'consent' }], error: null }))
      .mockReturnValueOnce(builder({ error: null }))
    const rpc = vi.fn(async () => ({ data: { claimed: true }, error: null }))
    const results = await runBokioSupplierCompletion({ rpc, from } as unknown as SupabaseClient, Date.now() + 60_000)
    expect(results).toHaveLength(1)
    expect(rpc).toHaveBeenLastCalledWith('claim_bokio_supplier_completion', expect.objectContaining({ p_release: true }))
    expect(update).toHaveBeenCalledWith({ next_attempt_at: 'infinity' })
    expect(is).toHaveBeenCalledWith('run_id', null)
  })
})
