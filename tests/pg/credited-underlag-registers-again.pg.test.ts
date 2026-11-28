/**
 * An invoice registered on the wrong supplier, credited, and its underlag
 * registered again on the right one, on real Postgres and through the doors
 * an agent and a person use: the staged conversion
 * (gnubok_create_supplier_invoice_from_inbox, approved as a person approves
 * it) and POST /supplier-invoices with the document.
 *
 * Before the credit the item and the document are refused, as they always
 * were. After it, the registration goes through: the credited verifikat
 * keeps the original document row (the immutability trigger is never asked
 * to move it), the new registration verifikat gets a byte-identical copy of
 * its own, the item names the new invoice, and "Ångra kreditering" on the
 * credited invoice is refused, since it would book the purchase twice.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts)
 * and Storage. The copy's bytes are read from a stand-in for the bucket and
 * its row is inserted on the database, where its triggers run.
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@/extensions/general/mcp-server/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { eventBus } from '@/lib/events/bus'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { creditSupplierInvoice } from '@/lib/supplier-invoices/credit'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import type { PendingOperation } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
/** The bucket's stand-in: the bytes of each stored object, by storage path. */
const bucket = vi.hoisted(() => new Map<string, Buffer>())

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
vi.mock('@/lib/core/documents/storage-key', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/storage-key')>()),
  downloadDocumentObject: async (_client: unknown, storagePath: string) => {
    const bytes = bucket.get(storagePath)
    return bytes
      ? { blob: new Blob([new Uint8Array(bytes)]), error: null, errors: [], resolvedPath: storagePath }
      : { blob: null, error: { message: 'Object not found' }, errors: [{ message: 'Object not found' }], resolvedPath: null }
  },
}))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  const { getPool: pool } = await import('./setup')
  return {
    ...actual,
    // The bytes go to the bucket's stand-in; the row is inserted for real.
    uploadDocument: async (
      _supabase: unknown,
      userId: string,
      companyId: string,
      file: { name: string; buffer: ArrayBuffer; type?: string },
      metadata: { journal_entry_id?: string; upload_source?: string; linkBasis?: { link_basis: string; link_evidence: unknown } } = {},
    ) => {
      const id = randomUUID()
      const storagePath = `${companyId}/${userId}/${id}-${file.name}`
      bucket.set(storagePath, Buffer.from(file.buffer))
      const { rows } = await pool().query(
        `INSERT INTO public.document_attachments
           (id, company_id, user_id, storage_path, file_name, file_size_bytes, sha256_hash, mime_type, upload_source,
            uploaded_by, journal_entry_id, link_basis, link_evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $10, $11, $12) RETURNING *`,
        [
          id, companyId, userId, storagePath, file.name, file.buffer.byteLength,
          await actual.computeSHA256(file.buffer), file.type ?? null, metadata.upload_source ?? 'api',
          metadata.journal_entry_id ?? null,
          metadata.journal_entry_id ? (metadata.linkBasis?.link_basis ?? null) : null,
          metadata.journal_entry_id && metadata.linkBasis?.link_evidence != null ? JSON.stringify(metadata.linkBasis.link_evidence) : null,
        ],
      )
      return rows[0]
    },
  }
})

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const PDF = Buffer.from('%PDF-1.4 the supplier invoice as it was received')
const NUMBER = 'F-2041'

interface Seed {
  userId: string
  companyId: string
  wrong: string
  right: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

async function seed(): Promise<Seed> {
  const { userId, companyId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered, company_name, org_number)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true, 'Konsultbolaget AB', '556677-8899')`,
    [userId, companyId],
  )
  const supplier = async (name: string, org: string) =>
    (
      await getPool().query<{ id: string }>(
        `INSERT INTO public.suppliers (user_id, company_id, name, org_number, supplier_type, default_currency)
         VALUES ($1, $2, $3, $4, 'swedish_business', 'SEK') RETURNING id::text AS id`,
        [userId, companyId, name, org],
      )
    ).rows[0]!.id
  for (const [number, name, cls, type, normal] of [
    ['2440', 'Leverantörsskulder', 2, 'liability', 'credit'],
    ['2641', 'Ingående moms', 2, 'asset', 'debit'],
    ['6200', 'Tele och post', 6, 'expense', 'debit'],
  ] as const) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [userId, companyId, number, name, cls, type, normal],
    )
  }
  return {
    userId,
    companyId,
    wrong: await supplier('Fel Leverantör AB', '559900-1234'),
    right: await supplier('Rätt Leverantör AB', '559900-5678'),
    supabase: createServiceClientNoCookies(),
  }
}

/** The supplier's PDF, as the inbox archived it. */
async function document(s: Seed): Promise<string> {
  const id = randomUUID()
  const storagePath = `${s.companyId}/${id}.pdf`
  bucket.set(storagePath, PDF)
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type)
     VALUES ($1, $2, $3, $4, 'faktura.pdf', $5, 'application/pdf')`,
    [id, s.companyId, s.userId, storagePath, createHash('sha256').update(PDF).digest('hex')],
  )
  return id
}

async function inboxItem(s: Seed, documentId: string): Promise<string> {
  const id = randomUUID()
  const reading = {
    documentKind: 'supplier_invoice',
    supplier: { name: 'Rätt Leverantör AB', orgNumber: '559900-5678' },
    invoice: { invoiceNumber: NUMBER, invoiceDate: '2026-03-02', dueDate: '2026-04-01', currency: 'SEK' },
    totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
    lineItems: [{ description: 'Abonnemang', quantity: 1, unitPrice: 1000, lineTotal: 1000, vatRate: 25, accountSuggestion: '6200' }],
  }
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, status, source, extracted_data, matched_supplier_id)
     VALUES ($1, $2, $3, $4, 'received', 'email', $5, $6)`,
    [id, s.companyId, s.userId, documentId, JSON.stringify(reading), s.wrong],
  )
  return id
}

const ctx = (s: Seed) => ({ supabase: s.supabase, companyId: s.companyId, userId: s.userId, log })

const body = (supplierId: string) => ({
  supplier_id: supplierId,
  supplier_invoice_number: NUMBER,
  invoice_date: '2026-03-02',
  due_date: '2026-04-01',
  items: [{ description: 'Abonnemang', amount: 1000, account_number: '6200', vat_rate: 0.25 }],
})

/** Registered from the item on the wrong supplier, then credited: where the reported case stood. */
async function registeredOnTheWrongSupplierAndCredited(s: Seed) {
  const documentId = await document(s)
  const item = await inboxItem(s, documentId)
  const first = await runWithActor({ type: 'user' }, () => convertInboxItemToSupplierInvoice(ctx(s), item, body(s.wrong) as never, { emit: async () => {} }))
  expect(first.ok, JSON.stringify(first)).toBe(true)
  const wrongInvoice = first.ok && !first.dryRun ? first.data.invoice.id : ''

  // Before the credit the invoice stands: the item and the document are its.
  const twice = await convertInboxItemToSupplierInvoice(ctx(s), item, body(s.right) as never, { emit: async () => {} })
  expect(twice).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED' })
  const viaDocument = await createSupplierInvoice(ctx(s), { ...body(s.right), document_id: documentId } as never)
  expect(viaDocument).toMatchObject({ ok: false })

  const credited = await runWithActor({ type: 'user' }, () => creditSupplierInvoice(ctx(s), wrongInvoice, {}, { emit: async () => {} }))
  expect(credited.ok, JSON.stringify(credited)).toBe(true)
  const { rows } = await getPool().query<{ status: string; registration_journal_entry_id: string }>(
    `SELECT status, registration_journal_entry_id::text FROM public.supplier_invoices WHERE id = $1`,
    [wrongInvoice],
  )
  expect(rows[0]!.status).toBe('credited')
  return { documentId, item, wrongInvoice, wrongEntry: rows[0]!.registration_journal_entry_id }
}

async function documentRow(id: string) {
  const { rows } = await getPool().query<{ id: string; journal_entry_id: string | null; sha256_hash: string }>(
    `SELECT id::text, journal_entry_id::text, sha256_hash FROM public.document_attachments WHERE id = $1`,
    [id],
  )
  return rows[0]!
}

async function invoiceRow(id: string) {
  const { rows } = await getPool().query<{ supplier_id: string; status: string; document_id: string; registration_journal_entry_id: string }>(
    `SELECT supplier_id::text, status, document_id::text, registration_journal_entry_id::text FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0]!
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

describe('a credited invoice releases its underlag', () => {
  it('the agent registers the item again on the right supplier: the credited verifikat keeps the document, the new one gets a copy', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { documentId, item, wrongInvoice, wrongEntry } = await registeredOnTheWrongSupplierAndCredited(s)

    const tool = tools.find((candidate) => candidate.name === 'gnubok_create_supplier_invoice_from_inbox')!
    const staged = (await tool.execute(
      { inbox_item_id: item, supplier_id_override: s.right, __keyScopes: [] } as never,
      s.companyId,
      s.userId,
      s.supabase as never,
      { type: 'api_key' } as never,
    )) as { operation_id: string; preview: { registers_again?: { credited_supplier_invoice_id: string } } }
    expect(staged.preview.registers_again?.credited_supplier_invoice_id).toBe(wrongInvoice)

    const { rows: op } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [staged.operation_id])
    const approved = await runWithActor({ type: 'user' }, () =>
      commitPendingOperation(s.supabase, s.userId, s.companyId, op[0] as PendingOperation, { commitMethod: 'user_accept', actor: { type: 'user' } }),
    )
    expect(approved.status, JSON.stringify(approved)).toBe('committed')

    const { rows: stamped } = await getPool().query<{ created_supplier_invoice_id: string }>(
      `SELECT created_supplier_invoice_id::text FROM public.invoice_inbox_items WHERE id = $1`,
      [item],
    )
    const again = stamped[0]!.created_supplier_invoice_id
    expect(again).not.toBe(wrongInvoice)
    const registered = await invoiceRow(again)
    expect(registered).toMatchObject({ supplier_id: s.right, status: 'registered' })

    // The original never moved; the new verifikat holds a row of its own with the same bytes.
    expect(await documentRow(documentId)).toMatchObject({ journal_entry_id: wrongEntry })
    expect(registered.document_id).not.toBe(documentId)
    const copy = await documentRow(registered.document_id)
    expect(copy.journal_entry_id).toBe(registered.registration_journal_entry_id)
    expect(copy.sha256_hash).toBe((await documentRow(documentId)).sha256_hash)

    // Undoing the credit now would book the purchase twice.
    const undo = await runWithActor({ type: 'user' }, () => uncreditSupplierInvoice(ctx(s), wrongInvoice))
    expect(undo).toMatchObject({ ok: false, code: 'SI_UNCREDIT_REGISTERED_AGAIN', details: { supplier_invoice_id: again } })
    expect((await invoiceRow(wrongInvoice)).status).toBe('credited')
  })

  it('a person registers the document again: the same copy, and no second invoice holds the original', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { documentId, wrongEntry } = await registeredOnTheWrongSupplierAndCredited(s)

    const created = await runWithActor({ type: 'user' }, () =>
      createSupplierInvoice(ctx(s), { ...body(s.right), document_id: documentId } as never),
    )
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const invoiceId = created.ok && !created.dryRun ? (created.invoice.id as string) : ''
    const registered = await invoiceRow(invoiceId)
    expect(registered.supplier_id).toBe(s.right)
    expect(await documentRow(documentId)).toMatchObject({ journal_entry_id: wrongEntry })
    const copy = await documentRow(registered.document_id)
    expect(copy.id).not.toBe(documentId)
    expect(copy.journal_entry_id).toBe(registered.registration_journal_entry_id)

    // Registered again, the underlag is held again: a third registration from
    // the original is refused, the new invoice named as its holder.
    const third = await createSupplierInvoice(ctx(s), { ...body(s.right), supplier_invoice_number: 'F-2042', document_id: documentId } as never)
    expect(third).toMatchObject({ ok: false, details: { reason: 'document_already_used' } })
  })

  it('a kreditfaktura whose verifikat was reversed by hand releases nothing: the registration books the purchase again', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { documentId, item, wrongInvoice } = await registeredOnTheWrongSupplierAndCredited(s)
    const { rows: credit } = await getPool().query<{ registration_journal_entry_id: string }>(
      `SELECT registration_journal_entry_id::text FROM public.supplier_invoices WHERE credited_invoice_id = $1 AND is_credit_note`,
      [wrongInvoice],
    )
    await runWithActor({ type: 'user' }, () => reverseEntry(s.supabase, s.companyId, s.userId, credit[0]!.registration_journal_entry_id))

    const viaItem = await convertInboxItemToSupplierInvoice(ctx(s), item, body(s.right) as never, { emit: async () => {} })
    expect(viaItem).toMatchObject({ ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED' })
    const viaDocument = await createSupplierInvoice(ctx(s), { ...body(s.right), document_id: documentId } as never)
    expect(viaDocument).toMatchObject({ ok: false, details: { reason: 'document_unavailable' } })
    const { rows } = await getPool().query(`SELECT 1 FROM public.supplier_invoices WHERE supplier_id = $1`, [s.right])
    expect(rows).toEqual([])
  })
})
