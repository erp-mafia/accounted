/**
 * The card beside a row's Godkänn in Rutin shows the verifikat the approval
 * posts. A supplier invoice from the inbox stages none: its approval registers
 * the invoice and builds the registration verifikat at the click, so the card
 * asks GET /api/pending-operations/[id]/verifikat, which runs the approval's
 * own conversion as a dry run. On real Postgres, each invoice is staged by the
 * agent's tool, previewed through that route, then approved as a person
 * approves it in Rutin: the rows the preview showed are the rows posted, and
 * the preview wrote nothing.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts)
 * and the session's cookie auth.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@/extensions/general/mcp-server/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resetExchangeRateStateForTests } from '@/lib/currency/riksbanken'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { eventBus } from '@/lib/events/bus'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { ApprovalVerifikatAnswer } from '@/lib/pending-operations/built-at-approval'
import type { PendingOperation } from '@/types'
import { GET as verifikatRoute } from '@/app/api/pending-operations/[id]/verifikat/route'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
const session = vi.hoisted(() => ({ userId: '', companyId: '' }))

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})
vi.mock('@/lib/auth/require-auth', async () => {
  const { createServiceClientNoCookies: client } = await import('@/lib/auth/api-keys')
  return { requireAuth: async () => ({ user: { id: session.userId }, supabase: client(), error: null }) }
})
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  getActiveCompanyId: async () => session.companyId,
  requireCompanyId: async () => session.companyId,
}))

type Settings = { accountingMethod?: 'accrual' | 'cash'; vatRegistered?: boolean }

interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

async function seed({ accountingMethod = 'accrual', vatRegistered = true }: Settings = {}): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, company_name, org_number)
     VALUES ($1, $2, 'aktiebolag', $3, $4, 'Konsultbolaget AB', '556677-8899')`,
    [userId, companyId, accountingMethod, vatRegistered],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, supabase: createServiceClientNoCookies() }
}

type SupplierType = 'swedish_business' | 'eu_business'

async function supplier(s: Seed, type: SupplierType): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, org_number, vat_number, country, supplier_type, default_currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'SEK') RETURNING id::text AS id`,
    type === 'eu_business'
      ? [s.userId, s.companyId, 'Cloudhost GmbH', null, 'DE123456789', 'DE', type]
      : [s.userId, s.companyId, 'Kontorsleverantören AB', '559900-1234', null, 'SE', type],
  )
  return rows[0]!.id
}

interface Line {
  description: string
  lineTotal: number
  vatRate: number
  account: string
}

/** An inbox item read as a supplier invoice, its document, and the supplier it was matched to. */
async function inboxItem(s: Seed, supplierId: string, number: string, currency: string, lines: Line[]): Promise<string> {
  const documentId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type)
     VALUES ($1, $2, $3, $4, 'faktura.pdf', $5, 'application/pdf')`,
    [documentId, s.companyId, s.userId, `${s.companyId}/${documentId}.pdf`, `sha-${documentId}`],
  )
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0)
  const vat = lines.reduce((sum, line) => sum + (line.lineTotal * line.vatRate) / 100, 0)
  const reading = {
    documentKind: 'supplier_invoice',
    supplier: { name: 'Leverantören' },
    invoice: { invoiceNumber: number, invoiceDate: '2026-03-02', dueDate: '2026-04-01', currency },
    totals: { subtotal, vatAmount: vat, total: subtotal + vat },
    lineItems: lines.map((line) => ({
      description: line.description,
      quantity: 1,
      unitPrice: line.lineTotal,
      lineTotal: line.lineTotal,
      vatRate: line.vatRate,
      accountSuggestion: line.account,
    })),
  }
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data, matched_supplier_id)
     VALUES ($1, $2, $3, $4, 'received', 'email', $5, $6)`,
    [id, s.companyId, s.userId, documentId, JSON.stringify(reading), supplierId],
  )
  return id
}

/** Staged by the agent's tool, as an agent stages it. */
async function stage(s: Seed, item: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === 'gnubok_create_supplier_invoice_from_inbox')!
  const staged = (await tool.execute(
    { inbox_item_id: item, __keyScopes: [], ...args } as never,
    s.companyId,
    s.userId,
    s.supabase as never,
    { type: 'api_key' } as never,
  )) as { operation_id?: string }
  if (!staged.operation_id) throw new Error(`nothing staged: ${JSON.stringify(staged).slice(0, 800)}`)
  return staged.operation_id
}

/** What the card asks for when it opens. */
async function preview(operationId: string): Promise<{ status: number; answer: ApprovalVerifikatAnswer | null }> {
  const response = await verifikatRoute(new Request(`http://localhost/api/pending-operations/${operationId}/verifikat`), {
    params: Promise.resolve({ id: operationId }),
  })
  const body = (await response.json()) as { data?: ApprovalVerifikatAnswer }
  return { status: response.status, answer: body.data ?? null }
}

/** The approval a person gives with the row's Godkänn. */
async function approve(s: Seed, operationId: string) {
  const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [operationId])
  return runWithActor({ type: 'user' }, () =>
    commitPendingOperation(s.supabase, s.userId, s.companyId, rows[0] as PendingOperation, {
      keepFixableRefusals: true,
      commitMethod: 'user_accept',
      actor: { type: 'user' },
    }),
  )
}

type Row = [account: string, debit: number, credit: number]

/** The rows of the registration verifikat the approval posted, in order, and its date. */
async function posted(s: Seed): Promise<{ entryDate: string; rows: Row[] } | null> {
  const { rows: entries } = await getPool().query<{ id: string; entry_date: string }>(
    `SELECT je.id::text, je.entry_date::text
       FROM public.supplier_invoices si JOIN public.journal_entries je ON je.id = si.registration_journal_entry_id
      WHERE si.company_id = $1`,
    [s.companyId],
  )
  if (entries.length === 0) return null
  expect(entries).toHaveLength(1)
  const { rows } = await getPool().query<{ account_number: string; debit_amount: string; credit_amount: string }>(
    `SELECT account_number, debit_amount::text, credit_amount::text FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [entries[0]!.id],
  )
  return { entryDate: entries[0]!.entry_date, rows: rows.map((r) => [r.account_number, Number(r.debit_amount), Number(r.credit_amount)]) }
}

function previewed(answer: ApprovalVerifikatAnswer | null): { entryDate: string; rows: Row[] } {
  if (answer?.posts !== 'verifikat') throw new Error(`no verifikat previewed: ${JSON.stringify(answer)}`)
  expect(answer.verifikat).toHaveLength(1)
  const [entry] = answer.verifikat
  return { entryDate: entry!.entry_date, rows: entry!.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]) }
}

/** Everything an approval writes, to show that a preview writes none of it. */
async function written(s: Seed, operationId: string, item: string) {
  const count = async (sql: string) => Number((await getPool().query<{ n: string }>(sql, [s.companyId])).rows[0]!.n)
  const { rows: op } = await getPool().query(`SELECT status, updated_at::text FROM public.pending_operations WHERE id = $1`, [operationId])
  const { rows: inbox } = await getPool().query(`SELECT created_supplier_invoice_id, status FROM public.invoice_inbox_items WHERE id = $1`, [item])
  return {
    supplierInvoices: await count(`SELECT count(*) AS n FROM public.supplier_invoices WHERE company_id = $1`),
    supplierInvoiceItems: await count(
      `SELECT count(*) AS n FROM public.supplier_invoice_items i JOIN public.supplier_invoices si ON si.id = i.supplier_invoice_id WHERE si.company_id = $1`,
    ),
    journalEntries: await count(`SELECT count(*) AS n FROM public.journal_entries WHERE company_id = $1`),
    // Shared by every company: the cache a rate lookup at Riksbanken fills.
    exchangeRates: Number((await getPool().query<{ n: string }>(`SELECT count(*) AS n FROM public.exchange_rates`)).rows[0]!.n),
    linkedDocuments: await count(`SELECT count(*) AS n FROM public.document_attachments WHERE company_id = $1 AND journal_entry_id IS NOT NULL`),
    suppliers: (await getPool().query(`SELECT * FROM public.suppliers WHERE company_id = $1 ORDER BY id`, [s.companyId])).rows,
    operation: op[0],
    inbox: inbox[0],
  }
}

beforeEach(() => {
  vi.stubEnv('POSTING_EVENTS', '')
  eventBus.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  eventBus.clear()
  expect(shim.rest?.unsupported.splice(0) ?? []).toEqual([])
})

const CASES: Array<{
  name: string
  supplier: SupplierType
  currency: string
  lines: Line[]
  args?: Record<string, unknown>
  /** An account the verifikat must carry, so the case is the case it says it is. */
  carries: string[]
  without?: string[]
}> = [
  {
    name: 'a Swedish supplier, 25 % moms',
    supplier: 'swedish_business',
    currency: 'SEK',
    lines: [{ description: 'Konsultstöd', lineTotal: 1000, vatRate: 25, account: '6540' }],
    carries: ['6540', '2641', '2440'],
  },
  {
    name: 'omvänd skattskyldighet: an EU supplier\'s services',
    supplier: 'eu_business',
    currency: 'SEK',
    lines: [{ description: 'Hosting', lineTotal: 10000, vatRate: 0, account: '6540' }],
    carries: ['6540', '2645', '2614', '2440'],
    without: ['2641'],
  },
  {
    name: 'an invoice in euro: every row in kronor at the invoice\'s rate',
    supplier: 'swedish_business',
    currency: 'EUR',
    lines: [{ description: 'Mässplats', lineTotal: 1234.56, vatRate: 25, account: '5910' }],
    args: { exchange_rate_override: 11.4321 },
    carries: ['5910', '2641', '2440'],
  },
  {
    name: 'omvänd skattskyldighet on an invoice in euro: the fiktiv moms at the rate',
    supplier: 'eu_business',
    currency: 'EUR',
    lines: [{ description: 'Licenser', lineTotal: 987.65, vatRate: 0, account: '5420' }],
    args: { exchange_rate_override: 11.2468 },
    carries: ['5420', '2645', '2614', '2440'],
  },
  {
    name: 'begränsat momsavdrag: half the moms of a personbil lease',
    supplier: 'swedish_business',
    currency: 'SEK',
    lines: [
      { description: 'Leasing personbil', lineTotal: 4800, vatRate: 25, account: '5615' },
      { description: 'Försäkring', lineTotal: 300, vatRate: 0, account: '5615' },
    ],
    args: { line_overrides: [{ line_number: 1, vat_deduction_share: 0.5 }] },
    carries: ['5615', '2641', '2440'],
  },
]

describe('the preview of an inbox supplier invoice is the verifikat its approval posts', () => {
  it.each(CASES)('$name', { timeout: 60_000 }, async ({ supplier: type, currency, lines, args, carries, without }) => {
    const s = await seed()
    const item = await inboxItem(s, await supplier(s, type), `F-${randomUUID().slice(0, 8)}`, currency, lines)
    const operationId = await stage(s, item, args)

    const before = await written(s, operationId, item)
    const { status, answer } = await preview(operationId)
    expect(status).toBe(200)
    expect(await written(s, operationId, item)).toEqual(before)
    const shown = previewed(answer)

    const result = await approve(s, operationId)
    expect(result.status, JSON.stringify(result)).toBe('committed')
    expect(await posted(s)).toEqual(shown)
    // The registration is every verifikat the approval posts.
    expect((await written(s, operationId, item)).journalEntries).toBe(1)
    const accounts = shown.rows.map(([account]) => account)
    expect(accounts).toEqual(expect.arrayContaining(carries))
    for (const account of without ?? []) expect(accounts).not.toContain(account)
  })

  it('half the moms of the lease is deducted, and its other half is cost on the lease', { timeout: 60_000 }, async () => {
    const s = await seed()
    const item = await inboxItem(s, await supplier(s, 'swedish_business'), 'F-LEASE', 'SEK', [
      { description: 'Leasing personbil', lineTotal: 4800, vatRate: 25, account: '5615' },
    ])
    const shown = previewed((await preview(await stage(s, item, { line_overrides: [{ line_number: 1, vat_deduction_share: 0.5 }] }))).answer)
    expect(shown.rows).toEqual([
      ['5615', 5400, 0],
      ['2641', 600, 0],
      ['2440', 0, 6000],
    ])
  })
})

describe('the preview follows the company as it is at the click, not as it was at the staging', () => {
  it('VAT registration switched off after the staging: the seller\'s moms is cost, in the preview and in the approval', { timeout: 60_000 }, async () => {
    const s = await seed()
    const item = await inboxItem(s, await supplier(s, 'swedish_business'), 'F-REG', 'SEK', [
      { description: 'Konsultstöd', lineTotal: 1000, vatRate: 25, account: '6540' },
    ])
    const operationId = await stage(s, item)
    await getPool().query(`UPDATE public.company_settings SET vat_registered = false WHERE company_id = $1`, [s.companyId])

    const shown = previewed((await preview(operationId)).answer)
    expect(shown.rows).toEqual([
      ['6540', 1250, 0],
      ['2440', 0, 1250],
    ])
    expect((await approve(s, operationId)).status).toBe('committed')
    expect(await posted(s)).toEqual(shown)
  })

  it('an invoice in euro staged without a rate: the preview asks Riksbanken nothing and writes nothing', { timeout: 60_000 }, async () => {
    const s = await seed()
    const item = await inboxItem(s, await supplier(s, 'swedish_business'), 'F-NORATE', 'EUR', [
      { description: 'Mässplats', lineTotal: 1000, vatRate: 25, account: '5910' },
    ])
    // Riksbanken does not answer at the staging, so the tool stages the invoice without a rate.
    const riksbanken = vi.fn(async () => {
      throw new Error('Riksbanken unreachable')
    })
    vi.stubGlobal('fetch', riksbanken)
    try {
      const operationId = await stage(s, item)
      const { rows } = await getPool().query(`SELECT params->'exchange_rate' AS rate FROM public.pending_operations WHERE id = $1`, [operationId])
      expect(rows[0]!.rate).toBeNull()
      riksbanken.mockClear()

      const before = await written(s, operationId, item)
      expect((await preview(operationId)).answer).toEqual({ posts: 'at_approval' })
      expect(riksbanken).not.toHaveBeenCalled()
      expect(await written(s, operationId, item)).toEqual(before)
    } finally {
      vi.unstubAllGlobals()
      resetExchangeRateStateForTests()
    }
  })

  it('kontantmetoden: the approval posts no verifikat now, and the preview says so', { timeout: 60_000 }, async () => {
    const s = await seed({ accountingMethod: 'cash' })
    const item = await inboxItem(s, await supplier(s, 'swedish_business'), 'F-CASH', 'SEK', [
      { description: 'Konsultstöd', lineTotal: 1000, vatRate: 25, account: '6540' },
    ])
    const operationId = await stage(s, item)

    expect((await preview(operationId)).answer).toEqual({ posts: 'nothing' })
    expect((await approve(s, operationId)).status).toBe('committed')
    expect(await posted(s)).toBeNull()
  })

  it('a fiscal year closed after the staging: the preview gives the approval\'s own refusal, and nothing is posted', { timeout: 60_000 }, async () => {
    const s = await seed()
    const item = await inboxItem(s, await supplier(s, 'swedish_business'), 'F-CLOSED', 'SEK', [
      { description: 'Konsultstöd', lineTotal: 1000, vatRate: 25, account: '6540' },
    ])
    const operationId = await stage(s, item)
    await getPool().query(`UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`, [s.fiscalPeriodId])

    const { answer } = await preview(operationId)
    expect(answer).toMatchObject({ posts: 'refused', code: 'SI_CREATE_NO_FISCAL_PERIOD' })
    expect(answer?.posts === 'refused' && answer.message_sv).toMatch(/räkenskapsår/)
    expect(answer?.posts === 'refused' && answer.message_en).toMatch(/fiscal year/)

    const result = await approve(s, operationId)
    expect(result).toMatchObject({ code: 'SI_CREATE_NO_FISCAL_PERIOD' })
    expect(await posted(s)).toBeNull()
  })
})

describe('the route', () => {
  it('another company\'s proposal is not found, and its preview is not worked out', { timeout: 60_000 }, async () => {
    const other = await seed()
    const item = await inboxItem(other, await supplier(other, 'swedish_business'), 'F-OTHER', 'SEK', [
      { description: 'Konsultstöd', lineTotal: 1000, vatRate: 25, account: '6540' },
    ])
    const operationId = await stage(other, item)
    await seed()

    expect(await preview(operationId)).toEqual({ status: 404, answer: null })
  })
})
