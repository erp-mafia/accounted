/**
 * Byt leverantör on real Postgres: an invoice registered on the wrong
 * supplier, booked under faktureringsmetoden, moved to the right one through
 * the agent's door (gnubok_change_supplier_invoice_supplier, staged and
 * approved as a person approves it in the app).
 *
 * The registration verifikat's text is corrected inside the same verifikat
 * by the real correct_entry_metadata RPC: the new text stands, the old one is
 * kept in journal_entry_rattelse_log with who and when, and no line, amount
 * or voucher number moves. Past the company's lock date the same change is
 * refused and nothing moves, the invoice included; an attested invoice is
 * refused the same way.
 *
 * What is not real: the HTTP hop to PostgREST (tests/pg/postgrest-over-pg.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@/extensions/general/mcp-server/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { eventBus } from '@/lib/events/bus'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { changeSupplierInvoiceSupplier } from '@/lib/supplier-invoices/change-supplier'
import type { PendingOperation } from '@/types'
import { seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

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

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never

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

const ctx = (s: Seed) => ({ supabase: s.supabase, companyId: s.companyId, userId: s.userId, log })

/** Registered and booked on the wrong supplier. */
async function registeredOnTheWrongSupplier(s: Seed): Promise<{ invoiceId: string; entryId: string }> {
  const body = CreateSupplierInvoiceSchema.parse({
    supplier_id: s.wrong,
    supplier_invoice_number: 'F-2041',
    invoice_date: '2026-03-02',
    due_date: '2099-04-01',
    items: [{ description: 'Abonnemang', amount: 1000, account_number: '6200', vat_rate: 0.25 }],
  })
  const created = await runWithActor({ type: 'user' }, () => createSupplierInvoice(ctx(s), body))
  expect(created.ok, JSON.stringify(created)).toBe(true)
  const invoiceId = created.ok && !created.dryRun ? (created.invoice.id as string) : ''
  const { rows } = await getPool().query<{ registration_journal_entry_id: string }>(
    `SELECT registration_journal_entry_id::text FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  expect(rows[0]!.registration_journal_entry_id).toBeTruthy()
  return { invoiceId, entryId: rows[0]!.registration_journal_entry_id }
}

async function entry(id: string) {
  const { rows } = await getPool().query<{ description: string; voucher_number: number; status: string }>(
    `SELECT description, voucher_number, status FROM public.journal_entries WHERE id = $1`,
    [id],
  )
  const { rows: lines } = await getPool().query<{ account_number: string; debit_amount: string; credit_amount: string }>(
    `SELECT account_number, debit_amount::text, credit_amount::text FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number`,
    [id],
  )
  return { ...rows[0]!, lines }
}

async function supplierOf(invoiceId: string): Promise<string> {
  const { rows } = await getPool().query<{ supplier_id: string }>(`SELECT supplier_id::text FROM public.supplier_invoices WHERE id = $1`, [invoiceId])
  return rows[0]!.supplier_id
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

describe('Byt leverantör', () => {
  it('the agent moves a booked invoice to the right supplier: the verifikat text is corrected in place, logged, and nothing else moves', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { invoiceId, entryId } = await registeredOnTheWrongSupplier(s)
    const before = await entry(entryId)
    expect(before.description).toBe(`Leverantörsfaktura F-2041, Fel Leverantör AB (ankomstnr ${before.description.match(/ankomstnr (\d+)/)![1]})`)

    const tool = tools.find((candidate) => candidate.name === 'gnubok_change_supplier_invoice_supplier')!
    const staged = (await tool.execute(
      { supplier_invoice_id: invoiceId, supplier_id: s.right, __keyScopes: [] } as never,
      s.companyId,
      s.userId,
      s.supabase as never,
      { type: 'api_key' } as never,
    )) as { operation_id: string }
    // The preview wrote nothing.
    expect(await supplierOf(invoiceId)).toBe(s.wrong)

    const { rows: op } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [staged.operation_id])
    expect(op[0]).toMatchObject({ operation_type: 'change_supplier_invoice_supplier', risk_level: 'high' })
    const approved = await runWithActor({ type: 'user' }, () =>
      commitPendingOperation(s.supabase, s.userId, s.companyId, op[0] as PendingOperation, { commitMethod: 'user_accept', actor: { type: 'user' } }),
    )
    expect(approved.status, JSON.stringify(approved)).toBe('committed')

    expect(await supplierOf(invoiceId)).toBe(s.right)
    const after = await entry(entryId)
    expect(after.description).toBe(before.description.replace('Fel Leverantör AB', 'Rätt Leverantör AB'))
    // Same verifikat, same number, same lines.
    expect({ voucher: after.voucher_number, status: after.status, lines: after.lines }).toEqual({
      voucher: before.voucher_number,
      status: 'posted',
      lines: before.lines,
    })
    const { rows: logged } = await getPool().query<{ rattelse_type: string; old_description: string; new_description: string; actor: string }>(
      `SELECT rattelse_type, old_description, new_description, actor::text FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(logged).toEqual([
      expect.objectContaining({ old_description: before.description, new_description: after.description, actor: s.userId }),
    ])
  })

  it('past the lock date the change is refused and nothing moves: a credit is the way', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { invoiceId, entryId } = await registeredOnTheWrongSupplier(s)
    const before = await entry(entryId)
    await getPool().query(`UPDATE public.company_settings SET bookkeeping_locked_through = '2026-03-31' WHERE company_id = $1`, [s.companyId])

    for (const dryRun of [true, false]) {
      const outcome = await runWithActor({ type: 'user' }, () => changeSupplierInvoiceSupplier(ctx(s), invoiceId, s.right, { dryRun }))
      expect(outcome).toMatchObject({ ok: false, code: 'SI_CHANGE_SUPPLIER_PERIOD_LOCKED' })
    }
    expect(await supplierOf(invoiceId)).toBe(s.wrong)
    expect((await entry(entryId)).description).toBe(before.description)
    const { rows: logged } = await getPool().query(`SELECT 1 FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1`, [entryId])
    expect(logged).toEqual([])
  })

  it('an attested invoice is refused: the attest was given for the other supplier', { timeout: 90_000 }, async () => {
    const s = await seed()
    const { invoiceId } = await registeredOnTheWrongSupplier(s)
    // The attest service sets the mark through attest_supplier_invoice; a
    // direct write stands in for it here, in this one session with the
    // triggers that refuse it to a session off.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL session_replication_role = replica`)
      await client.query(`UPDATE public.supplier_invoices SET approved_at = now(), approved_by = $2, status = 'approved' WHERE id = $1`, [invoiceId, s.userId])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const outcome = await changeSupplierInvoiceSupplier(ctx(s), invoiceId, s.right)
    expect(outcome).toMatchObject({ ok: false, code: 'SI_CHANGE_SUPPLIER_ATTESTED' })
    expect(await supplierOf(invoiceId)).toBe(s.wrong)
  })
})
