import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
import { mapBokioToSalesInvoice, mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), page: vi.fn(), hydrate: vi.fn(), link: vi.fn(), reconcile: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: mocks.resolve }))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({ fetchMigrationPage: mocks.page, hydrateSalesInvoices: mocks.hydrate, hydrateSupplierInvoices: mocks.hydrate }))
vi.mock('@/lib/invoices/link-migrated-registration-vouchers', () => ({ linkMigratedRegistrationVouchers: mocks.link }))
vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({ reconcileSupplierInvoiceVouchers: mocks.reconcile }))
vi.mock('../entity-mapper', () => ({
  mapCustomer: (dto: { party: { name: string } }) => ({ name: dto.party.name }),
  mapSupplier: (dto: { party: { name: string } }) => ({ name: dto.party.name }),
  buildFxRateIndex: vi.fn().mockResolvedValue(new Map()),
  mapSalesInvoice: vi.fn(() => ({ invoice: { subtotal: 100, vat_amount: 25, total_sek: 125 }, items: [{ line_total: 100, vat_amount: 25 }] })),
  mapSupplierInvoice: vi.fn(() => ({ invoice: { subtotal: 100, vat_amount: 25, total_sek: 125 }, items: [{ line_total: 100, vat_amount: 25 }] })),
}))
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import { invoicePartySourceId, migrationRpc, pairMigratedCreditNotes, runProviderMigrationWorker, withinMigrationDeadline, type MigrationChunk } from '../migration-job-worker'

function database(overrides: Partial<ProviderMigrationJob> = {}) {
  const job = { id: 'job', company_id: 'company', user_id: 'user', consent_id: 'consent', provider: 'visma',
    resources: ['customers'], resource_index: 1, next_page: 1, phase: 'discover', state: 'queued',
    account_key: '5560000000', attempt: 0, failures: 0, fiscal_year_scope: null, ...overrides } as ProviderMigrationJob
  type Row = { id: string; resource: string; source_id: string; payload: string; state: string; target_id?: string; receipt?: unknown }
  const rows: Row[] = []
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_provider_migration_job') {
      if (job.state === 'completed' || job.state === 'needs_attention') return { data: null }
      Object.assign(job, { worker_id: args.p_worker_id, state: 'running', attempt: job.attempt + 1 })
      return { data: { ...job } }
    }
    if (name === 'save_provider_migration_page') {
      for (const r of args.p_records as Row[]) {
        if (!rows.some(row => row.source_id === r.source_id)) rows.push({ ...r, id: r.source_id, resource: args.p_resource as string, state: 'pending' })
      }
      if (args.p_next_page === null) job.phase = 'import'
      else if (args.p_next_page !== 0) job.next_page = args.p_next_page as number
    }
    if (name === 'commit_provider_migration_records') {
      for (const r of args.p_records as { id: string; error?: string }[]) rows.find(row => row.id === r.id)!.state = r.error ? 'needs_attention' : 'done'
    }
    if (name === 'advance_provider_migration_job') {
      job.phase = ({ import: 'link', link: 'reconcile', reconcile: 'settle', settle: 'completed' } as const)[job.phase as 'import' | 'link' | 'reconcile' | 'settle']
      if (job.phase === 'completed') job.state = rows.some(r => r.state === 'needs_attention') ? 'needs_attention' : 'completed'
    }
    if (name === 'release_provider_migration_job') {
      job.state = !args.p_error_code ? 'queued' : args.p_retry_seconds === -1 ? 'needs_attention' : 'retry_wait'
      job.error_code = args.p_error_code as string | null
    }
    return { data: null, error: null }
  })
  const supabase = { rpc, from: (table: string) => {
    let state: string | undefined; let limit = Infinity
    const filters: Record<string, unknown> = {}
    const chain = { select: () => chain, eq: (key: string, value: unknown) => {
      filters[key] = value; if (key === 'state') state = value as string; return chain
    },
      order: () => chain, limit: (value: number) => { limit = value; return chain }, single: () => chain, maybeSingle: () => chain,
      then: (resolve: (data: unknown) => void) => resolve({ data: table === 'migration_jobs'
        ? Object.entries(filters).every(([key, value]) => job[key as keyof ProviderMigrationJob] === value) ? { ...job } : null
        : rows.filter(r => r.state === state).slice(0, limit), error: null }) }
    return chain
  } } as unknown as SupabaseClient
  return { supabase, rpc, job, rows }
}
const customer = (id: number) => ({ id: `customer-${id}`, active: true, party: { name: `Customer ${id}` } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'provider-worker-unit-test-only')
  mocks.resolve.mockResolvedValue({ accessToken: 'token', consent: { provider: 'visma', org_number: '556000-0000' } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
describe('bounded durable worker', () => {
  it.each(['worker_id', 'attempt'] as const)('stops when the lease %s changes after a checkpoint', async token => {
    const db = database()
    const originalRpc = db.rpc.getMockImplementation()!
    db.rpc.mockImplementation(async (name, args) => {
      const result = await originalRpc(name, args)
      if (name === 'save_provider_migration_page') {
        if (token === 'worker_id') db.job.worker_id = 'replacement-worker'
        else db.job.attempt++
      }
      return result
    })
    mocks.page.mockResolvedValueOnce({ items: [customer(1)], nextPage: null, total: 1 })

    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })

    expect(db.rows.map(row => row.state)).toEqual(['pending'])
    expect(db.job.state).toBe('running')
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_provider_migration_job', 'save_provider_migration_page',
    ])
  })
  it.each(['salesInvoices', 'supplierInvoices'] as const)('isolates %s with inconsistent VAT rows before writing an invoice', async resource => {
    const db = database({ phase: 'import', resources: [resource] })
    const raw = { id: 'invoice', customerRef: { id: 'customer', name: 'Customer' },
      supplierRef: { id: 'supplier', name: 'Supplier' }, totalAmount: 125, totalTax: 25,
      lineItems: [{ description: 'Test', quantity: 1, unitPrice: 100, taxRate: 25 }] }
    const dto = resource === 'salesInvoices' ? mapBokioToSalesInvoice(raw) : mapBokioToSupplierInvoice(raw)
    const mapper = resource === 'salesInvoices' ? mapSalesInvoice : mapSupplierInvoice
    vi.mocked(mapper).mockReturnValueOnce({
      invoice: { subtotal: 100, vat_amount: 25, total_sek: 125 },
      items: [{ line_total: 100, vat_amount: 0 }],
      fxUnresolved: null, vatUnresolved: false, creditNoteUnlinked: false, creditedInvoiceRef: null,
    })
    db.rows.push({ id: dto.id, source_id: dto.id, resource, state: 'pending', ...sealMigrationPayload(dto) })
    mocks.hydrate.mockResolvedValueOnce({ invoices: [dto], unhydratedIds: new Set(), hydration: {} })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.rpc).toHaveBeenCalledWith('commit_provider_migration_records', expect.objectContaining({
      p_records: [{ id: dto.id, error: 'MIGRATION_ROWS_MISMATCH' }],
    }))
    expect(db.job.state).toBe('needs_attention')
  })
  it('keeps same-named Bokio customers and suppliers separate through their source references', () => {
    for (const id of ['party-a', 'party-b']) {
      expect(invoicePartySourceId('bokio', 'salesInvoices', mapBokioToSalesInvoice({
        id: 'invoice', customerRef: { id, name: 'Same name' },
      }))).toBe(id)
      expect(invoicePartySourceId('bokio', 'supplierInvoices', mapBokioToSupplierInvoice({
        id: 'invoice', supplierRef: { id, name: 'Same name' },
      }))).toBe(id)
    }
  })
  it('does not identify unknown invoice parties by their shared name', () => {
    const first = mapBokioToSalesInvoice({ id: 'invoice-a', customerRef: { name: 'Same name' } })
    const second = mapBokioToSalesInvoice({ id: 'invoice-b', customerRef: { name: 'Same name' } })
    const identity = invoicePartySourceId('bokio', 'salesInvoices', first)
    expect(identity).toBe(invoicePartySourceId('bokio', 'salesInvoices', first))
    expect(identity).not.toBe(invoicePartySourceId('bokio', 'salesInvoices', second))
  })
  it('pauses without persisting snapshots when the encryption key is missing', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', undefined)
    const db = database()
    mocks.page.mockResolvedValue({ items: [customer(1)], nextPage: null, total: 1 })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED' })
    expect(db.rows).toEqual([])
    expect(db.rpc.mock.calls.some(([name]) => name === 'save_provider_migration_page')).toBe(false)
  })
  it('resumes the saved page after a rate limit and commits a large register in bounded groups', async () => {
    const db = database()
    mocks.page.mockResolvedValueOnce({ items: Array.from({ length: 351 }, (_, i) => customer(i)), nextPage: 2, total: 352 })
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce({ items: [customer(351)], nextPage: null, total: 352 })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.job).toMatchObject({ state: 'retry_wait', next_page: 2, error_code: 'PROVIDER_RATE_LIMITED' })
    expect(db.rows).toHaveLength(351)
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(mocks.page.mock.calls.map(call => call[4])).toEqual([1, 2, 2])
    expect(db.job.state).toBe('completed')
    expect(db.rows.filter(r => r.state === 'done')).toHaveLength(352)
    const commits = db.rpc.mock.calls.filter(([name]) => name === 'commit_provider_migration_records')
    expect(commits.length).toBe(36)
    expect(commits.every(([, args]) => (args.p_records as unknown[]).length <= 10)).toBe(true)
    const segments = db.rpc.mock.calls.filter(([name]) => name === 'save_provider_migration_page')
    expect(segments.map(([, args]) => args.p_next_page)).toEqual([0, 2, null])
  })
  it('keeps prepared healthy records when the next invoice loses authorization', async () => {
    const db = database({ phase: 'import', resources: ['salesInvoices'] })
    const dto = (id: string) => ({ id, issueDate: '2026-01-01', currencyCode: 'SEK', _raw: { CustomerId: 'customer' },
      customer: { name: 'Customer', identifications: [] }, lines: [{}] })
    for (const id of ['a', 'b']) db.rows.push({ id, source_id: id, resource: 'salesInvoices', state: 'pending', ...sealMigrationPayload(dto(id)) })
    mocks.hydrate.mockResolvedValueOnce({ invoices: [dto('a')], unhydratedIds: new Set(), hydration: {} })
      .mockResolvedValueOnce({ invoices: [dto('b')], unhydratedIds: new Set(['b']), hydration: { abortedBy: 'auth' } })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.rows.map(r => r.state)).toEqual(['done', 'pending'])
    expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'PROVIDER_AUTH_EXPIRED' })
    expect(mocks.hydrate.mock.calls.every(call => call[3].length === 1)).toBe(true)
  })
  it('isolates an exhausted detail failure while continuing healthy invoices', async () => {
    const db = database({ phase: 'import', resources: ['salesInvoices'] })
    const dto = (id: string) => ({ id, issueDate: '2026-01-01', currencyCode: 'SEK', _raw: { CustomerId: 'customer' },
      customer: { name: 'Customer', identifications: [] }, lines: [{}] })
    for (const id of ['a', 'b']) db.rows.push({ id, source_id: id, resource: 'salesInvoices', state: 'pending', ...sealMigrationPayload(dto(id)) })
    mocks.hydrate.mockResolvedValueOnce({ invoices: [dto('a')], unhydratedIds: new Set(['a']), hydration: { abortedBy: 'budget' } })
      .mockResolvedValueOnce({ invoices: [dto('b')], unhydratedIds: new Set(), hydration: {} })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.rows.map(r => r.state)).toEqual(['needs_attention', 'done'])
    expect(db.job.state).toBe('needs_attention')
  })
  it('resumes a healthy detail when only the invocation time runs out', async () => {
    vi.useFakeTimers()
    const db = database({ phase: 'import', resources: ['salesInvoices'] })
    const dto = (id: string) => ({ id, issueDate: '2026-01-01', currencyCode: 'SEK', _raw: { CustomerId: 'customer' },
      customer: { name: 'Customer', identifications: [] }, lines: [{}] })
    for (const id of ['a', 'b']) db.rows.push({ id, source_id: id, resource: 'salesInvoices', state: 'pending', ...sealMigrationPayload(dto(id)) })
    mocks.hydrate.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 3000)
      return { invoices: [dto('a')], unhydratedIds: new Set(), hydration: {} }
    }).mockImplementationOnce(async (...args) => {
      expect(args[4]).toBe(2000)
      vi.setSystemTime(Date.now() + 2000)
      return { invoices: [dto('b')], unhydratedIds: new Set(['b']), hydration: { abortedBy: 'budget' } }
    })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id, budgetMs: 15000 })
    expect(db.rows.map(row => row.state)).toEqual(['done', 'pending'])
    expect(db.job.state).toBe('queued')
    expect(db.rpc).toHaveBeenCalledWith('release_provider_migration_job', expect.objectContaining({
      p_error_code: null, p_retry_seconds: 0,
    }))
    mocks.hydrate.mockResolvedValueOnce({ invoices: [dto('b')], unhydratedIds: new Set(), hydration: {} })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.job.state).toBe('completed')
  })
  it('yields a hung provider request at the worker deadline without advancing its cursor', async () => {
    vi.useFakeTimers()
    const db = database()
    mocks.page.mockReturnValue(new Promise(() => {}))
    const run = runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id, budgetMs: 20_000 })
    await vi.advanceTimersByTimeAsync(16_000)
    await run
    expect(db.job).toMatchObject({ state: 'queued', next_page: 1 })
    expect(db.rows).toHaveLength(0)
  })
  it('bounds reads as well as provider operations', async () => {
    vi.useFakeTimers()
    const promise = withinMigrationDeadline(new Promise(() => {}), Date.now() + 25)
    const assertion = expect(promise).rejects.toThrow('MIGRATION_DEADLINE')
    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })
  it.each(['claim', 'read', 'commit', 'release'])('returns within budget when the database hangs during %s', async (phase) => {
    vi.useFakeTimers()
    const db = database({ phase: phase === 'read' ? 'import' : 'discover' })
    mocks.page.mockResolvedValue({ items: [customer(1)], nextPage: null, total: 1 })
    const originalRpc = db.rpc.getMockImplementation()!
    db.rpc.mockImplementation((name, args) => {
      const hang = phase === 'claim' && name === 'claim_provider_migration_job'
        || phase === 'commit' && name === 'save_provider_migration_page'
        || phase === 'release' && name === 'release_provider_migration_job'
      return hang ? new Promise(() => {}) : originalRpc(name, args)
    })
    if (phase === 'read') vi.spyOn(db.supabase, 'from').mockImplementation(() => {
      const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        then: () => new Promise(() => {}) }
      return chain as unknown as ReturnType<SupabaseClient['from']>
    })
    if (phase === 'release') mocks.page.mockRejectedValue(new Error('provider unavailable'))
    let returned = false
    const run = runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id, budgetMs: 20_000 })
      .then(() => { returned = true })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(returned).toBe(true)
    await run
  })
  it('does not start a late write after a timed-out follow-up finishes', async () => {
    const db = database()
    await expect(migrationRpc(db.supabase, db.job, 'commit_provider_migration_followup', {}, Date.now() - 1))
      .rejects.toThrow('MIGRATION_DEADLINE')
    expect(db.rpc).not.toHaveBeenCalled()
  })
  it('aborts a stalled PostgREST request at the deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const query = Object.assign(new Promise(() => {}), { abortSignal: (value: AbortSignal) => { signal = value } })
    const assertion = expect(withinMigrationDeadline(query, Date.now() + 100)).rejects.toThrow('MIGRATION_DEADLINE')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(signal?.aborted).toBe(true)
  })
  it('isolates a 2001-line invoice and keeps the next healthy invoice', async () => {
    const db = database({ phase: 'import', resources: ['salesInvoices'] })
    for (const [id, lineCount] of [['huge', 2001], ['healthy', 3]] as const) {
      const dto = { id, issueDate: '2026-01-01', currencyCode: 'SEK', _raw: { CustomerId: 'customer' },
        customer: { name: 'Customer', identifications: [] }, lines: Array.from({ length: lineCount }, () => ({})) }
      db.rows.push({ id, source_id: id, resource: 'salesInvoices', state: 'pending', ...sealMigrationPayload(dto) })
      mocks.hydrate.mockResolvedValueOnce({ invoices: [dto], unhydratedIds: new Set(), hydration: {} })
    }
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.rows.map(row => row.state)).toEqual(['needs_attention', 'done'])
    expect(db.rpc.mock.calls.find(([name]) => name === 'commit_provider_migration_records')?.[1].p_records)
      .toEqual(expect.arrayContaining([{ id: 'huge', error: 'MIGRATION_INVOICE_TOO_LARGE' }]))
  })
})

it('pauses before any source fetch if reconnecting changed the provider account', async () => {
  const db = database()
  mocks.resolve.mockResolvedValue({ accessToken: 'token', consent: { provider: 'visma', org_number: '5569999999' } })
  await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
  expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'MIGRATION_SOURCE_IDENTITY_CHANGED' })
  expect(mocks.page).not.toHaveBeenCalled()
})

it('recognizes the consent resolver’s structured authorization errors', async () => {
  const db = database()
  mocks.resolve.mockRejectedValue({ status: 401, message: 'No tokens found' })
  await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
  expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'PROVIDER_AUTH_EXPIRED' })
  expect(mocks.page).not.toHaveBeenCalled()
})

/**
 * Credit-note pairing (crm#110). Chunks import in id order, so the invoice a
 * kreditfaktura credits may be inserted after it: the pairing runs in the
 * link phase, resolving the provider's reference through this job's chunks
 * first and the company's invoice numbers second, and pairs nothing it
 * cannot resolve unambiguously.
 */
describe('pairMigratedCreditNotes', () => {
  type Update = { table: string; payload: unknown; filters: unknown[][] }
  function pairingDb(answers: { chunkTarget?: string | null; invoicesByNumber?: { id: string }[] } = {}) {
    const updates: Update[] = []
    const reads: { table: string; filters: unknown[][] }[] = []
    const from = vi.fn((table: string) => {
      const filters: unknown[][] = []
      let payload: unknown
      const chain: Record<string, unknown> = {}
      for (const name of ['select', 'eq', 'neq', 'not', 'is', 'limit', 'order']) {
        chain[name] = (...args: unknown[]) => { filters.push([name, ...args]); return chain }
      }
      chain.maybeSingle = () => chain
      chain.update = (value: unknown) => { payload = value; return chain }
      chain.then = (resolve: (value: unknown) => void) => {
        if (payload !== undefined) { updates.push({ table, payload, filters }); return resolve({ data: null, error: null }) }
        reads.push({ table, filters })
        if (table === 'migration_job_chunks') return resolve({ data: answers.chunkTarget ? { target_id: answers.chunkTarget } : null, error: null })
        if (table === 'invoices') return resolve({ data: answers.invoicesByNumber ?? [], error: null })
        return resolve({ data: null, error: null })
      }
      return chain
    })
    return { supabase: { from } as unknown as SupabaseClient, updates, reads }
  }
  const job = { id: 'job', company_id: 'company' } as ProviderMigrationJob
  const chunk = (over: Partial<MigrationChunk>): MigrationChunk => ({
    id: 'chunk-cn', resource: 'salesInvoices', source_id: 'cn-src', payload: '', target_id: 'cn-row',
    receipt: { link: { kind: 'customer', sourceVoucher: null, invoiceDate: '2024-10-15', totalSek: -6375,
      creditedInvoiceRef: { id: 'inv-src', invoiceNumber: 'IN-2024-001' } } }, ...over,
  })
  const deadline = () => Date.now() + 5000

  it('resolves the credited invoice through the job\'s own chunks and pairs the rows', async () => {
    const db = pairingDb({ chunkTarget: 'inv-row' })
    await pairMigratedCreditNotes(db.supabase, job, [chunk({})], deadline())
    expect(db.updates).toEqual([{ table: 'invoices', payload: { credited_invoice_id: 'inv-row' }, filters: [
      ['eq', 'id', 'cn-row'], ['eq', 'company_id', 'company'], ['is', 'credited_invoice_id', null],
    ] }])
    expect(db.reads[0]).toMatchObject({ table: 'migration_job_chunks', filters: expect.arrayContaining([['eq', 'source_id', 'inv-src']]) })
  })

  it('falls back to the invoice number when the source id is unknown to this job', async () => {
    const db = pairingDb({ chunkTarget: null, invoicesByNumber: [{ id: 'inv-from-earlier-run' }] })
    await pairMigratedCreditNotes(db.supabase, job, [chunk({})], deadline())
    expect(db.updates.map(u => u.payload)).toEqual([{ credited_invoice_id: 'inv-from-earlier-run' }])
    expect(db.reads[1]).toMatchObject({ table: 'invoices', filters: expect.arrayContaining([
      ['eq', 'company_id', 'company'], ['eq', 'invoice_number', 'IN-2024-001'], ['neq', 'id', 'cn-row'],
    ]) })
  })

  it('pairs nothing when the number is ambiguous, when nothing matches, or when the row is not a referenced credit note', async () => {
    const ambiguous = pairingDb({ invoicesByNumber: [{ id: 'a' }, { id: 'b' }] })
    await pairMigratedCreditNotes(ambiguous.supabase, job, [chunk({})], deadline())
    expect(ambiguous.updates).toEqual([])

    const nothing = pairingDb({})
    await pairMigratedCreditNotes(nothing.supabase, job, [chunk({})], deadline())
    expect(nothing.updates).toEqual([])

    const untouched = pairingDb({ chunkTarget: 'inv-row' })
    await pairMigratedCreditNotes(untouched.supabase, job, [
      chunk({ resource: 'supplierInvoices' }),
      chunk({ receipt: { link: { kind: 'customer', sourceVoucher: null, invoiceDate: '2024-10-15', totalSek: 1250 } } }),
      chunk({ target_id: null }),
    ], deadline())
    expect(untouched.updates).toEqual([])
    expect(untouched.reads).toEqual([])
  })

  it('carries the provider\'s reference into the receipt and reports only a reference-less credit note as unlinked', async () => {
    const db = database({ phase: 'import', resources: ['salesInvoices'] })
    const raw = { id: 'cn-1', creditDate: '2024-10-15', invoiceRef: { id: 'inv-1', invoiceNumber: 'IN-2024-001' },
      customerRef: { id: 'customer', name: 'Customer' }, totalAmount: 125, totalTax: 25, status: 'published',
      lineItems: [{ description: 'Test', quantity: 1, unitPrice: 100, taxRate: 25 }] }
    const dto = mapBokioToSalesInvoice(raw)
    expect(dto.invoiceTypeCode).toBe('381')
    vi.mocked(mapSalesInvoice).mockReturnValueOnce({
      invoice: { subtotal: -100, vat_amount: -25, total_sek: -125 },
      items: [{ line_total: -100, vat_amount: -25 }],
      fxUnresolved: null, vatUnresolved: false, creditNoteUnlinked: true,
      creditedInvoiceRef: { id: 'inv-1', invoiceNumber: 'IN-2024-001' },
    })
    db.rows.push({ id: dto.id, source_id: dto.id, resource: 'salesInvoices', state: 'pending', ...sealMigrationPayload(dto) })
    mocks.hydrate.mockResolvedValueOnce({ invoices: [dto], unhydratedIds: new Set(), hydration: {} })
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id })
    expect(db.rpc).toHaveBeenCalledWith('commit_provider_migration_records', expect.objectContaining({
      p_records: [expect.objectContaining({
        id: 'cn-1',
        link: expect.objectContaining({ creditedInvoiceRef: { id: 'inv-1', invoiceNumber: 'IN-2024-001' } }),
        warnings: expect.objectContaining({ creditNoteUnlinked: false }),
      })],
    }))
  })
})
