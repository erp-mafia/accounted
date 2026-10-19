/**
 * Posting port, step 2d: proof that booking output does not change when the
 * supplier invoice registration, booking and crediting move onto the port.
 *
 * Each producer is driven through its real door on a freshly seeded company:
 * createSupplierInvoice (a domestic invoice with its underlag, an EU
 * supplier's EUR invoice under reverse charge, one inside a staged
 * operation's approval, and one whose invoice link fails, so its
 * registration is reversed), bookSupplierInvoice (the deferred Bokför step),
 * convertInboxItemToSupplierInvoice (an inbox item converted with its
 * underlag) and the staged conversion through commitPendingOperation,
 * creditSupplierInvoice (a credit on the credit note's own date, a credit
 * note from the inbox approved from a staged operation, and a credit whose
 * credit note link fails, so the credit verifikat is reversed) and
 * uncreditSupplierInvoice (a credit undone with a storno). Every verifikat a
 * flow writes is dumped normalised (series, number, date, description,
 * source type, status and every line) together with the supplier invoices,
 * the underlag links and the inbox items the doors write beside them, and
 * the dump is compared with the committed fixture
 * (posting-parity-supplier-invoices.fixture.json), which was taken before
 * these producers went through the port.
 *
 * With the producers on the port, the test also asserts that
 *
 *   1. the dump with POSTING_EVENTS=off equals the fixture and writes no
 *      event;
 *   2. the dump with POSTING_EVENTS=shadow equals the dump with it off, and
 *      every verifikat a door wrote has exactly ONE event linked: the
 *      registration purchase.registered, the credit note purchase.credited
 *      (subject the credit note) and each storno ledger.storno (role
 *      reversal), with the supplier as party, the payable and its moms as
 *      magnitudes, the underlag, the inbox item and the link basis (the
 *      staged ones naming their pending operation) as evidence;
 *   3. a failed event or link write under shadow still posts; under strict
 *      the registration, the Bokför step, the inbox conversion, the credit
 *      and the uncredit each stop before a voucher number is drawn; and
 *      detect_voucher_gaps finds no gap.
 *
 * Regenerate the fixture only on purpose, from the code before the move:
 *   UPDATE_POSTING_PARITY_FIXTURE=1 npx vitest run --project pg-real tests/pg/posting-parity-supplier-invoices.pg.test.ts
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in posting-parity.pg.test.ts
 * (every request must stay inside the shim's grammar, asserted after each
 * test).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { convertInboxItemToSupplierInvoice } from '@/lib/operations/inbox-convert'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { runInOperationCommit } from '@/lib/pending-operations/commit-scope'
import { bookSupplierInvoice } from '@/lib/supplier-invoices/book-service'
import { createSupplierInvoice, type CreateSupplierInvoiceInput } from '@/lib/supplier-invoices/create'
import { creditSupplierInvoice } from '@/lib/supplier-invoices/credit'
import { uncreditSupplierInvoice } from '@/lib/supplier-invoices/manage'
import type { OperationContext } from '@/lib/operations/types'
import type { PendingOperation } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
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

afterEach(() => {
  vi.unstubAllEnvs()
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const FIXTURE = path.join(__dirname, 'posting-parity-supplier-invoices.fixture.json')
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

/** An aktiebolag under faktureringsmetoden, VAT-registered, with a Swedish and an EU supplier. */
interface Seed {
  userId: string
  companyId: string
  fiscalPeriodId: string
  domestic: string
  eu: string
  supabase: ReturnType<typeof createServiceClientNoCookies>
}

/** What a flow wrote: the supplier invoices (and credit notes) it is about, its underlag and inbox items. */
interface Posted {
  invoiceIds: string[]
  documentIds?: string[]
  inboxItemIds?: string[]
}

type EntryRole = 'supplier_invoice_registered' | 'supplier_credit_note' | 'storno'

/** One business event shadow mode records for a flow, and the verifikat it is linked to. */
interface ExpectedEvent {
  kind: string
  role: 'produced' | 'reversal'
  /** The act's date; 'today' for a storno, dated the day it is made. */
  occurred_on: string
  /** Index into the flow's invoiceIds. */
  subject: number
  party: 'domestic' | 'eu' | null
  currency: string | null
  amount: number | null
  amount_sek: number | null
  /** The moms the invoice states, in SEK, under this treatment; null for none. */
  vat: { treatment: string; amount_sek: number } | null
  /** Index into the flow's documentIds and inboxItemIds; null for none. */
  document: number | null
  inbox: number | null
  link_basis: string
  /** The rule source mapping_version names; null for none. */
  mappingSource: string | null
  /** The verifikat the flow wrote that are linked to the event, by source type. */
  entries: readonly EntryRole[]
}

/** One scripted booking through a real door. */
interface Flow {
  name: string
  run: (seed: Seed) => Promise<Posted>
  events: ExpectedEvent[]
}

const STAGED = 'agent_proposed_user_approved'
const LINES = 'se.supplier-invoice-lines'
/** A domestic invoice at 25 %: 1 200 net, 300 moms. */
const DOMESTIC = {
  kind: 'purchase.registered',
  role: 'produced',
  party: 'domestic',
  currency: 'SEK',
  amount: 1500,
  amount_sek: 1500,
  vat: { treatment: 'standard_25', amount_sek: 300 },
  document: null,
  inbox: null,
  link_basis: 'user_created',
  mappingSource: LINES,
  entries: ['supplier_invoice_registered'],
} as const
const CREDITED = { ...DOMESTIC, kind: 'purchase.credited', entries: ['supplier_credit_note'] } as const
const STORNO = {
  kind: 'ledger.storno',
  role: 'reversal',
  occurred_on: 'today',
  party: null,
  currency: null,
  amount: null,
  amount_sek: null,
  vat: null,
  document: null,
  inbox: null,
  mappingSource: null,
  entries: ['storno'],
} as const

function ctxOf(seed: Seed): OperationContext {
  return { supabase: seed.supabase, companyId: seed.companyId, userId: seed.userId, log } as OperationContext
}

/** An underlag in the archive, not yet linked to anything. */
async function insertDocument(seed: Seed, fileName: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments (id, company_id, user_id, storage_path, file_name, sha256_hash, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf')`,
    [id, seed.companyId, seed.userId, `${seed.companyId}/${fileName}`, fileName, `sha-${fileName}`],
  )
  return id
}

/** An inbox item holding an underlag, as the upload leaves it. */
async function insertInboxItem(seed: Seed, documentId: string, extracted: Record<string, unknown>, supplierId?: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items (id, company_id, user_id, document_id, extracted_data, matched_supplier_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, seed.companyId, seed.userId, documentId, JSON.stringify(extracted), supplierId ?? null],
  )
  return id
}

async function stageOperation(seed: Seed, operationType: string, params: Record<string, unknown>): Promise<PendingOperation> {
  const { rows } = await getPool().query(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title, params)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [seed.userId, seed.companyId, operationType, operationType, JSON.stringify(params)],
  )
  return rows[0] as PendingOperation
}

async function approve(seed: Seed, op: PendingOperation): Promise<Record<string, unknown>> {
  const result = await commitPendingOperation(seed.supabase, seed.userId, seed.companyId, op, {
    commitMethod: 'user_accept',
    actor: { type: 'user' },
  })
  expect(result.status, JSON.stringify(result)).toBe('committed')
  return (result as { data?: Record<string, unknown> }).data ?? {}
}

/** A domestic invoice at 25 %: 1 000 on förbrukningsinventarier and 200 on kontorsmaterial. */
function domesticInvoice(seed: Seed, number: string, date: string, extra: Partial<CreateSupplierInvoiceInput> = {}): CreateSupplierInvoiceInput {
  return {
    supplier_id: seed.domestic,
    supplier_invoice_number: number,
    invoice_date: date,
    due_date: '2026-12-31',
    items: [
      { description: 'Skärmar', amount: 1000, account_number: '5410', vat_rate: 0.25 },
      { description: 'Pärmar', amount: 200, account_number: '6110', vat_rate: 0.25 },
    ],
    ...extra,
  } as CreateSupplierInvoiceInput
}

async function create(seed: Seed, body: CreateSupplierInvoiceInput): Promise<string> {
  const result = await createSupplierInvoice(ctxOf(seed), body)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok || result.dryRun) throw new Error('unreachable')
  return result.invoice.id as string
}

async function credit(seed: Seed, invoiceId: string, input: Parameters<typeof creditSupplierInvoice>[2]): Promise<string> {
  const result = await creditSupplierInvoice(ctxOf(seed), invoiceId, input)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok || result.dryRun) throw new Error('unreachable')
  return result.data.credit_note.id
}

/** A trigger that refuses to point one supplier invoice (by number) at its verifikat. */
async function failInvoiceLink(companyId: string, invoiceNumber: string): Promise<() => Promise<void>> {
  const fn = `pg_test_si_fail_link_${companyId.replace(/-/g, '')}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.company_id = '${companyId}'::uuid AND NEW.supplier_invoice_number = '${invoiceNumber.replace(/'/g, "''")}'
         AND OLD.registration_journal_entry_id IS NULL AND NEW.registration_journal_entry_id IS NOT NULL THEN
        RAISE EXCEPTION 'pg-test: invoice link refused';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE UPDATE ON public.supplier_invoices FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.supplier_invoices; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

async function setDeferred(seed: Seed, deferred: boolean): Promise<void> {
  await getPool().query(`UPDATE public.company_settings SET defer_invoice_booking = $2 WHERE company_id = $1`, [seed.companyId, deferred])
}

const FLOWS: Flow[] = [
  {
    name: 'registration: a domestic invoice at 25 % with its underlag posts its registration verifikat',
    run: async (seed) => {
      const documentId = await insertDocument(seed, 'faktura-1001.pdf')
      return {
        invoiceIds: [await create(seed, domesticInvoice(seed, 'F-1001', '2026-03-04', { document_id: documentId }))],
        documentIds: [documentId],
      }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-03-04', subject: 0, document: 0 }],
  },
  {
    name: 'registration: an EU supplier invoice in EUR under reverse charge self-assesses its moms',
    run: async (seed) => {
      const id = await create(seed, {
        supplier_id: seed.eu,
        supplier_invoice_number: 'EU-2026-17',
        invoice_date: '2026-03-10',
        due_date: '2026-04-09',
        currency: 'EUR',
        exchange_rate: 11.5,
        items: [
          { description: 'Hosting', amount: 150, account_number: '6540', vat_rate: 0, reverse_charge_rate: 0.25 },
          { description: 'Support', amount: 50, account_number: '6550', vat_rate: 0 },
        ],
      } as CreateSupplierInvoiceInput)
      return { invoiceIds: [id] }
    },
    // Omvänd skattskyldighet: the invoice states no moms; the self-assessed pair stays in the lines.
    events: [{ ...DOMESTIC, occurred_on: '2026-03-10', subject: 0, party: 'eu', currency: 'EUR', amount: 200, amount_sek: 2300, vat: null }],
  },
  {
    name: 'registration: an invoice registered inside a staged operation\'s approval',
    run: async (seed) =>
      runInOperationCommit(randomUUID(), async () => ({
        invoiceIds: [await create(seed, domesticInvoice(seed, 'F-1003', '2026-03-16'))],
      })),
    events: [{ ...DOMESTIC, occurred_on: '2026-03-16', subject: 0, link_basis: STAGED }],
  },
  {
    name: 'booking: an invoice registered without a verifikat is booked by the deferred Bokför step',
    run: async (seed) => {
      const documentId = await insertDocument(seed, 'faktura-1004.pdf')
      await setDeferred(seed, true)
      let id: string
      try {
        id = await create(seed, domesticInvoice(seed, 'F-1004', '2026-04-02', { document_id: documentId }))
      } finally {
        await setDeferred(seed, false)
      }
      const booked = await bookSupplierInvoice(ctxOf(seed), id)
      expect(booked.ok, JSON.stringify(booked)).toBe(true)
      return { invoiceIds: [id], documentIds: [documentId] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-04-02', subject: 0, document: 0 }],
  },
  {
    name: 'inbox: an inbox item converted to a supplier invoice with its underlag',
    run: async (seed) => {
      const documentId = await insertDocument(seed, 'inkorg-1005.pdf')
      const itemId = await insertInboxItem(seed, documentId, { documentKind: 'supplier_invoice' }, seed.domestic)
      const converted = await convertInboxItemToSupplierInvoice(ctxOf(seed), itemId, domesticInvoice(seed, 'F-1005', '2026-04-14'))
      expect(converted.ok, JSON.stringify(converted)).toBe(true)
      if (!converted.ok || converted.dryRun) throw new Error('unreachable')
      return { invoiceIds: [converted.data.invoice.id], documentIds: [documentId], inboxItemIds: [itemId] }
    },
    events: [{ ...DOMESTIC, occurred_on: '2026-04-14', subject: 0, document: 0, inbox: 0 }],
  },
  {
    name: 'inbox: a staged conversion of an inbox item approved',
    run: async (seed) => {
      const documentId = await insertDocument(seed, 'inkorg-1006.pdf')
      const itemId = await insertInboxItem(seed, documentId, { documentKind: 'supplier_invoice' }, seed.domestic)
      const op = await stageOperation(seed, 'create_supplier_invoice_from_inbox', {
        inbox_item_id: itemId,
        supplier_id: seed.domestic,
        document_id: documentId,
        supplier_invoice_number: 'F-1006',
        invoice_date: '2026-04-20',
        due_date: '2026-05-20',
        currency: 'SEK',
        vat_treatment: 'standard_25',
        items: [
          { description: 'Konsulttimmar', quantity: 4, unit_price: 950, line_total: 3800, account_number: '6550', vat_rate: 0.25, vat_amount: 950 },
        ],
        subtotal: 3800,
        vat_amount: 950,
        total: 4750,
      })
      const data = await approve(seed, op)
      return { invoiceIds: [data.supplier_invoice_id as string], documentIds: [documentId], inboxItemIds: [itemId] }
    },
    events: [
      {
        ...DOMESTIC,
        occurred_on: '2026-04-20',
        subject: 0,
        amount: 4750,
        amount_sek: 4750,
        vat: { treatment: 'standard_25', amount_sek: 950 },
        document: 0,
        inbox: 0,
        link_basis: STAGED,
      },
    ],
  },
  {
    name: 'credit: a registered invoice credited on the credit note\'s own date',
    run: async (seed) => {
      const id = await create(seed, domesticInvoice(seed, 'F-1007', '2026-05-04'))
      const creditNoteId = await credit(seed, id, { credit_date: '2026-05-20', supplier_credit_note_number: 'KF-1007' })
      return { invoiceIds: [id, creditNoteId] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-05-04', subject: 0 },
      { ...CREDITED, occurred_on: '2026-05-20', subject: 1 },
    ],
  },
  {
    name: 'credit: a credit note from the inbox, approved from a staged operation',
    run: async (seed) => {
      const id = await create(seed, domesticInvoice(seed, 'F-1008', '2026-06-01'))
      const documentId = await insertDocument(seed, 'kredit-1008.pdf')
      const itemId = await insertInboxItem(
        seed,
        documentId,
        {
          documentKind: 'credit_note',
          invoice: { invoiceNumber: 'KF-1008', invoiceDate: '2026-06-12', currency: 'SEK', creditedInvoiceNumber: 'F-1008' },
          totals: { total: 1500 },
        },
        seed.domestic,
      )
      await approve(seed, await stageOperation(seed, 'credit_supplier_invoice', { supplier_invoice_id: id, inbox_item_id: itemId }))
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id::text AS id FROM public.supplier_invoices WHERE credited_invoice_id = $1 AND is_credit_note`,
        [id],
      )
      return { invoiceIds: [id, rows[0]!.id], documentIds: [documentId], inboxItemIds: [itemId] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-06-01', subject: 0 },
      { ...CREDITED, occurred_on: '2026-06-12', subject: 1, document: 0, inbox: 0, link_basis: STAGED },
    ],
  },
  {
    name: 'uncredit: a credit undone with a storno of the credit verifikat',
    run: async (seed) => {
      const id = await create(seed, domesticInvoice(seed, 'F-1009', '2026-06-08'))
      const creditNoteId = await credit(seed, id, { credit_date: '2026-06-15', supplier_credit_note_number: 'KF-1009' })
      const undone = await uncreditSupplierInvoice(ctxOf(seed), id)
      expect(undone.ok, JSON.stringify(undone)).toBe(true)
      return { invoiceIds: [id, creditNoteId] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-06-08', subject: 0 },
      { ...CREDITED, occurred_on: '2026-06-15', subject: 1 },
      { ...STORNO, subject: 1, link_basis: 'user_created' },
    ],
  },
  {
    name: 'registration whose invoice link fails: the registration is reversed and the invoice kept as reversed',
    run: async (seed) => {
      const restore = await failInvoiceLink(seed.companyId, 'F-1010')
      try {
        const result = await createSupplierInvoice(ctxOf(seed), domesticInvoice(seed, 'F-1010', '2026-07-01'))
        expect(result).toMatchObject({ ok: false, code: 'SI_CREATE_FAILED', details: { step: 'registration_journal_entry_link' } })
      } finally {
        await restore()
      }
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id::text AS id FROM public.supplier_invoices WHERE company_id = $1 AND supplier_invoice_number = 'F-1010'`,
        [seed.companyId],
      )
      return { invoiceIds: [rows[0]!.id] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-07-01', subject: 0 },
      { ...STORNO, subject: 0, link_basis: 'system_derived' },
    ],
  },
  {
    name: 'credit whose credit note link fails: the credit verifikat is reversed and the credit note kept as reversed',
    run: async (seed) => {
      const id = await create(seed, domesticInvoice(seed, 'F-1011', '2026-07-06'))
      const restore = await failInvoiceLink(seed.companyId, 'KF-1011')
      try {
        const result = await creditSupplierInvoice(ctxOf(seed), id, { credit_date: '2026-07-20', supplier_credit_note_number: 'KF-1011' })
        expect(result).toMatchObject({ ok: false, code: 'SI_CREDIT_FAILED', details: { step: 'credit_journal_entry_link' } })
      } finally {
        await restore()
      }
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT id::text AS id FROM public.supplier_invoices WHERE credited_invoice_id = $1 AND is_credit_note`,
        [id],
      )
      return { invoiceIds: [id, rows[0]!.id] }
    },
    events: [
      { ...DOMESTIC, occurred_on: '2026-07-06', subject: 0 },
      { ...CREDITED, occurred_on: '2026-07-20', subject: 1 },
      { ...STORNO, subject: 1, link_basis: 'system_derived' },
    ],
  },
]

interface DumpLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  currency: string | null
  amount_in_currency: string | null
  exchange_rate: string | null
  line_description: string | null
  tax_code: string | null
  dimensions: unknown
  sort_order: number | null
}

interface DumpEntry {
  voucher_series: string
  voucher_number: number | null
  entry_date: string
  description: string
  source_type: string
  status: string
  notes: string | null
  lines: DumpLine[]
}

interface FlowDump {
  flow: string
  entries: DumpEntry[]
}

/** Every verifikat of the company, live or not, by id. */
async function entryIdsOf(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

/**
 * The verifikat a flow wrote, in series and number order, normalised: no ids,
 * no timestamps. A storno lists its original's lines in the order
 * reverseEntry reads them back (an unordered embed), so lines are compared
 * in account, amount, text and dimension order.
 */
async function dumpEntries(companyId: string, entryIds: string[]): Promise<Array<DumpEntry & { id: string }>> {
  const { rows } = await getPool().query<DumpEntry & { id: string }>(
    `SELECT je.id::text AS id, je.voucher_series, je.voucher_number, je.entry_date::text AS entry_date, je.description,
            je.source_type, je.status, je.notes,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'account_number', l.account_number,
                       'debit_amount', l.debit_amount::text,
                       'credit_amount', l.credit_amount::text,
                       'currency', l.currency,
                       'amount_in_currency', l.amount_in_currency::text,
                       'exchange_rate', l.exchange_rate::text,
                       'line_description', l.line_description,
                       'tax_code', l.tax_code,
                       'dimensions', l.dimensions,
                       'sort_order', NULL)
                     ORDER BY l.account_number, l.debit_amount, l.credit_amount, l.line_description, l.dimensions::text)
                FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = je.id
            ), '[]'::jsonb) AS lines
       FROM public.journal_entries je
      WHERE je.company_id = $1 AND je.id = ANY($2::uuid[])
      ORDER BY je.voucher_series, je.voucher_number NULLS LAST, je.entry_date, je.created_at`,
    [companyId, entryIds],
  )
  return rows
}

/** The supplier invoices, underlag and inbox items, which the doors write with the verifikat. */
async function registerOf(seed: Seed): Promise<unknown> {
  const [invoices, documents, inbox] = await Promise.all([
    getPool().query(
      `SELECT si.supplier_invoice_number, si.arrival_number, si.status, si.is_credit_note, o.supplier_invoice_number AS credits,
              si.invoice_date::text AS invoice_date, si.currency, si.exchange_rate::text AS exchange_rate,
              si.vat_treatment, si.reverse_charge, si.subtotal::text AS subtotal, si.vat_amount::text AS vat_amount,
              si.total::text AS total, si.total_sek::text AS total_sek, si.vat_amount_sek::text AS vat_amount_sek,
              si.remaining_amount::text AS remaining_amount,
              je.voucher_series AS registration_series, je.voucher_number AS registration_voucher, je.status AS registration_status,
              d.file_name AS document
         FROM public.supplier_invoices si
         LEFT JOIN public.supplier_invoices o ON o.id = si.credited_invoice_id
         LEFT JOIN public.journal_entries je ON je.id = si.registration_journal_entry_id
         LEFT JOIN public.document_attachments d ON d.id = si.document_id
        WHERE si.company_id = $1
        ORDER BY si.arrival_number`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT d.file_name, je.voucher_series, je.voucher_number, d.link_basis
         FROM public.document_attachments d
         LEFT JOIN public.journal_entries je ON je.id = d.journal_entry_id
        WHERE d.company_id = $1
        ORDER BY d.file_name`,
      [seed.companyId],
    ),
    getPool().query(
      `SELECT d.file_name, si.supplier_invoice_number AS converted_to
         FROM public.invoice_inbox_items i
         LEFT JOIN public.document_attachments d ON d.id = i.document_id
         LEFT JOIN public.supplier_invoices si ON si.id = i.created_supplier_invoice_id
        WHERE i.company_id = $1
        ORDER BY d.file_name`,
      [seed.companyId],
    ),
  ])
  return { invoices: invoices.rows, documents: documents.rows, inbox: inbox.rows }
}

interface FlowRun {
  seed: Seed
  dumps: FlowDump[]
  register: unknown
  posted: Array<Posted & { entries: Array<{ id: string; source_type: string; status: string }> }>
}

async function seedAll(): Promise<Seed> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  const supplier = async (name: string, type: string, currency: string) => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [userId, companyId, name, type, currency],
    )
    return rows[0]!.id
  }
  const domestic = await supplier('Kontorsbolaget AB', 'swedish_business', 'SEK')
  const eu = await supplier('Hosting GmbH', 'eu_business', 'EUR')
  return { userId, companyId, fiscalPeriodId, domestic, eu, supabase: createServiceClientNoCookies() }
}

async function runFlows(): Promise<FlowRun> {
  const seed = await seedAll()
  const dumps: FlowDump[] = []
  const posted: FlowRun['posted'] = []
  for (const flow of FLOWS) {
    const before = await entryIdsOf(seed.companyId)
    const result = await runWithActor({ type: 'user' }, () => flow.run(seed))
    const written = [...(await entryIdsOf(seed.companyId))].filter((id) => !before.has(id))
    const entries = await dumpEntries(seed.companyId, written)
    expect(entries.length, `${flow.name}: the flow wrote a verifikat`).toBeGreaterThan(0)
    posted.push({ ...result, entries: entries.map(({ id, source_type, status }) => ({ id, source_type, status })) })
    dumps.push({ flow: flow.name, entries: entries.map(({ id: _id, ...entry }) => entry) })
  }
  return { seed, dumps, register: await registerOf(seed), posted }
}

interface EventLinkRow {
  id: string
  kind: string
  category: string | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: string | null
  party_id: string | null
  currency: string | null
  amount: string | null
  amount_sek: string | null
  tax_amounts: Array<{ tax: string; treatment: string | null; amount_sek: number }>
  evidence: Record<string, unknown>
  pending_operation_id: string | null
  actor_type: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
  role: string | null
  journal_entry_id: string | null
  entry_status: string | null
}

/** Every event of the company, once per link, with the status of the verifikat each link points at. */
async function eventLinks(companyId: string): Promise<EventLinkRow[]> {
  const { rows } = await getPool().query<EventLinkRow>(
    `SELECT e.id::text AS id, e.kind, e.category, e.occurred_on::text AS occurred_on,
            e.subject_type, e.subject_id::text AS subject_id, e.party_type, e.party_id::text AS party_id,
            e.currency, e.amount::text AS amount, e.amount_sek::text AS amount_sek, e.tax_amounts, e.evidence,
            e.pending_operation_id::text AS pending_operation_id, e.actor_type, e.mapping_version, e.jurisdiction,
            e.idempotency_key, l.role, l.journal_entry_id::text AS journal_entry_id, je.status AS entry_status
       FROM public.business_events e
       LEFT JOIN public.business_event_entries l ON l.business_event_id = e.id
       LEFT JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE e.company_id = $1
      ORDER BY e.created_at, je.voucher_number`,
    [companyId],
  )
  return rows
}

/** Every verifikat of the company with how many event links each has. */
async function linkCounts(companyId: string): Promise<Array<{ id: string; status: string; links: number }>> {
  const { rows } = await getPool().query<{ id: string; status: string; links: number }>(
    `SELECT je.id::text AS id, je.status,
            (SELECT count(*)::int FROM public.business_event_entries l WHERE l.journal_entry_id = je.id) AS links
       FROM public.journal_entries je
      WHERE je.company_id = $1`,
    [companyId],
  )
  return rows
}

async function linksOf(entryId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.business_event_entries WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0]!.n
}

/** How many voucher numbers the company has drawn, over every series. */
async function lastVoucherNumber(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

/** The supplier invoice row by number, as the doors left it. */
async function invoiceRow(
  companyId: string,
  number: string,
): Promise<{ id: string; status: string; registration_journal_entry_id: string | null } | null> {
  const { rows } = await getPool().query<{ id: string; status: string; registration_journal_entry_id: string | null }>(
    `SELECT id::text AS id, status, registration_journal_entry_id::text AS registration_journal_entry_id
       FROM public.supplier_invoices WHERE company_id = $1 AND supplier_invoice_number = $2`,
    [companyId, number],
  )
  return rows[0] ?? null
}

/** A trigger that refuses every insert into `table`. */
async function failInserts(table: 'business_events' | 'business_event_entries'): Promise<() => Promise<void>> {
  const fn = `pg_test_si_fail_${table}`
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'pg-test: % refused', TG_TABLE_NAME;
    END; $$;
    CREATE TRIGGER ${fn} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`)
  return async () => {
    await getPool().query(`DROP TRIGGER IF EXISTS ${fn} ON public.${table}; DROP FUNCTION IF EXISTS public.${fn}();`)
  }
}

const LIVE = new Set(['draft', 'posted', 'reversed'])

/** Every flow books on a fresh company: well past the default test timeout on a busy machine. */
const FLOW_TIMEOUT = 240_000

describe('posting port parity, supplier invoices (pg)', () => {
  it('books the flows exactly as before the move, with POSTING_EVENTS off', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { dumps, register } = await runFlows()

    const recorded = { dumps, register }
    if (process.env.UPDATE_POSTING_PARITY_FIXTURE === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(recorded).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  })

  it('off writes no business event', { timeout: FLOW_TIMEOUT }, async () => {
    vi.stubEnv('POSTING_EVENTS', 'off')
    const { seed } = await runFlows()
    expect(await eventLinks(seed.companyId)).toEqual([])
    expect((await linkCounts(seed.companyId)).filter((e) => e.links > 0)).toEqual([])
  })

  it(
    'books the same verifikat with POSTING_EVENTS=shadow and links exactly one event to every verifikat a door wrote',
    { timeout: FLOW_TIMEOUT },
    async () => {
      vi.stubEnv('POSTING_EVENTS', 'off')
      const off = await runFlows()
      vi.stubEnv('POSTING_EVENTS', 'shadow')
      const shadow = await runFlows()

      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual({ dumps: off.dumps, register: off.register })
      expect({ dumps: shadow.dumps, register: shadow.register }).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))

      const { companyId } = shadow.seed
      // Every verifikat the moved producers wrote has exactly one link.
      const counts = await linkCounts(companyId)
      expect(counts.filter((e) => e.links !== 1)).toEqual([])
      expect(counts).toHaveLength(shadow.posted.reduce((n, p) => n + p.entries.length, 0))

      const links = await eventLinks(companyId)
      const eventIds = [...new Set(links.map((l) => l.id))]
      expect(eventIds).toHaveLength(FLOWS.reduce((n, f) => n + f.events.length, 0))
      const today = (await getPool().query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date::text AS d`)).rows[0]!.d
      const operations = new Set<string>()
      for (const [i, flow] of FLOWS.entries()) {
        const posted = shadow.posted[i]!
        // Every verifikat the flow wrote belongs to one of its events.
        const claimed = flow.events.flatMap((e) => e.entries)
        expect(posted.entries.map((e) => e.source_type).sort(), flow.name).toEqual([...claimed].sort())
        for (const [j, expected] of flow.events.entries()) {
          const label = `${flow.name} #${j}`
          const wanted = posted.entries.filter((e) => expected.entries.includes(e.source_type as EntryRole)).map((e) => e.id)
          const owners = [...new Set(links.filter((l) => wanted.includes(l.journal_entry_id!)).map((l) => l.id))]
          expect(owners, label).toHaveLength(1)
          const rows = links.filter((l) => l.id === owners[0])
          const live = rows.filter((l) => LIVE.has(l.entry_status ?? '')).map((l) => l.journal_entry_id)
          expect(new Set(live), label).toEqual(new Set(wanted))
          const event = rows[0]!
          const partyId = expected.party ? shadow.seed[expected.party] : null
          expect(event, label).toMatchObject({
            kind: expected.kind,
            role: expected.role,
            category: null,
            occurred_on: expected.occurred_on === 'today' ? today : expected.occurred_on,
            subject_type: 'supplier_invoice',
            subject_id: posted.invoiceIds[expected.subject],
            party_type: partyId ? 'supplier' : null,
            party_id: partyId,
            currency: expected.currency,
            tax_amounts: expected.vat ? [{ tax: 'vat', treatment: expected.vat.treatment, amount_sek: expected.vat.amount_sek }] : [],
            jurisdiction: 'SE',
            actor_type: 'user',
          })
          expect(rows.every((l) => l.role === expected.role), label).toBe(true)
          expect(event.amount === null ? null : Number(event.amount), label).toBe(expected.amount)
          expect(event.amount_sek === null ? null : Number(event.amount_sek), label).toBe(expected.amount_sek)
          expect(event.evidence.link_basis, label).toBe(expected.link_basis)
          expect(event.evidence.document_id ?? null, label).toBe(expected.document === null ? null : posted.documentIds![expected.document])
          expect(event.evidence.inbox_item_id ?? null, label).toBe(expected.inbox === null ? null : posted.inboxItemIds![expected.inbox])
          // References only: no supplier name in the evidence.
          expect(JSON.stringify(event.evidence)).not.toMatch(/Kontorsbolaget|Hosting GmbH/)
          if (expected.mappingSource) {
            expect(event.mapping_version?.startsWith(`${expected.mappingSource}@`), `${label}: ${event.mapping_version}`).toBe(true)
          } else {
            expect(event.mapping_version, label).toBeNull()
          }
          expect(event.idempotency_key, label).toBe(
            expected.kind === 'purchase.registered' ? `purchase.registered:supplier_invoice:${posted.invoiceIds[expected.subject]}` : null,
          )
          if (expected.link_basis === STAGED) {
            expect(event.pending_operation_id, label).toMatch(/^[0-9a-f-]{36}$/)
            expect(event.evidence.link_evidence, label).toEqual({ pending_operation_id: event.pending_operation_id })
            operations.add(event.pending_operation_id!)
          } else {
            expect(event.pending_operation_id, label).toBeNull()
          }
        }
      }
      // The staged create, the staged inbox conversion and the staged credit.
      expect(operations.size).toBe(3)
    },
  )

  it(
    'shadow posts through a failed event or link write; strict stops before a voucher number is drawn',
    { timeout: FLOW_TIMEOUT },
    async () => {
      const seed = await seedAll()
      const { companyId } = seed
      const asUser = <T>(fn: () => Promise<T>) => runWithActor({ type: 'user' }, fn)
      const ctx = ctxOf(seed)
      let n = 0
      const nextNumber = () => `FAIL-${++n}`
      const registerDeferred = async (number: string, date: string) => {
        await setDeferred(seed, true)
        try {
          return await asUser(() => create(seed, domesticInvoice(seed, number, date)))
        } finally {
          await setDeferred(seed, false)
        }
      }
      const registrationOf = async (number: string) => (await invoiceRow(companyId, number))?.registration_journal_entry_id ?? null

      for (const table of ['business_events', 'business_event_entries'] as const) {
        // Shadow: every door posts, without the event (or its link).
        vi.stubEnv('POSTING_EVENTS', 'shadow')
        const before = await lastVoucherNumber(companyId)
        const creditedNumber = nextNumber()
        const credited = await asUser(() => create(seed, domesticInvoice(seed, creditedNumber, '2026-08-03')))
        const deferredNumber = nextNumber()
        const deferred = await registerDeferred(deferredNumber, '2026-08-04')
        const documentId = await insertDocument(seed, `${table}-inkorg.pdf`)
        const itemId = await insertInboxItem(seed, documentId, { documentKind: 'supplier_invoice' }, seed.domestic)
        const registeredNumber = nextNumber()
        const convertedNumber = nextNumber()
        const restore = await failInserts(table)
        const written: Array<string | null> = []
        try {
          await asUser(() => create(seed, domesticInvoice(seed, registeredNumber, '2026-08-05')))
          const booked = await asUser(() => bookSupplierInvoice(ctx, deferred))
          expect(booked.ok, JSON.stringify(booked)).toBe(true)
          const converted = await asUser(() => convertInboxItemToSupplierInvoice(ctx, itemId, domesticInvoice(seed, convertedNumber, '2026-08-06')))
          expect(converted.ok, JSON.stringify(converted)).toBe(true)
          const creditNoteId = await asUser(() => credit(seed, credited, { credit_date: '2026-08-07' }))
          const undone = await asUser(() => uncreditSupplierInvoice(ctx, credited))
          expect(undone.ok, JSON.stringify(undone)).toBe(true)
          if (!undone.ok || undone.dryRun) throw new Error('unreachable')
          const { rows: creditRows } = await getPool().query<{ id: string | null }>(
            `SELECT registration_journal_entry_id::text AS id FROM public.supplier_invoices WHERE id = $1`,
            [creditNoteId],
          )
          written.push(
            await registrationOf(registeredNumber),
            await registrationOf(deferredNumber),
            await registrationOf(convertedNumber),
            creditRows[0]!.id,
            undone.data.reversal_entry_id,
          )
        } finally {
          await restore()
        }
        for (const id of written) {
          expect(id, table).toBeTruthy()
          expect(await linksOf(id!), table).toBe(0)
        }
        // The first registration (before the refusal), then the five above.
        expect(await lastVoucherNumber(companyId), table).toBe(before + 6)

        // Strict: each door stops before a voucher number is drawn.
        const strictDeferredNumber = nextNumber()
        const strictDeferred = await registerDeferred(strictDeferredNumber, '2026-08-10')
        const toCredit = await asUser(() => create(seed, domesticInvoice(seed, nextNumber(), '2026-08-11')))
        const toUncredit = await asUser(() => create(seed, domesticInvoice(seed, nextNumber(), '2026-08-12')))
        await asUser(() => credit(seed, toUncredit, { credit_date: '2026-08-13' }))
        const strictDocument = await insertDocument(seed, `${table}-strict.pdf`)
        const strictItem = await insertInboxItem(seed, strictDocument, { documentKind: 'supplier_invoice' }, seed.domestic)
        const restoreStrict = await failInserts(table)
        try {
          vi.stubEnv('POSTING_EVENTS', 'strict')
          const drawn = await lastVoucherNumber(companyId)

          const refusedNumber = nextNumber()
          const refused = await asUser(() => createSupplierInvoice(ctx, domesticInvoice(seed, refusedNumber, '2026-08-14')))
          expect(refused, table).toMatchObject({ ok: false, code: 'SI_CREATE_FAILED' })
          // Nothing reached the books, so the invoice row is removed.
          expect(await invoiceRow(companyId, refusedNumber), table).toBeNull()

          const refusedBook = await asUser(() => bookSupplierInvoice(ctx, strictDeferred))
          expect(refusedBook, table).toMatchObject({ ok: false, code: 'SI_BOOK_FAILED' })
          expect(await registrationOf(strictDeferredNumber), table).toBeNull()

          const refusedConvert = await asUser(() =>
            convertInboxItemToSupplierInvoice(ctx, strictItem, domesticInvoice(seed, nextNumber(), '2026-08-15')),
          )
          expect(refusedConvert, table).toMatchObject({ ok: false, code: 'SI_CREATE_FAILED' })

          const refusedCredit = await asUser(() => creditSupplierInvoice(ctx, toCredit, { credit_date: '2026-08-16' }))
          expect(refusedCredit, table).toMatchObject({ ok: false, code: 'SI_CREDIT_FAILED' })

          const refusedUncredit = await asUser(() => uncreditSupplierInvoice(ctx, toUncredit))
          expect(refusedUncredit, table).toMatchObject({ ok: false, code: 'SI_UNCREDIT_FAILED' })

          expect(await lastVoucherNumber(companyId), table).toBe(drawn)
        } finally {
          await restoreStrict()
          vi.stubEnv('POSTING_EVENTS', 'shadow')
        }
      }

      // With nothing refused, strict registers and credits with their events,
      // the next numbers in the series: none of the refusals above left a gap.
      vi.stubEnv('POSTING_EVENTS', 'strict')
      const before = await lastVoucherNumber(companyId)
      const strictInvoice = await asUser(() => create(seed, domesticInvoice(seed, nextNumber(), '2026-08-20')))
      await asUser(() => credit(seed, strictInvoice, { credit_date: '2026-08-21' }))
      expect(await lastVoucherNumber(companyId)).toBe(before + 2)
      const strictEntries = await getPool().query<{ id: string }>(
        `SELECT je.id::text AS id FROM public.journal_entries je JOIN public.supplier_invoices si ON si.registration_journal_entry_id = je.id
          WHERE si.id = $1 OR si.credited_invoice_id = $1`,
        [strictInvoice],
      )
      expect(strictEntries.rows).toHaveLength(2)
      for (const row of strictEntries.rows) expect(await linksOf(row.id)).toBe(1)
      for (const series of ['A', 'D']) {
        const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, $3)`, [companyId, seed.fiscalPeriodId, series])
        expect(gaps.rows, series).toEqual([])
      }
    },
  )
})
