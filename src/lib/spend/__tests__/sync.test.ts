import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SpendAckResult, SpendExpense, SpendFile } from '@accounted/connect-contract'
import { DimensionValidationError } from '@/lib/bookkeeping/dimension-errors'
import { SPEND_CONNECT_PROTOCOL_ERROR, SPEND_CONNECT_UNREACHABLE } from '../connect-client'
import { buildSpendMasterData } from '../master-data'
import { loadBookableAccounts, reevaluateSpendItems, syncSpendConnection, type SpendSyncOptions } from '../sync'
import { createFakeDb, type FakeDb } from './fake-db'

const mocks = vi.hoisted(() => ({
  checkPeriodLock: vi.fn(),
  validateEntryDimensions: vi.fn(),
  safeFetch: vi.fn(),
  readBodyWithCap: vi.fn(),
  uploadDocument: vi.fn(),
  ackMax: { value: null as number | null },
}))

// A page holds at most 50 expenses and an acknowledgement takes 100, so the
// chunking only shows with a smaller limit.
vi.mock('@accounted/connect-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@accounted/connect-contract')>()
  return {
    ...actual,
    get SPEND_ACK_MAX() {
      return mocks.ackMax.value ?? actual.SPEND_ACK_MAX
    },
  }
})
vi.mock('@/lib/api/v1/check-period-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/check-period-lock')>()),
  checkPeriodLock: mocks.checkPeriodLock,
}))
vi.mock('@/lib/bookkeeping/dimension-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-resolver')>()),
  validateEntryDimensions: mocks.validateEntryDimensions,
}))
vi.mock('@/lib/http/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/safe-fetch')>()),
  safeFetch: mocks.safeFetch,
  readBodyWithCap: mocks.readBodyWithCap,
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: mocks.uploadDocument,
}))

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
const COMPANY = 'company-1'
const USER = 'user-1'
const HANDLE = 'spend_handle_abcdefghijklmnop'
const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const APP = 'https://app.accounted.se'
const NOW = new Date('2026-10-17T10:00:00Z')
const EPOCH = new Date(0).toISOString()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const PDF = Buffer.from('%PDF-1.4 kvitto 125 kr')
const PDF_SHA = createHash('sha256').update(PDF).digest('hex')

const sha = (char: string) => char.repeat(64)
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const CHART = [
  { company_id: COMPANY, account_number: '1930', account_name: 'Företagskonto', is_active: true, default_vat_treatment: null },
  { company_id: COMPANY, account_number: '1940', account_name: 'Övriga bankkonton', is_active: true, default_vat_treatment: null },
  { company_id: COMPANY, account_number: '1960', account_name: 'Gammalt kortkonto', is_active: false, default_vat_treatment: null },
  { company_id: COMPANY, account_number: '2820', account_name: 'Kortfristiga skulder till anställda', is_active: true, default_vat_treatment: null },
  { company_id: COMPANY, account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true, default_vat_treatment: 'standard_25' },
  { company_id: COMPANY, account_number: '6110', account_name: 'Kontorsmateriel', is_active: false, default_vat_treatment: 'standard_25' },
  { company_id: COMPANY, account_number: '6570', account_name: 'Bankkostnader', is_active: true, default_vat_treatment: 'exempt' },
]

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: COMPANY,
    provider: 'pleo',
    provider_name: 'Pleo',
    route: 'connect',
    mode: 'oauth',
    provider_company_ref: 'pleo-company-1',
    provider_company_name: 'Exempel AB',
    provider_org_number: '5566778899',
    status: 'active',
    health: 'ok',
    health_code: null,
    next_run_at: NOW.toISOString(),
    lease_until: EPOCH,
    last_success_at: '2026-10-16T09:00:00.000Z',
    last_error_code: null,
    last_error_at: null,
    failures_in_row: 0,
    master_data_sha256: null,
    master_data_sent_at: null,
    settings: {},
    created_by: USER,
    created_at: '2026-10-01T08:00:00.000Z',
    ended_by: null,
    ended_at: null,
    updated_at: '2026-10-01T08:00:00.000Z',
    connection_handle: HANDLE,
    pending_state_sha256: null,
    pending_expires_at: null,
    pending_return_origin: null,
    ...overrides,
  }
}

function seed(options: { connection?: Record<string, unknown>; items?: Array<Record<string, unknown>>; settings?: Record<string, unknown> } = {}): FakeDb {
  return createFakeDb({
    spend_connections: [connectionRow(options.connection)],
    spend_items: options.items ?? [],
    chart_of_accounts: CHART,
    company_settings: [{ company_id: COMPANY, vat_registered: true, dimensions_enabled: false, ...options.settings }],
  })
}

/** A card fee: no VAT, no receipt needed, ready as it is. */
function expense(id: string, overrides: Partial<SpendExpense> = {}): SpendExpense {
  return {
    externalId: id,
    batchRef: 'batch-1',
    kind: 'fee',
    subKind: null,
    date: '2026-10-15',
    currency: 'SEK',
    amount: 25,
    original: null,
    walletAccount: '1940',
    lines: [{ account: '6570', amount: 25, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null }, dimensions: {}, description: 'Kortavgift' }],
    merchant: null,
    person: null,
    note: null,
    attendees: [],
    reference: null,
    settles: [],
    files: [],
    providerUrl: null,
    issues: [],
    raw: { contentType: 'application/json', body: `{"id":"${id}"}`, sha256: sha('a') },
    ...overrides,
  }
}

function receipt(ref = 'file-1', overrides: Partial<SpendFile> = {}): SpendFile {
  return {
    fileRef: ref,
    name: 'kvitto.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    sha256: PDF_SHA,
    downloadUrl: `https://files.connect.example.se/f/${ref}`,
    downloadExpiresAt: '2026-10-17T10:15:00Z',
    ...overrides,
  }
}

/** A card purchase with Swedish VAT and its receipt: ready once the receipt is stored. */
function purchase(id: string, overrides: Partial<SpendExpense> = {}): SpendExpense {
  return expense(id, {
    kind: 'card_purchase',
    amount: 125,
    lines: [{ account: '5410', amount: 125, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 25 }, dimensions: {}, description: 'Tangentbord' }],
    merchant: { name: 'Kontorsbutiken AB', country: 'SE', taxId: null, categoryCode: null },
    person: { name: 'Anna Berg', ref: 'emp-1' },
    files: [receipt()],
    ...overrides,
  })
}

function storedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    company_id: COMPANY,
    connection_id: 'conn-1',
    provider: 'pleo',
    external_id: 'exp-1',
    kind: 'card_purchase',
    amount: 125,
    raw_body: 'original',
    raw_sha256: sha('a'),
    receive_count: 1,
    changed_after_booking: false,
    latest_raw_sha256: null,
    document_ids: [],
    ack_outcome: 'received',
    status: 'ready',
    journal_entry_id: null,
    ...overrides,
  }
}

type Answer = () => Response
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const page = (expenses: SpendExpense[], more = false): Answer => () => json({ expenses, more, serverTime: NOW.toISOString() })
const fail = (status: number, code: string, retryable: boolean, retryAfter?: string): Answer => () =>
  json({ error: 'x', code, retryable }, status, retryAfter ? { 'retry-after': retryAfter } : {})

/** A Connect stand-in for the spend routes a run calls; expense pages are answered in order. */
function connect(script: { masterData?: Answer; pages?: Answer[]; acknowledge?: (results: SpendAckResult[]) => Response } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const pages = [...(script.pages ?? [])]
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/connect/spend', '')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    calls.push({ path, body, headers: init.headers as Record<string, string> })
    if (path === '/master-data') return (script.masterData ?? (() => json({ accepted: true, state: 'pending' })))()
    if (path === '/expenses') return (pages.shift() ?? page([]))()
    if (path === '/acknowledge') {
      const results = body.results as SpendAckResult[]
      return script.acknowledge ? script.acknowledge(results) : json({ accepted: results.length, unknown: [] })
    }
    throw new Error(`unexpected Connect call ${path}`)
  })
  const of = (path: string) => calls.filter((call) => call.path === path)
  return { fetchImpl, calls, of, deps: { config: CONFIG, fetch: fetchImpl as unknown as typeof fetch } }
}

function run(client: FakeDb | SupabaseClient, c: ReturnType<typeof connect>, extra: Partial<SpendSyncOptions> = {}) {
  const admin = ('tables' in client ? client.client : client) as unknown as SupabaseClient
  return syncSpendConnection(admin, 'conn-1', { now: NOW, log: log as never, connect: c.deps, ...extra })
}

/** The fake client with one builder method of one table wrapped until `before` fires, to stage a race. */
function intercept(db: FakeDb, table: string, method: 'insert' | 'update', before: (value: Record<string, unknown>) => boolean): SupabaseClient {
  let fired = false
  return {
    from: (name: string) => {
      const builder = db.client.from(name) as Record<string, (value: Record<string, unknown>) => unknown>
      if (name !== table || fired) return builder
      const original = builder[method]
      builder[method] = (value) => {
        if (!fired && before(value)) fired = true
        return original(value)
      }
      return builder
    },
  } as unknown as SupabaseClient
}

/** The fake client with one table answering every read with a database error. */
function failingTable(db: FakeDb, table: string): SupabaseClient {
  const failing: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'neq', 'is', 'in', 'lt', 'lte', 'gte', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
    failing[method] = () => failing
  }
  failing.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })
  return { from: (name: string) => (name === table ? failing : db.client.from(name)) } as unknown as SupabaseClient
}

const byExternalId = (db: FakeDb) => Object.fromEntries(db.tables.spend_items.map((row) => [row.external_id as string, row]))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ackMax.value = null
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  mocks.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-2026' })
  mocks.validateEntryDimensions.mockResolvedValue(undefined)
  mocks.safeFetch.mockImplementation(async () => new Response(new Uint8Array(PDF)))
  mocks.readBodyWithCap.mockImplementation(async (res: Response) => Buffer.from(await res.arrayBuffer()))
  let next = 0
  mocks.uploadDocument.mockImplementation(async () => ({ id: `doc-${++next}` }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('syncSpendConnection: receiving expenses', () => {
  it('stores a new expense, archives its receipt, then answers it received with a link back', async () => {
    const db = seed()
    const c = connect({ pages: [page([purchase('exp-1')])] })
    const result = await run(db, c)

    expect(result).toEqual({ connectionId: 'conn-1', status: 'synced', received: 1, rejected: 0, deferred: 0, changedAfterBooking: 0, masterData: 'sent' })
    expect(db.tables.spend_items).toHaveLength(1)
    const [item] = db.tables.spend_items
    expect(item).toMatchObject({
      company_id: COMPANY,
      connection_id: 'conn-1',
      provider: 'pleo',
      external_id: 'exp-1',
      batch_ref: 'batch-1',
      kind: 'card_purchase',
      expense_date: '2026-10-15',
      currency: 'SEK',
      amount: 125,
      merchant_name: 'Kontorsbutiken AB',
      person_name: 'Anna Berg',
      status: 'ready',
      reasons: [],
      raw_body: '{"id":"exp-1"}',
      raw_content_type: 'application/json',
      raw_sha256: sha('a'),
      received_at: NOW.toISOString(),
      receive_count: 1,
      document_ids: ['doc-1'],
      ack_outcome: 'received',
      acknowledged_at: NOW.toISOString(),
    })
    // The model goes in without the provider's raw answer, which has its own columns.
    expect(item.expense).not.toHaveProperty('raw')
    expect(item.expense).toMatchObject({ externalId: 'exp-1', lines: purchase('exp-1').lines, files: [receipt()] })

    expect(mocks.uploadDocument).toHaveBeenCalledWith(
      db.client,
      USER,
      COMPANY,
      expect.objectContaining({ name: 'kvitto.pdf', type: 'application/pdf' }),
      { upload_source: 'api', idempotency_key: `spend:${item.id}:file-1`, extractionOwner: 'none' },
    )
    const [ack] = c.of('/acknowledge')
    expect(ack.headers['X-Connector-Connection']).toBe(HANDLE)
    expect(ack.body).toEqual({
      results: [{ externalId: 'exp-1', outcome: 'received', ledgerRef: item.id, ledgerUrl: `${APP}/kortkop?item=${item.id}` }],
    })
    // The receipt is archived before the provider is told: Connect drops its copy on the answer.
    const ackOrder = c.fetchImpl.mock.invocationCallOrder[c.calls.findIndex((call) => call.path === '/acknowledge')]
    expect(mocks.uploadDocument.mock.invocationCallOrder[0]).toBeLessThan(ackOrder)
    expect(c.of('/expenses')[0].body).toEqual({ limit: 50 })
  })

  it('answers an expense it cannot book rejected with the Swedish reason, and never downloads its receipt', async () => {
    const db = seed()
    const line = { account: '6110', amount: 125, vat: { code: 'SE25', type: 'standard' as const, rate: 0.25, amount: 25 }, dimensions: {}, description: null }
    const c = connect({ pages: [page([purchase('exp-1', { lines: [line] })])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ status: 'synced', received: 0, rejected: 1 })
    const [answer] = c.of('/acknowledge')[0].body.results as SpendAckResult[]
    expect(answer).toMatchObject({ externalId: 'exp-1', outcome: 'rejected', reasonCode: 'account_unknown' })
    expect(answer.outcome === 'rejected' && answer.reasonSv).toContain('Konto 6110 finns inte i Accounted')
    expect(db.tables.spend_items[0]).toMatchObject({
      status: 'rejected',
      reasons: [{ code: 'account_unknown', params: { account: '6110' } }],
      ack_outcome: 'rejected',
      acknowledged_at: NOW.toISOString(),
    })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })

  it('rejects a date in a locked period, lets a date without a fiscal year wait for a person, and reads each date once', async () => {
    mocks.checkPeriodLock.mockImplementation(async (_admin: unknown, _company: string, date: string) =>
      date === '2026-09-30' ? { locked: true, reason: 'period_is_closed', fiscal_period_id: 'fp-2025' } : { locked: false, reason: 'no_fiscal_period' },
    )
    const db = seed()
    const c = connect({ pages: [page([expense('exp-1', { date: '2026-09-30' }), expense('exp-2', { date: '2027-01-04' }), expense('exp-3', { date: '2027-01-04' })])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 2, rejected: 1 })
    const items = byExternalId(db)
    expect(items['exp-1']).toMatchObject({ status: 'rejected', reasons: [{ code: 'period_locked', params: { date: '2026-09-30' } }], ack_outcome: 'rejected' })
    expect(items['exp-2']).toMatchObject({ status: 'review', reasons: [{ code: 'no_fiscal_period', params: { date: '2027-01-04' } }], ack_outcome: 'received' })
    expect(mocks.checkPeriodLock).toHaveBeenCalledTimes(2)
  })

  it('updates a re-sent unbooked expense in place and stores its new receipt', async () => {
    const db = seed({ items: [storedItem({ status: 'rejected', ack_outcome: 'rejected', document_ids: ['doc-old'] })] })
    const resent = purchase('exp-1', { raw: { contentType: 'application/json', body: '{"id":"exp-1","v":2}', sha256: sha('b') } })
    const c = connect({ pages: [page([resent])] })
    await run(db, c)

    expect(db.inserts.filter((insert) => insert.table === 'spend_items')).toHaveLength(0)
    expect(db.tables.spend_items).toHaveLength(1)
    expect(db.tables.spend_items[0]).toMatchObject({
      id: 'item-1',
      status: 'ready',
      reasons: [],
      raw_body: '{"id":"exp-1","v":2}',
      raw_sha256: sha('b'),
      receive_count: 2,
      document_ids: ['doc-1'],
      ack_outcome: 'received',
    })
    expect((c.of('/acknowledge')[0].body.results as SpendAckResult[])[0]).toMatchObject({ outcome: 'received', ledgerRef: 'item-1' })
  })

  it('answers an unchanged re-send again without downloading its receipt twice', async () => {
    const db = seed({ items: [storedItem({ document_ids: ['doc-1'], ack_outcome: null })] })
    const c = connect({ pages: [page([purchase('exp-1')])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 1 })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
    expect(db.tables.spend_items[0]).toMatchObject({ document_ids: ['doc-1'], receive_count: 2, ack_outcome: 'received' })
  })

  it('never rewrites a booked expense: a different answer only flags it', async () => {
    const db = seed({ items: [storedItem({ journal_entry_id: 'je-1', status: 'booked' })] })
    const changed = purchase('exp-1', {
      amount: 999,
      lines: [{ account: '5410', amount: 999, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 199.8 }, dimensions: {}, description: null }],
      raw: { contentType: 'application/json', body: '{"id":"exp-1","amount":999}', sha256: sha('c') },
    })
    const c = connect({ pages: [page([changed])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 1, changedAfterBooking: 1 })
    expect(db.tables.spend_items[0]).toMatchObject({
      raw_body: 'original',
      raw_sha256: sha('a'),
      amount: 125,
      status: 'booked',
      receive_count: 1,
      changed_after_booking: true,
      latest_raw_sha256: sha('c'),
      latest_received_at: NOW.toISOString(),
    })
    expect((c.of('/acknowledge')[0].body.results as SpendAckResult[])[0]).toMatchObject({ outcome: 'received', ledgerRef: 'item-1' })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('leaves a booked expense unflagged when the provider sends the same answer again', async () => {
    const db = seed({ items: [storedItem({ journal_entry_id: 'je-1', status: 'booked' })] })
    const result = await run(db, connect({ pages: [page([purchase('exp-1')])] }))

    expect(result).toMatchObject({ received: 1, changedAfterBooking: 0 })
    expect(db.tables.spend_items[0]).toMatchObject({ changed_after_booking: false, latest_raw_sha256: null, latest_received_at: NOW.toISOString() })
  })

  it('stores over a concurrent run that inserted the expense first instead of duplicating it', async () => {
    const db = seed()
    const client = intercept(db, 'spend_items', 'insert', () => {
      db.tables.spend_items.push(storedItem({ id: 'item-other', ack_outcome: null }))
      return true
    })
    const c = connect({ pages: [page([purchase('exp-1')])] })
    const result = await run(client, c)

    expect(result).toMatchObject({ received: 1 })
    expect(db.tables.spend_items).toHaveLength(1)
    expect(db.tables.spend_items[0]).toMatchObject({ id: 'item-other', receive_count: 2, document_ids: ['doc-1'], ack_outcome: 'received' })
  })

  it('turns the answer into a flag when a booking claims the row between the read and the update', async () => {
    const db = seed({ items: [storedItem({ ack_outcome: null })] })
    const client = intercept(db, 'spend_items', 'update', (patch) => {
      if (!('kind' in patch)) return false
      db.tables.spend_items[0].journal_entry_id = 'je-1'
      return true
    })
    const resent = purchase('exp-1', { raw: { contentType: 'application/json', body: '{"v":2}', sha256: sha('b') } })
    const result = await run(client, connect({ pages: [page([resent])] }))

    expect(result).toMatchObject({ received: 1, changedAfterBooking: 1 })
    expect(db.tables.spend_items[0]).toMatchObject({ raw_sha256: sha('a'), changed_after_booking: true, latest_raw_sha256: sha('b') })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })
})

describe('syncSpendConnection: receipts', () => {
  it('leaves an expense unanswered while its receipt cannot be downloaded, and answers the rest of the page', async () => {
    mocks.safeFetch.mockImplementation(async (url: string) =>
      url.endsWith('/file-1') ? new Response('unavailable', { status: 503 }) : new Response(new Uint8Array(PDF)),
    )
    const db = seed()
    const c = connect({ pages: [page([purchase('exp-1'), purchase('exp-2', { files: [receipt('file-2')] })], true)] })
    const result = await run(db, c)

    expect(result).toMatchObject({ status: 'synced', received: 1, deferred: 1 })
    expect(c.of('/acknowledge')).toHaveLength(1)
    expect((c.of('/acknowledge')[0].body.results as SpendAckResult[]).map((r) => r.externalId)).toEqual(['exp-2'])
    const items = byExternalId(db)
    expect(items['exp-1'].ack_outcome ?? null).toBeNull()
    expect(items['exp-1']).toMatchObject({ status: 'ready' })
    expect(items['exp-2']).toMatchObject({ ack_outcome: 'received', document_ids: ['doc-1'] })
    // The page had more behind it and something was answered: the run reads on.
    expect(c.of('/expenses')).toHaveLength(2)
    expect(db.tables.spend_connections[0]).toMatchObject({ health: 'ok', failures_in_row: 0 })
  })

  it('stops paging when a page holds only expenses waiting for their receipts', async () => {
    mocks.safeFetch.mockRejectedValue(new Error('connect timeout'))
    const db = seed()
    const c = connect({ pages: [page([purchase('exp-1')], true), page([purchase('exp-2')])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 0, rejected: 0, deferred: 1 })
    expect(c.of('/expenses')).toHaveLength(1)
    expect(c.of('/acknowledge')).toHaveLength(0)
  })

  it('rejects an expense whose receipt can never be stored, and tells the provider why', async () => {
    const db = seed()
    const c = connect({ pages: [page([purchase('exp-1', { files: [receipt('file-1', { name: 'sida.html', contentType: 'text/html' })] })])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 0, rejected: 1, deferred: 0 })
    expect(c.of('/acknowledge')[0].body).toEqual({
      results: [
        {
          externalId: 'exp-1',
          outcome: 'rejected',
          reasonCode: 'receipt_unusable',
          reasonSv: 'Kvittot sida.html kan inte sparas i Accounted (filtypen tas inte emot). Ladda upp en PDF eller en bild under 10 MB och exportera igen.',
        },
      ],
    })
    expect(db.tables.spend_items[0]).toMatchObject({
      status: 'rejected',
      reasons: [{ code: 'receipt_unusable', params: { file: 'sida.html', reason: 'type_not_accepted' } }],
      ack_outcome: 'rejected',
    })
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('cannot keep a receipt without the person who connected, and says so instead of losing it', async () => {
    const db = seed({ connection: { created_by: null } })
    const c = connect({ pages: [page([purchase('exp-1'), expense('exp-2')])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ received: 1, rejected: 1 })
    const [first, second] = c.of('/acknowledge')[0].body.results as SpendAckResult[]
    expect(first).toMatchObject({ externalId: 'exp-1', outcome: 'rejected', reasonCode: 'internal_error' })
    expect(second).toMatchObject({ externalId: 'exp-2', outcome: 'received' })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
  })
})

describe('syncSpendConnection: the run', () => {
  it('holds the lease while it runs, releases it after, and polls again in five minutes', async () => {
    const db = seed()
    let leaseDuringRun: unknown = null
    const c = connect({
      pages: [
        () => {
          leaseDuringRun = db.tables.spend_connections[0].lease_until
          return page([])()
        },
      ],
    })
    await run(db, c)

    expect(leaseDuringRun).toBe(at(5 * MINUTE))
    expect(db.tables.spend_connections[0]).toMatchObject({
      lease_until: EPOCH,
      health: 'ok',
      health_code: null,
      failures_in_row: 0,
      last_success_at: NOW.toISOString(),
      next_run_at: at(5 * MINUTE),
    })
  })

  it('leaves a connection another run holds alone, and reports one that is not active as inactive', async () => {
    const c = connect()
    const leased = seed({ connection: { lease_until: at(MINUTE) } })
    expect(await run(leased, c)).toMatchObject({ status: 'locked', received: 0, masterData: 'unchanged' })
    expect(leased.tables.spend_connections[0].lease_until).toBe(at(MINUTE))

    expect((await run(seed({ connection: { status: 'disconnected' } }), c)).status).toBe('inactive')
    expect((await run(seed({ connection: { status: 'connecting' } }), c)).status).toBe('inactive')
    expect(c.fetchImpl).not.toHaveBeenCalled()
  })

  it('reads at most four pages a run and answers each page before reading the next', async () => {
    const db = seed()
    const c = connect({ pages: Array.from({ length: 6 }, (_, i) => page([expense(`exp-${i + 1}`)], true)) })
    const result = await run(db, c)

    expect(result.received).toBe(4)
    expect(c.calls.map((call) => call.path)).toEqual([
      '/master-data',
      '/expenses',
      '/acknowledge',
      '/expenses',
      '/acknowledge',
      '/expenses',
      '/acknowledge',
      '/expenses',
      '/acknowledge',
    ])
    expect(db.tables.spend_items.map((row) => row.external_id)).toEqual(['exp-1', 'exp-2', 'exp-3', 'exp-4'])

    const fewer = connect({ pages: Array.from({ length: 3 }, (_, i) => page([expense(`exp-${i + 10}`)], true)) })
    await run(seed(), fewer, { maxPages: 2 })
    expect(fewer.of('/expenses')).toHaveLength(2)
  })

  it('checks the deadline before each page, and releases the lease with what it answered', async () => {
    // One page can wait 65 s at Connect and a run is up to four: the cron's
    // budget was only checked between connections.
    const deadlineMs = Date.now() + 60_000
    const clock = vi.spyOn(Date, 'now')
    try {
      const db = seed()
      const c = connect({
        pages: [
          () => {
            // The first page used up the budget.
            clock.mockReturnValue(deadlineMs + 1)
            return page([expense('exp-1')], true)()
          },
          page([expense('exp-2')], true),
        ],
      })
      const result = await run(db, c, { deadlineMs })

      expect(result).toMatchObject({ status: 'synced', received: 1, stoppedEarly: true })
      expect(c.of('/expenses')).toHaveLength(1)
      expect(c.of('/acknowledge')).toHaveLength(1)
      expect(db.tables.spend_connections[0]).toMatchObject({
        lease_until: EPOCH,
        health: 'ok',
        failures_in_row: 0,
        last_success_at: NOW.toISOString(),
        next_run_at: at(5 * MINUTE),
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('a run the deadline stops before its first page only releases the lease: the health is not reset', async () => {
    const db = seed({
      connection: {
        health: 'action_required',
        health_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
        failures_in_row: 6,
        last_error_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
      },
    })
    const c = connect({ pages: [page([expense('exp-1')])] })
    const result = await run(db, c, { deadlineMs: Date.now() - 1 })

    expect(result).toMatchObject({ status: 'synced', received: 0, stoppedEarly: true })
    expect(c.of('/expenses')).toHaveLength(0)
    expect(db.tables.spend_items).toHaveLength(0)
    // Still waiting for a person, and no success was stamped.
    expect(db.tables.spend_connections[0]).toMatchObject({
      health: 'action_required',
      health_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
      failures_in_row: 6,
      last_success_at: '2026-10-16T09:00:00.000Z',
      lease_until: EPOCH,
      next_run_at: at(5 * MINUTE),
    })
  })

  it('acknowledges in chunks of SPEND_ACK_MAX and marks each expense with its own outcome', async () => {
    mocks.ackMax.value = 2
    const db = seed()
    const rejected = expense('exp-b', { lines: [{ account: '6110', amount: 25, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null }, dimensions: {}, description: null }] })
    const c = connect({ pages: [page([expense('exp-a'), rejected, expense('exp-c'), expense('exp-d'), expense('exp-e')])] })
    await run(db, c)

    expect(c.of('/acknowledge').map((call) => (call.body.results as SpendAckResult[]).map((r) => r.externalId))).toEqual([
      ['exp-a', 'exp-b'],
      ['exp-c', 'exp-d'],
      ['exp-e'],
    ])
    const items = byExternalId(db)
    expect(Object.fromEntries(Object.entries(items).map(([id, row]) => [id, row.ack_outcome]))).toEqual({
      'exp-a': 'received',
      'exp-b': 'rejected',
      'exp-c': 'received',
      'exp-d': 'received',
      'exp-e': 'received',
    })
  })

  it('logs the expenses Connect no longer holds when it acknowledges', async () => {
    const db = seed()
    const c = connect({ pages: [page([expense('exp-1')])], acknowledge: () => json({ accepted: 0, unknown: ['exp-1'] }) })
    await run(db, c)

    expect(log.warn).toHaveBeenCalledWith('spend acknowledgement named expenses Connect no longer holds', { connectionId: 'conn-1', unknown: 1 })
  })

  it('rejects a dimension value the registry does not know when dimensions are on, and checks only tagged lines', async () => {
    mocks.validateEntryDimensions.mockRejectedValue(
      new DimensionValidationError([{ sie_dim_no: '6', code: 'P99', reason: 'unknown_value', dimension_name: 'Projekt' }]),
    )
    const db = seed({ settings: { dimensions_enabled: true } })
    const tagged = expense('exp-1', { lines: [{ ...expense('exp-1').lines[0], dimensions: { '6': 'P99' } }] })
    await run(db, connect({ pages: [page([tagged, expense('exp-2')])] }))

    expect(mocks.validateEntryDimensions).toHaveBeenCalledTimes(1)
    const items = byExternalId(db)
    expect(items['exp-1']).toMatchObject({ status: 'rejected', reasons: [{ code: 'dimension_unknown', params: { dimension: 'Projekt', value: 'P99' } }] })
    expect(items['exp-2']).toMatchObject({ status: 'ready' })
  })

  it('passes dimension codes through as free text when dimensions are off', async () => {
    const db = seed()
    const tagged = expense('exp-1', { lines: [{ ...expense('exp-1').lines[0], dimensions: { '6': 'P99' } }] })
    await run(db, connect({ pages: [page([tagged])] }))

    expect(mocks.validateEntryDimensions).not.toHaveBeenCalled()
    expect(db.tables.spend_items[0]).toMatchObject({ status: 'ready' })
  })

  it('releases the lease when something other than Connect fails, and lets the error through', async () => {
    const db = seed()
    const c = connect()
    await expect(run(failingTable(db, 'chart_of_accounts'), c)).rejects.toThrow('canceling statement due to statement timeout')

    expect(db.tables.spend_connections[0]).toMatchObject({ lease_until: EPOCH, health: 'ok', failures_in_row: 0 })
    expect(c.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('syncSpendConnection: master data', () => {
  const company = { vatRegistered: true, dimensionsEnabled: false } as const

  it('sends the coding vocabulary on the first run and records what it sent', async () => {
    const db = seed()
    const c = connect()
    expect((await run(db, c)).masterData).toBe('sent')

    const { body, sha256 } = await buildSpendMasterData(db.client as unknown as SupabaseClient, COMPANY, company)
    const [sent] = c.of('/master-data')
    expect(sent.headers['X-Connector-Connection']).toBe(HANDLE)
    expect(sent.body).toEqual({ idempotencyKey: `conn-1:${sha256.slice(0, 40)}:2026-10-17`, ...body })
    // Only active accounts an expense can be coded on.
    expect((sent.body.accounts as Array<{ number: string }>).map((account) => account.number)).toEqual(['1930', '1940', '5410', '6570'])
    expect(db.tables.spend_connections[0]).toMatchObject({ master_data_sha256: sha256, master_data_sent_at: NOW.toISOString() })
  })

  it('keys the send on the Stockholm date, not the UTC one', async () => {
    // 22:30 UTC on 17 October is 00:30 on 18 October in Stockholm (CEST).
    const late = new Date('2026-10-17T22:30:00Z')
    const c = connect()
    await run(seed(), c, { now: late })
    expect(String(c.of('/master-data')[0].body.idempotencyKey)).toMatch(/^conn-1:[0-9a-f]{40}:2026-10-18$/)
  })

  it('skips an unchanged vocabulary within a day, and sends it again after 24 hours or when it changed', async () => {
    const { sha256 } = await buildSpendMasterData(seed().client as unknown as SupabaseClient, COMPANY, company)

    const recent = connect()
    expect((await run(seed({ connection: { master_data_sha256: sha256, master_data_sent_at: at(-HOUR) } }), recent)).masterData).toBe('unchanged')
    expect(recent.of('/master-data')).toHaveLength(0)

    const dayOld = connect()
    expect((await run(seed({ connection: { master_data_sha256: sha256, master_data_sent_at: at(-25 * HOUR) } }), dayOld)).masterData).toBe('sent')
    expect(dayOld.of('/master-data')).toHaveLength(1)

    const changed = connect()
    expect((await run(seed({ connection: { master_data_sha256: sha('f'), master_data_sent_at: at(-HOUR) } }), changed)).masterData).toBe('sent')
    expect(changed.of('/master-data')).toHaveLength(1)
  })

  it('goes on receiving when the vocabulary could not be sent, and sends it again next run', async () => {
    const db = seed()
    const c = connect({ masterData: fail(502, 'CONNECTOR_SPEND_PROVIDER_ERROR', true), pages: [page([expense('exp-1')])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ status: 'synced', masterData: 'failed', received: 1 })
    expect(db.tables.spend_connections[0]).toMatchObject({ master_data_sha256: null, health: 'ok' })
  })

  it('stops the run when the vocabulary send needs a person', async () => {
    const db = seed()
    const c = connect({ masterData: fail(401, 'CONNECTOR_SPEND_RECONNECT_REQUIRED', false), pages: [page([expense('exp-1')])] })
    const result = await run(db, c)

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_SPEND_RECONNECT_REQUIRED', retryable: false })
    expect(c.of('/expenses')).toHaveLength(0)
    expect(db.tables.spend_connections[0]).toMatchObject({ health: 'action_required', health_code: 'CONNECTOR_SPEND_RECONNECT_REQUIRED' })
  })
})

describe('syncSpendConnection: health', () => {
  const cases: Array<{ name: string; failures: number; answer: Answer; code: string; health: 'degraded' | 'action_required'; retryInMs: number }> = [
    { name: 'a transient provider error degrades and backs off five minutes', failures: 0, answer: fail(502, 'CONNECTOR_SPEND_PROVIDER_ERROR', true), code: 'CONNECTOR_SPEND_PROVIDER_ERROR', health: 'degraded', retryInMs: 5 * MINUTE },
    { name: 'the backoff doubles with each failure in a row', failures: 2, answer: fail(502, 'CONNECTOR_SPEND_PROVIDER_ERROR', true), code: 'CONNECTOR_SPEND_PROVIDER_ERROR', health: 'degraded', retryInMs: 20 * MINUTE },
    { name: 'the backoff stops growing at six hours', failures: 9, answer: fail(503, 'CONNECTOR_SPEND_PROVIDER_ERROR', true), code: 'CONNECTOR_SPEND_PROVIDER_ERROR', health: 'degraded', retryInMs: 6 * HOUR },
    { name: 'twelve transient failures in a row need a person', failures: 11, answer: fail(502, 'CONNECTOR_SPEND_PROVIDER_ERROR', true), code: 'CONNECTOR_SPEND_PROVIDER_ERROR', health: 'action_required', retryInMs: 6 * HOUR },
    { name: 'Connect out of reach degrades', failures: 0, answer: () => { throw new TypeError('fetch failed') }, code: SPEND_CONNECT_UNREACHABLE, health: 'degraded', retryInMs: 5 * MINUTE },
    { name: "the provider's rate limit waits out its Retry-After", failures: 0, answer: fail(429, 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', true, '1800'), code: 'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED', health: 'degraded', retryInMs: 30 * MINUTE },
    { name: 'a short Retry-After still waits five minutes', failures: 0, answer: fail(429, 'CONNECTOR_RATE_LIMITED', true, '30'), code: 'CONNECTOR_RATE_LIMITED', health: 'degraded', retryInMs: 5 * MINUTE },
    { name: 'a revoked grant needs a person and is tried again in six hours', failures: 0, answer: fail(401, 'CONNECTOR_SPEND_RECONNECT_REQUIRED', false), code: 'CONNECTOR_SPEND_RECONNECT_REQUIRED', health: 'action_required', retryInMs: 6 * HOUR },
    { name: 'a refusal that is not retryable needs a person', failures: 0, answer: fail(400, 'CONNECTOR_VALIDATION_FAILED', false), code: 'CONNECTOR_VALIDATION_FAILED', health: 'action_required', retryInMs: 6 * HOUR },
    { name: 'an answer that breaks the contract needs a person', failures: 0, answer: () => json({ expenses: 'none' }), code: SPEND_CONNECT_PROTOCOL_ERROR, health: 'action_required', retryInMs: 6 * HOUR },
  ]

  it.each(cases)('$name', async ({ failures, answer, code, health, retryInMs }) => {
    const db = seed({ connection: { failures_in_row: failures } })
    const result = await run(db, connect({ pages: [answer] }))

    expect(result).toMatchObject({ status: 'failed', errorCode: code })
    expect(db.tables.spend_connections[0]).toMatchObject({
      health,
      health_code: code,
      last_error_code: code,
      last_error_at: NOW.toISOString(),
      failures_in_row: failures + 1,
      next_run_at: at(retryInMs),
      lease_until: EPOCH,
      last_success_at: '2026-10-16T09:00:00.000Z',
    })
  })

  it('needs a person for a connection without a handle, without calling Connect', async () => {
    const db = seed({ connection: { connection_handle: null } })
    const c = connect()
    expect(await run(db, c)).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_CONNECTION_NOT_OWNED' })
    expect(c.fetchImpl).not.toHaveBeenCalled()
    expect(db.tables.spend_connections[0]).toMatchObject({ health: 'action_required', lease_until: EPOCH })
  })

  it('leaves expenses unanswered when the acknowledgement fails, for the next run to answer', async () => {
    const db = seed()
    const c = connect({ pages: [page([expense('exp-1')])], acknowledge: fail(502, 'CONNECTOR_SPEND_PROVIDER_ERROR', true) })
    const result = await run(db, c)

    expect(result).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_SPEND_PROVIDER_ERROR' })
    expect(db.tables.spend_items[0].ack_outcome ?? null).toBeNull()
    expect(db.tables.spend_connections[0]).toMatchObject({ health: 'degraded', failures_in_row: 1 })
  })

  it('clears the failure once a run works again, and keeps the last error for the trail', async () => {
    const db = seed({
      connection: {
        health: 'degraded',
        health_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
        failures_in_row: 3,
        last_error_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
        last_error_at: '2026-10-17T09:40:00.000Z',
      },
    })
    expect((await run(db, connect())).status).toBe('synced')
    expect(db.tables.spend_connections[0]).toMatchObject({
      health: 'ok',
      health_code: null,
      failures_in_row: 0,
      last_error_code: 'CONNECTOR_SPEND_PROVIDER_ERROR',
      last_error_at: '2026-10-17T09:40:00.000Z',
      last_success_at: NOW.toISOString(),
      next_run_at: at(5 * MINUTE),
    })
  })
})

describe('reevaluateSpendItems', () => {
  function model(id: string, overrides: Partial<SpendExpense> = {}) {
    const { raw: _raw, ...rest } = expense(id, overrides)
    return rest
  }

  function itemsDb() {
    return createFakeDb({
      spend_items: [
        { id: 'i-ready', connection_id: 'conn-1', journal_entry_id: null, status: 'ready', reasons: [], expense: model('exp-1') },
        {
          id: 'i-review',
          connection_id: 'conn-1',
          journal_entry_id: null,
          status: 'review',
          reasons: [{ code: 'wallet_account_differs', params: { settings: '1940', provider: '1930' } }],
          expense: model('exp-2', { walletAccount: '1930' }),
        },
        { id: 'i-booked', connection_id: 'conn-1', journal_entry_id: 'je-1', status: 'booked', reasons: [], expense: model('exp-3') },
        { id: 'i-rejected', connection_id: 'conn-1', journal_entry_id: null, status: 'rejected', reasons: [{ code: 'account_unknown', params: { account: '6110' } }], expense: model('exp-4') },
        { id: 'i-other', connection_id: 'conn-2', journal_entry_id: null, status: 'ready', reasons: [], expense: model('exp-5') },
      ],
      chart_of_accounts: CHART,
      company_settings: [{ company_id: COMPANY, vat_registered: true, dimensions_enabled: false }],
    })
  }

  const connection = { id: 'conn-1', company_id: COMPANY, provider_name: 'Pleo' }

  it('re-evaluates the unbooked received expenses against new settings and leaves booked and rejected ones alone', async () => {
    const db = itemsDb()
    const changed = await reevaluateSpendItems(db.client as unknown as SupabaseClient, connection, { wallet_account: '1930', out_of_pocket_account: '2820' })

    expect(changed).toBe(2)
    const rows = Object.fromEntries(db.tables.spend_items.map((row) => [row.id as string, row]))
    expect(rows['i-ready']).toMatchObject({ status: 'review', reasons: [{ code: 'wallet_account_differs', params: { settings: '1930', provider: '1940' } }] })
    expect(rows['i-review']).toMatchObject({ status: 'ready', reasons: [] })
    expect(rows['i-booked']).toMatchObject({ status: 'booked', reasons: [] })
    expect(rows['i-rejected']).toMatchObject({ status: 'rejected', reasons: [{ code: 'account_unknown', params: { account: '6110' } }] })
    expect(rows['i-other']).toMatchObject({ status: 'ready', reasons: [] })
  })

  it('never turns a received expense into a rejection: it waits for a person instead', async () => {
    const db = itemsDb()
    await reevaluateSpendItems(db.client as unknown as SupabaseClient, connection, { wallet_account: '1960', out_of_pocket_account: '2820' })

    expect(db.tables.spend_items.find((row) => row.id === 'i-ready')).toMatchObject({
      status: 'review',
      reasons: [{ code: 'account_unknown', params: { account: '1960' } }],
    })
  })

  it('answers 0 when nothing waits', async () => {
    const db = createFakeDb({ spend_items: [] })
    expect(await reevaluateSpendItems(db.client as unknown as SupabaseClient, connection, { wallet_account: null, out_of_pocket_account: '2820' })).toBe(0)
  })
})

describe('loadBookableAccounts', () => {
  it('books on active chart accounts and on standard BAS accounts the chart does not hold yet, never on a deactivated one', async () => {
    const isBookable = await loadBookableAccounts(seed().client as unknown as SupabaseClient, COMPANY)
    expect(isBookable('5410')).toBe(true)
    expect(isBookable('6540')).toBe(true)
    expect(isBookable('6110')).toBe(false)
    expect(isBookable('1960')).toBe(false)
    expect(isBookable('9999')).toBe(false)
  })
})
