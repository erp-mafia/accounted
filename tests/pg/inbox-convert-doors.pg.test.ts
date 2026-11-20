/**
 * One inbox item through every door that turns it into a supplier invoice, on
 * real Postgres: the dashboard route, the v1 route on a real API key and the
 * approval of a staged conversion
 * (gnubok_create_supplier_invoice_from_inbox). They all run
 * convertInboxItemToSupplierInvoice, so the item decides the answer and the
 * door does not: the same notes, the same events, the same refusals. The
 * approval used to be a 640-line copy of its own, which dropped the channel
 * context, emitted one event and knew no pair guard.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts)
 * and the extension door's request context.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { tools } from '@/extensions/general/mcp-server/server'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { eventBus } from '@/lib/events/bus'
import type { ExtensionContext } from '@/lib/extensions/types'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
import { POST as v1Convert } from '@/app/api/v1/companies/[companyId]/inbox-items/[id]/convert/route'
import { testRoutes } from '../helpers'
import { insertPostedJournalEntry, seedCompany } from './fixtures'
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
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: async () => ({ ok: true }),
}))
vi.mock('@/lib/invoices/render-invoice-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/render-invoice-pdf')>()),
  renderInvoicePdfBuffer: async () => ({ buffer: Buffer.from('%PDF-1.4 pg-real') }),
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  uploadDocument: async () => {
    throw new Error('pg-real: no storage')
  },
}))

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const DOORS = ['session', 'v1', 'staged'] as const
type Door = (typeof DOORS)[number]

interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  supplier: string
  apiKey: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

async function seed(accountingMethod: 'accrual' | 'cash' = 'accrual'): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, company_name, org_number)
     VALUES ($1, $2, 'aktiebolag', $3, true, 'Konsultbolaget AB', '556677-8899')`,
    [userId, companyId, accountingMethod],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, org_number, supplier_type, default_currency, default_expense_account)
     VALUES ($1, $2, 'Lunchkrogen AB', '559900-1234', 'swedish_business', 'SEK', '6071') RETURNING id::text AS id`,
    [userId, companyId],
  )
  for (const [number, name, cls, type, normal] of [
    ['1930', 'Bank', 1, 'asset', 'debit'],
    ['2440', 'Leverantörsskulder', 2, 'liability', 'credit'],
    ['2641', 'Ingående moms', 2, 'asset', 'debit'],
    ['6071', 'Representation', 6, 'expense', 'debit'],
  ] as const) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [userId, companyId, number, name, cls, type, normal],
    )
  }
  const key = generateApiKey('live')
  await getPool().query(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes) VALUES ($1, $2, $3, $4, 'Bokföringsnyckel', $5)`,
    [userId, companyId, key.hash, key.prefix, ['suppliers:read', 'suppliers:write', 'documents:read', 'documents:write']],
  )
  session.userId = userId
  session.companyId = companyId
  return { userId, companyId, fiscalPeriodId, supplier: rows[0]!.id, apiKey: key.key, supabase: createServiceClientNoCookies() }
}

const NUMBER = 'F-1001'
const READING = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Lunchkrogen AB', orgNumber: '559900-1234' },
  invoice: { invoiceNumber: NUMBER, invoiceDate: '2026-03-02', dueDate: '2026-04-01', currency: 'SEK' },
  totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  lineItems: [{ description: 'Kundlunch', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 25, accountSuggestion: '6071' }],
}
const CHANNEL_CONTEXT = {
  channel: 'whatsapp',
  representation: { purpose: 'Kundmöte', participants: [{ name: 'Anna Berg', company: 'Bolag AB' }] },
  user_note: 'Lunch efter mötet',
}
const NOTES = 'Representation: Anna Berg (Bolag AB) · Syfte: Kundmöte · Lunch efter mötet'

async function document(s: Seed, journalEntryId: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type, journal_entry_id)
     VALUES ($1, $2, $3, $4, 'faktura.pdf', $5, 'application/pdf', $6)`,
    [id, s.companyId, s.userId, `${s.companyId}/${id}.pdf`, `sha-${id}`, journalEntryId],
  )
  return id
}

async function inboxItem(s: Seed, documentId: string, extra: { channelContext?: unknown; resendEmailId?: string; stampedOn?: string; reading?: unknown } = {}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data, matched_supplier_id, channel_context, resend_email_id, created_journal_entry_id)
     VALUES ($1, $2, $3, $4, 'received', 'email', $5, $6, $7, $8, $9)`,
    [id, s.companyId, s.userId, documentId, JSON.stringify(extra.reading ?? READING), s.supplier, JSON.stringify(extra.channelContext ?? null), extra.resendEmailId ?? null, extra.stampedOn ?? null],
  )
  return id
}

const postedEntry = (s: Seed) =>
  insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate: '2026-03-02',
    description: 'Bokad för hand',
    lines: [
      { accountNumber: '6071', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1250 },
    ],
  })

function extensionCtx(s: Seed): ExtensionContext {
  return {
    userId: s.userId,
    companyId: s.companyId,
    extensionId: 'invoice-inbox',
    supabase: s.supabase,
    emit: (event: never) => eventBus.emit(event),
    settings: { get: async () => null, set: async () => {} },
    log,
    services: {},
  } as unknown as ExtensionContext
}

const BODY = (s: Seed) => ({
  supplier_id: s.supplier,
  supplier_invoice_number: NUMBER,
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  items: [{ description: 'Kundlunch', amount: 1000, account_number: '6071', vat_rate: 0.25 }],
})

let idempotency = 0

async function approve(s: Seed, operationId: string): Promise<{ ok: boolean; code: string | null; body: unknown }> {
  const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [operationId])
  const result = await runWithActor({ type: 'user' }, () =>
    commitPendingOperation(s.supabase, s.userId, s.companyId, rows[0] as PendingOperation, { commitMethod: 'user_accept', actor: { type: 'user' } }),
  )
  return { ok: result.status === 'committed', code: result.code ?? null, body: result }
}

/** One conversion through one door: did it register, and the refusal's code when not. */
async function convert(s: Seed, door: Door, item: string): Promise<{ ok: boolean; code: string | null; body: unknown }> {
  if (door === 'staged') {
    const tool = tools.find((candidate) => candidate.name === 'gnubok_create_supplier_invoice_from_inbox')!
    let staged: { operation_id?: string }
    try {
      staged = (await tool.execute({ inbox_item_id: item, __keyScopes: [] } as never, s.companyId, s.userId, s.supabase as never, { type: 'api_key' } as never)) as { operation_id?: string }
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? null, body: String(err) }
    }
    return approve(s, staged.operation_id!)
  }
  const body = JSON.stringify(BODY(s))
  const response = await runWithActor({ type: 'user' }, () =>
    door === 'session'
      ? testRoutes(invoiceInboxExtension)
          .find((r) => r.method === 'POST' && r.path === '/items/:id/convert')!
          .handler(new Request(`http://localhost/items/${item}/convert?_id=${item}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), extensionCtx(s))
      : v1Convert(
          new Request(`http://localhost/api/v1/companies/${s.companyId}/inbox-items/${item}/convert`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `pg-convert-${Date.now()}-${++idempotency}` },
            body,
          }),
          { params: Promise.resolve({ companyId: s.companyId, id: item }) },
        ),
  )
  const parsed = (await response.json()) as { error?: { code?: string } | string }
  return { ok: response.ok, code: typeof parsed.error === 'object' ? (parsed.error.code ?? null) : null, body: parsed }
}

async function invoicesOf(s: Seed) {
  const { rows } = await getPool().query<{ id: string; notes: string | null; total: string; subtotal: string; vat_amount: string; document_id: string | null; registration_journal_entry_id: string | null }>(
    `SELECT id::text, notes, total::text, subtotal::text, vat_amount::text, document_id::text, registration_journal_entry_id::text FROM public.supplier_invoices WHERE company_id = $1`,
    [s.companyId],
  )
  return rows
}

const emitted: string[] = []

beforeEach(() => {
  vi.stubEnv('POSTING_EVENTS', '')
  emitted.length = 0
  eventBus.clear()
  for (const type of ['supplier_invoice.registered', 'supplier_invoice.confirmed'] as const) {
    eventBus.on(type, async () => {
      emitted.push(type)
    })
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  eventBus.clear()
  expect(shim.rest?.unsupported.splice(0) ?? []).toEqual([])
})

describe('every door registers the same invoice', () => {
  it.each(DOORS)('%s: the chat context lands in the notes, both events fire, the document holds the verifikat', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const documentId = await document(s)
    const item = await inboxItem(s, documentId, { channelContext: CHANNEL_CONTEXT })

    const answer = await convert(s, door, item)

    expect(answer.ok, JSON.stringify(answer.body)).toBe(true)
    const [invoice] = await invoicesOf(s)
    expect(invoice).toMatchObject({ notes: NOTES, total: '1250', subtotal: '1000', vat_amount: '250', document_id: documentId })
    expect(emitted).toEqual(['supplier_invoice.registered', 'supplier_invoice.confirmed'])

    const { rows: link } = await getPool().query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [documentId])
    expect(link[0]!.journal_entry_id).toBe(invoice!.registration_journal_entry_id)
    const { rows: stamped } = await getPool().query<{ created_supplier_invoice_id: string }>(`SELECT created_supplier_invoice_id::text FROM public.invoice_inbox_items WHERE id = $1`, [item])
    expect(stamped[0]!.created_supplier_invoice_id).toBe(invoice!.id)
  })
})

describe('an item something books already', () => {
  it.each(DOORS)('%s: refuses a registration verifikat next to the live verifikat its document sits on, and posts nothing', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const entry = await postedEntry(s)
    const item = await inboxItem(s, await document(s, entry))

    const answer = await convert(s, door, item)

    expect(answer).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED' })
    expect(await invoicesOf(s)).toEqual([])
  })

  it.each(DOORS)('%s: refuses a registration verifikat on an item stamped on a live verifikat', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const entry = await postedEntry(s)
    const item = await inboxItem(s, await document(s), { stampedOn: entry })

    const answer = await convert(s, door, item)

    expect(answer).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED' })
    expect(await invoicesOf(s)).toEqual([])
  })

  it('an approval refuses what got booked after it was staged, and posts nothing', { timeout: 60_000 }, async () => {
    const s = await seed()
    const documentId = await document(s)
    const item = await inboxItem(s, documentId)
    const tool = tools.find((candidate) => candidate.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const staged = (await tool.execute({ inbox_item_id: item, __keyScopes: [] } as never, s.companyId, s.userId, s.supabase as never, { type: 'api_key' } as never)) as { operation_id: string }
    const entry = await postedEntry(s)
    await getPool().query(`UPDATE public.document_attachments SET journal_entry_id = $2 WHERE id = $1`, [documentId, entry])

    expect(await approve(s, staged.operation_id)).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED' })
    expect(await invoicesOf(s)).toEqual([])
  })

  it.each(DOORS)('%s: converts when the verifikat that held the document is reversed: nothing books the purchase any more', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const entry = await postedEntry(s)
    const documentId = await document(s, entry)
    const item = await inboxItem(s, documentId)
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entry])

    const answer = await convert(s, door, item)

    expect(answer.ok, JSON.stringify(answer.body)).toBe(true)
    // The link is permanent: the document stays where it was.
    const { rows } = await getPool().query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [documentId])
    expect(rows[0]!.journal_entry_id).toBe(entry)
  })

  it.each(DOORS)('%s: registers with no verifikat under kontantmetoden: the conversion itself posts nothing', { timeout: 60_000 }, async (door) => {
    const s = await seed('cash')
    const entry = await postedEntry(s)
    const documentId = await document(s, entry)
    const item = await inboxItem(s, documentId)

    const answer = await convert(s, door, item)

    expect(answer.ok, JSON.stringify(answer.body)).toBe(true)
    const [invoice] = await invoicesOf(s)
    expect(invoice).toMatchObject({ registration_journal_entry_id: null, document_id: documentId })
    const { rows } = await getPool().query<{ journal_entry_id: string }>(`SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`, [documentId])
    expect(rows[0]!.journal_entry_id).toBe(entry)
  })
})

describe('the other half of the purchase', () => {
  const RECEIPT = { ...READING, documentKind: 'receipt', invoice: { ...READING.invoice, invoiceNumber: null, dueDate: null } }

  it.each(DOORS)('%s: refuses an invoice whose receipt, in the same mail, is booked', { timeout: 60_000 }, async (door) => {
    const s = await seed()
    const entry = await postedEntry(s)
    await inboxItem(s, await document(s, entry), { resendEmailId: 'mail-1', stampedOn: entry, reading: RECEIPT })
    const item = await inboxItem(s, await document(s), { resendEmailId: 'mail-1' })

    const answer = await convert(s, door, item)

    expect(answer.ok).toBe(false)
    expect(await invoicesOf(s)).toEqual([])
  })
})
