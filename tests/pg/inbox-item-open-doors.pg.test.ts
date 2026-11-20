/**
 * One company with one inbox item in every shape, and every reader of "still
 * open" asked about the same rows on real Postgres: the Inkorg list, the v1
 * list and its unprocessed_only, gnubok_list_inbox_items and its
 * unprocessed_only, the Hem count, the attach picker, the agent's candidates
 * and gnubok_list_unmatched_documents (the client overview, and the embed on a
 * real PostgREST: tests/tool-pg/inbox-item-open.tool.test.ts). One definition
 * (lib/documents/inbox-item-state.ts), so one answer: an item is open while nothing holds it
 * and Arkiv did not take it. A verifikat that holds its document holds it,
 * stamp or not, until that verifikat is reversed.
 *
 * The document readers ask one thing more: a link is permanent, so a document
 * on a reversed verifikat is open but can go on no other verifikat.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts)
 * and the session doors' cookie auth.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { tools } from '@/extensions/general/mcp-server/server'
import { findUnderlagCandidates } from '@/lib/agent-context/underlag-candidates'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { listInboxItemsPage } from '@/lib/documents/inbox-item-actions'
import type { ExtensionContext } from '@/lib/extensions/types'
import { itemStage } from '@/lib/documents/inbox-item-state'
import type { InkorgItem } from '@/lib/inkorg/items'
import type { OperationContext } from '@/lib/operations/types'
import { countInboxDocuments } from '@/lib/worklist/categories'
import { GET as inboxAvailable } from '@/app/api/documents/inbox-available/route'
import { POST as followCompanion } from '@/app/api/inkorg/items/[id]/companion/route'
import { testRoutes } from '../helpers'
import { insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
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
const READING = {
  documentKind: 'receipt',
  supplier: { name: 'Butiken AB' },
  invoice: { invoiceDate: '2026-03-02', currency: 'SEK' },
  totals: { total: 500 },
}

type Shape = 'open' | 'held' | 'held_by_reversed' | 'routed' | 'matched' | 'stamped' | 'converted'

let ids: Record<Shape, string>
let companyId: string
let userId: string
const supabase = () => createServiceClientNoCookies()

async function document(company: string, user: string, journalEntryId: string | null = null): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type, journal_entry_id)
     VALUES ($1, $2, $3, $4, 'kvitto.pdf', $5, 'application/pdf', $6)`,
    [id, company, user, `${company}/${id}.pdf`, `sha-${id}`, journalEntryId],
  )
  return id
}

beforeAll(async () => {
  const seeded = await seedCompany()
  companyId = seeded.companyId
  userId = seeded.userId
  session.userId = userId
  session.companyId = companyId
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, company_name) VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'Bolaget AB')`,
    [userId, companyId],
  )
  const entry = (description: string) =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-03-02',
      description,
      lines: [
        { accountNumber: '6110', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })
  const { rows: supplier } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency) VALUES ($1, $2, 'Butiken AB', 'swedish_business', 'SEK') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const { rows: invoice } = await getPool().query<{ id: string }>(
    `INSERT INTO public.supplier_invoices (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, remaining_amount)
     VALUES ($1, $2, $3, 1, 'F-1', '2026-03-02', '2026-04-01', 'registered', 'SEK', 400, 100, 500, 500) RETURNING id::text AS id`,
    [userId, companyId, supplier[0]!.id],
  )
  const row = await insertTransaction({ companyId, userId, date: '2026-03-02', amount: -500 })
  const held = await entry('Håller dokumentet')
  const reversed = await entry('Återförd')
  const stamp = await entry('Stämplad')
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [reversed])

  const item = async (documentId: string, columns: Record<string, unknown> = {}) => {
    const id = randomUUID()
    const names = Object.keys(columns)
    await getPool().query(
      `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data${names.map((n) => `, ${n}`).join('')})
       VALUES ($1, $2, $3, $4, 'received', 'upload', $5${names.map((_, i) => `, $${i + 6}`).join('')})`,
      [id, companyId, userId, documentId, JSON.stringify(READING), ...Object.values(columns)],
    )
    return id
  }
  ids = {
    open: await item(await document(companyId, userId)),
    held: await item(await document(companyId, userId, held)),
    held_by_reversed: await item(await document(companyId, userId, reversed)),
    routed: await item(await document(companyId, userId), { routed_to_arkiv_at: '2026-03-03T10:00:00Z', routed_doc_type: 'bank_statement' }),
    matched: await item(await document(companyId, userId), { matched_transaction_id: row }),
    stamped: await item(await document(companyId, userId), { created_journal_entry_id: stamp }),
    converted: await item(await document(companyId, userId), { created_supplier_invoice_id: invoice[0]!.id }),
  }
})

afterEach(() => {
  expect(shim.rest?.unsupported.splice(0) ?? []).toEqual([])
})

const nameOf = (id: string) => (Object.entries(ids).find(([, itemId]) => itemId === id)?.[0] ?? id) as Shape
const sorted = (names: string[]) => [...names].sort()
const opContext = () => ({ supabase: supabase(), companyId, userId, log }) as OperationContext

async function inkorgItems(company = companyId, user = userId): Promise<InkorgItem[]> {
  const route = testRoutes(invoiceInboxExtension).find((r) => r.method === 'GET' && r.path === '/items')!
  const response = await route.handler(
    new Request('http://localhost/items'),
    { userId: user, companyId: company, extensionId: 'invoice-inbox', supabase: supabase(), emit: async () => {}, settings: { get: async () => null, set: async () => {} }, log, services: {} } as unknown as ExtensionContext,
  )
  return ((await response.json()) as { data: { items: InkorgItem[] } }).data.items
}

const OPEN: Shape[] = ['held_by_reversed', 'open']

describe('every reader of an open item', () => {
  it('the Inkorg reads the stage the same way', { timeout: 30_000 }, async () => {
    const items = await inkorgItems()
    const stages = Object.fromEntries(items.map((item) => [nameOf(item.id), itemStage(item)]))
    expect(stages).toEqual({
      open: 'needs_action',
      held: 'booked',
      held_by_reversed: 'needs_action',
      routed: 'needs_action',
      matched: 'linked',
      stamped: 'booked',
      converted: 'booked',
    })
  })

  it('v1: processed is the opposite of open, and unprocessed_only lists the open items', { timeout: 30_000 }, async () => {
    const all = await listInboxItemsPage(opContext(), {})
    if (!all.ok || all.dryRun) throw new Error('list refused')
    expect(sorted(all.data.inbox_items.filter((item) => !item.processed).map((item) => nameOf(item.inbox_item_id)))).toEqual(OPEN)

    const open = await listInboxItemsPage(opContext(), { unprocessed_only: 'true' })
    if (!open.ok || open.dryRun) throw new Error('list refused')
    expect(sorted(open.data.inbox_items.map((item) => nameOf(item.inbox_item_id)))).toEqual(OPEN)
  })

  it('gnubok_list_inbox_items: the same', { timeout: 30_000 }, async () => {
    const tool = tools.find((candidate) => candidate.name === 'gnubok_list_inbox_items')!
    const all = (await tool.execute({} as never, companyId, userId, supabase() as never, { type: 'api_key' } as never)) as { items: Array<{ id: string; processed: boolean }> }
    expect(sorted(all.items.filter((item) => !item.processed).map((item) => nameOf(item.id)))).toEqual(OPEN)

    const open = (await tool.execute({ unprocessed_only: true } as never, companyId, userId, supabase() as never, { type: 'api_key' } as never)) as { items: Array<{ id: string }> }
    expect(sorted(open.items.map((item) => nameOf(item.id)))).toEqual(OPEN)
  })

  it('the Hem count counts the same documents', { timeout: 30_000 }, async () => {
    await expect(countInboxDocuments(supabase(), companyId)).resolves.toBe(OPEN.length)
  })
})

describe('the readers that offer a document for a verifikat', () => {
  it('the attach picker lists the open item whose document can still be linked', { timeout: 30_000 }, async () => {
    const response = await inboxAvailable(new Request('http://localhost/api/documents/inbox-available'), { params: Promise.resolve({}) } as never)
    const { data } = (await response.json()) as { data: Array<{ inbox_item_id: string }> }
    expect(data.map((row) => nameOf(row.inbox_item_id))).toEqual(['open'])
  })

  it('the agent\'s candidates: the same', { timeout: 30_000 }, async () => {
    const candidates = await findUnderlagCandidates(supabase(), companyId, {
      id: 'tx',
      date: '2026-03-02',
      description: 'Butiken',
      merchant_name: 'Butiken AB',
      amount: -500,
      currency: 'SEK',
    })
    expect(candidates.map((candidate) => nameOf(candidate.inbox_item_id))).toEqual(['open'])
  })

  it('gnubok_list_unmatched_documents: the same', { timeout: 30_000 }, async () => {
    const tool = tools.find((candidate) => candidate.name === 'gnubok_list_unmatched_documents')!
    const answer = (await tool.execute({} as never, companyId, userId, supabase() as never, { type: 'api_key' } as never)) as { items: Array<{ inbox_item_id?: string; id?: string }> }
    expect(answer.items.map((item) => nameOf((item.inbox_item_id ?? item.id) as string))).toEqual(['open'])
  })
})

describe('a half a verifikat holds, and the other half of its purchase', () => {
  const INVOICE = {
    documentKind: 'supplier_invoice',
    supplier: { name: 'Butiken AB' },
    invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-03-02', dueDate: '2026-04-01', currency: 'SEK' },
    totals: { subtotal: 400, vatAmount: 100, total: 500 },
  }
  const RECEIPT = { ...INVOICE, documentKind: 'receipt', invoice: { invoiceDate: '2026-03-02', currency: 'SEK' } }

  /** An invoice and its receipt from one mail: `held` sits on a posted verifikat with no stamp. A third is one more receipt of the mail. */
  async function purchase(held: 'invoice' | 'receipt' | 'third', entryStatus: 'posted' | 'reversed' = 'posted') {
    const seeded = await seedCompany()
    session.userId = seeded.userId
    session.companyId = seeded.companyId
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, company_name) VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'Bolaget AB')`,
      [seeded.userId, seeded.companyId],
    )
    const entry = await insertPostedJournalEntry({
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      entryDate: '2026-03-02',
      description: 'Bokad för hand',
      lines: [
        { accountNumber: '6110', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })
    if (entryStatus === 'reversed') await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [entry])
    const half = async (documentId: string, reading: unknown) => {
      const id = randomUUID()
      await getPool().query(
        `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data, resend_email_id)
         VALUES ($1, $2, $3, $4, 'received', 'email', $5, 'mail-1')`,
        [id, seeded.companyId, seeded.userId, documentId, JSON.stringify(reading)],
      )
      return id
    }
    const invoiceDocument = await document(seeded.companyId, seeded.userId, held === 'invoice' ? entry : null)
    const receiptDocument = await document(seeded.companyId, seeded.userId, held === 'receipt' ? entry : null)
    if (held === 'third') await half(await document(seeded.companyId, seeded.userId, entry), RECEIPT)
    return {
      ...seeded,
      entry,
      invoiceDocument,
      receiptDocument,
      invoice: await half(invoiceDocument, INVOICE),
      receipt: await half(receiptDocument, RECEIPT),
    }
  }

  const followed = async (s: Awaited<ReturnType<typeof purchase>>) => {
    const response = await followCompanion(
      new Request(`http://localhost/api/inkorg/items/${s.invoice}/companion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_item_id: s.receipt }),
      }),
      { params: Promise.resolve({ id: s.invoice }) },
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: unknown }).data
  }

  const bookDirectly = async (s: Awaited<ReturnType<typeof purchase>>, item: string) => {
    const route = testRoutes(invoiceInboxExtension).find((r) => r.method === 'POST' && r.path === '/items/:id/book-direct')!
    return route.handler(
      new Request(`http://localhost/items/${item}/book-direct?_id=${item}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: s.fiscalPeriodId,
          entry_date: '2026-03-02',
          description: 'Köpet igen',
          lines: [
            { account_number: '6110', debit_amount: 500, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 500 },
          ],
        }),
      }),
      { userId: s.userId, companyId: s.companyId, extensionId: 'invoice-inbox', supabase: supabase(), emit: async () => {}, settings: { get: async () => null, set: async () => {} }, log, services: {} } as unknown as ExtensionContext,
    )
  }

  const entriesOf = async (company: string) =>
    (await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [company])).rows.map((row) => row.id)
  const documentOn = async (id: string) =>
    (await getPool().query<{ journal_entry_id: string | null }>(`SELECT journal_entry_id::text AS journal_entry_id FROM public.document_attachments WHERE id = $1`, [id])).rows[0]!.journal_entry_id
  const stampOf = async (id: string) =>
    (await getPool().query<{ created_journal_entry_id: string | null }>(`SELECT created_journal_entry_id::text AS created_journal_entry_id FROM public.invoice_inbox_items WHERE id = $1`, [id])).rows[0]!.created_journal_entry_id

  afterEach(() => {
    session.userId = userId
    session.companyId = companyId
  })

  it('the screen names the verifikat, the action lands there and no door books the purchase again', { timeout: 60_000 }, async () => {
    const s = await purchase('invoice')

    const listed = (await inkorgItems(s.companyId, s.userId)).find((item) => item.id === s.receipt)!
    expect(listed.pairing).toMatchObject({ role: 'booked_companion', booked_item_id: s.invoice, booked_kind: 'invoice', journal_entry_id: s.entry })

    const refused = await bookDirectly(s, s.receipt)
    const answer = await refused.text()
    expect(refused.status, answer).toBe(409)
    expect(answer).toContain('INBOX_ITEM_PAIR_ALREADY_BOOKED')
    expect(await entriesOf(s.companyId)).toEqual([s.entry])

    await expect(followed(s)).resolves.toEqual({ status: 'completed', journal_entry_id: s.entry, transaction_id: null })
    expect(await documentOn(s.receiptDocument)).toBe(s.entry)
    expect(await stampOf(s.receipt)).toBe(s.entry)
    expect(await entriesOf(s.companyId)).toEqual([s.entry])
    await expect(followed(s)).resolves.toEqual({ status: 'already_done' })
  })

  it('the other way round: a receipt a verifikat holds takes its open invoice along', { timeout: 60_000 }, async () => {
    const s = await purchase('receipt')

    const listed = (await inkorgItems(s.companyId, s.userId)).find((item) => item.id === s.invoice)!
    expect(listed.pairing).toMatchObject({ role: 'booked_companion', booked_item_id: s.receipt, booked_kind: 'receipt', journal_entry_id: s.entry })

    await expect(followed(s)).resolves.toEqual({ status: 'completed', journal_entry_id: s.entry, transaction_id: null })
    expect(await documentOn(s.invoiceDocument)).toBe(s.entry)
    expect(await stampOf(s.invoice)).toBe(s.entry)
  })

  it('a third document of the mail that a verifikat holds is no candidate: the pair stands at the door as on the screen', { timeout: 60_000 }, async () => {
    const s = await purchase('third')
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, '1930', 'Bank', 1, 'asset', 'debit'), ($1, $2, '6110', 'Kontorsmaterial', 6, 'expense', 'debit') ON CONFLICT DO NOTHING`,
      [s.userId, s.companyId],
    )

    const listed = (await inkorgItems(s.companyId, s.userId)).find((item) => item.id === s.receipt)!
    expect(listed.pairing).toMatchObject({ role: 'receipt', invoice_item_id: s.invoice })
    await expect(followed(s)).resolves.toEqual({ status: 'waiting', reason: 'invoice_not_booked' })

    const booked = await bookDirectly(s, s.invoice)
    const answer = await booked.text()
    expect(booked.status, answer).toBe(200)
    const entry = await stampOf(s.invoice)
    expect(entry).toBeTruthy()
    expect(await stampOf(s.receipt), 'the receipt follows its invoice').toBe(entry)
    expect(await documentOn(s.receiptDocument)).toBe(entry)
  })

  it('a reversed verifikat holds nothing: both halves are open, one purchase, on the screen and at the door', { timeout: 60_000 }, async () => {
    const s = await purchase('invoice', 'reversed')

    const listed = (await inkorgItems(s.companyId, s.userId)).find((item) => item.id === s.receipt)!
    expect(listed.pairing).toMatchObject({ role: 'receipt', invoice_item_id: s.invoice })

    await expect(followed(s)).resolves.toEqual({ status: 'waiting', reason: 'invoice_not_booked' })
    expect(await stampOf(s.receipt)).toBeNull()
  })
})
