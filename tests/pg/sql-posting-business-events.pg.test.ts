/**
 * Covers the posting port's SQL step: migrations 20261018210000 (the link
 * helper) and 20261018210100 to 20261018210600, where the six SQL posting
 * functions take the port's event ids and link them to the drafts they
 * write before commit_journal_entry draws the number.
 *
 * For every function, on the installed definitions:
 *   - one signature, the two parameters last and defaulted, SECURITY DEFINER,
 *     search_path, grants (authenticated and service_role, not anon or
 *     PUBLIC) and comment as before;
 *   - the old call shape (the named parameters the deployed code sends
 *     through PostgREST, and the positional calls in SQL) still resolves and
 *     books exactly as before: no link;
 *   - with ids under shadow, each draft the function writes carries its
 *     events (role by position for the IB replacement) and no other
 *     verifikat gets a link;
 *   - a refused link (an event of another company) under shadow still
 *     books, without the link;
 *   - under strict it raises, nothing is booked and no voucher number is
 *     drawn;
 *   - detect_voucher_gaps finds no gap.
 * The doors on top (the callers recording the events through the port) are
 * covered by posting-parity-sql-producers.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool, runAsServiceRole } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

interface Company {
  userId: string
  companyId: string
  periodId: string
  period2027: string
  customerId: string
  supplierId: string
}

async function seed(): Promise<Company> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const pool = getPool()
  await pool.query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, accounting_method, vat_registered)
     VALUES ($1, $2, 'aktiebolag', 'accrual', true)`,
    [userId, companyId],
  )
  const period2027 = await insertFiscalPeriod({ userId, companyId, name: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31' })
  await pool.query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     VALUES ($1, $2, '1930', 'Företagskonto', 1, 'asset', 'debit', true),
            ($1, $2, '1510', 'Kundfordringar', 1, 'asset', 'debit', true),
            ($1, $2, '2010', 'Eget kapital', 2, 'equity', 'credit', true),
            ($1, $2, '2440', 'Leverantörsskulder', 2, 'liability', 'credit', true),
            ($1, $2, '2893', 'Skuld till aktieägare', 2, 'liability', 'credit', true),
            ($1, $2, '6570', 'Bankkostnader', 6, 'expense', 'debit', true)`,
    [userId, companyId],
  )
  const customer = await pool.query<{ id: string }>(
    `INSERT INTO public.customers (user_id, company_id, name, customer_type) VALUES ($1, $2, 'Kund AB', 'swedish_business') RETURNING id::text AS id`,
    [userId, companyId],
  )
  const supplier = await pool.query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type, default_currency)
     VALUES ($1, $2, 'Leverantör AB', 'swedish_business', 'SEK') RETURNING id::text AS id`,
    [userId, companyId],
  )
  return { userId, companyId, periodId: fiscalPeriodId, period2027, customerId: customer.rows[0]!.id, supplierId: supplier.rows[0]!.id }
}

/** A business event recorded as the port records it. */
async function insertEvent(companyId: string, kind = 'bank.categorized'): Promise<string> {
  const id = randomUUID()
  await getPool().query(`INSERT INTO public.business_events (id, company_id, kind, occurred_on) VALUES ($1, $2, $3, '2026-05-05')`, [
    id,
    companyId,
    kind,
  ])
  return id
}

async function insertTx(c: Company, amount: number, date = '2026-05-05'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, company_id, user_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, 'Bankrad', $5, 'SEK', 'uncategorized')`,
    [id, c.companyId, c.userId, date, amount],
  )
  return id
}

/** A posted verifikat written as the engine does (draft, lines, commit_journal_entry). */
async function postedVoucher(c: Company, debit: string, credit: string, amount: number, date = '2026-05-05'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Betalning', 'manual', 'draft')`,
    [id, c.userId, c.companyId, c.periodId, date],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
     VALUES ($1, $2, $4, 0, 'SEK', 0), ($1, $3, 0, $4, 'SEK', 1)`,
    [id, debit, credit, amount],
  )
  await getPool().query('SELECT * FROM public.commit_journal_entry($1, $2)', [c.companyId, id])
  return id
}

async function customerInvoice(c: Company, currency: string, rate: number | null, total: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01', $6, $7, $8, 0, $8, $9, 'standard_25', 25, 'sent', 0, $8)`,
    [id, c.userId, c.companyId, c.customerId, `F-${id.slice(0, 8)}`, currency, rate, total, rate ? total * rate : total],
  )
  return id
}

async function supplierInvoice(c: Company, currency: string, rate: number | null, total: number): Promise<string> {
  const id = randomUUID()
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(max(arrival_number), 0)::int + 1 AS n FROM public.supplier_invoices WHERE company_id = $1`,
    [c.companyId],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', $7, $8,
             $9, 0, $9, 0, $9, 'standard_25', false, false)`,
    [id, c.userId, c.companyId, c.supplierId, rows[0]!.n, `LF-${rows[0]!.n}`, currency, rate, total],
  )
  return id
}

async function expenseClaim(c: Company, amount: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
     VALUES ($1, $2, $3, 'Ägaren', 'Kvitto', '2026-05-01', $4, 0, '5410', '2893', 'registered')`,
    [id, c.companyId, c.userId, amount],
  )
  return id
}

/** A posted IB on 2027 that the replacement can replace, and replacement lines for it. */
async function openingBalance(c: Company): Promise<{ oldEntryId: string; lines: Array<Record<string, unknown>> }> {
  const accounts = await getPool().query<{ id: string; account_number: string }>(
    `SELECT id::text, account_number FROM public.chart_of_accounts WHERE company_id = $1 AND account_number IN ('1930', '2010')`,
    [c.companyId],
  )
  const accountId = new Map(accounts.rows.map((a) => [a.account_number, a.id]))
  const oldEntryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2027-01-01', 'Ingående balanser', 'opening_balance', 'draft')`,
    [oldEntryId, c.userId, c.companyId, c.period2027],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, account_id, debit_amount, credit_amount, currency, sort_order)
     VALUES ($1, '1930', $2, 100, 0, 'SEK', 0), ($1, '2010', $3, 0, 100, 'SEK', 1)`,
    [oldEntryId, accountId.get('1930'), accountId.get('2010')],
  )
  await getPool().query('SELECT * FROM public.commit_journal_entry($1, $2)', [c.companyId, oldEntryId])
  await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $1, opening_balances_set = true WHERE id = $2`, [
    oldEntryId,
    c.period2027,
  ])
  const line = (account: string, debit: number, credit: number, sort: number) => ({
    account_number: account,
    account_id: accountId.get(account),
    debit_amount: debit,
    credit_amount: credit,
    currency: 'SEK',
    amount_in_currency: null,
    exchange_rate: null,
    line_description: `IB ${account}`,
    tax_code: null,
    dimensions: {},
    sort_order: sort,
  })
  return { oldEntryId, lines: [line('1930', 150, 0, 0), line('2010', 0, 150, 1)] }
}

/** A named argument: name, value, SQL type. */
type Arg = [name: string, value: unknown, type: string]

/** One booking through a function: the old call's named arguments, and what it drafts. */
interface Call {
  fn: string
  args: Arg[]
  /** RETURNS TABLE (SELECT * FROM) rather than jsonb. */
  table?: boolean
  /** How many events the call links (to every draft, or by position for the IB replacement). */
  events: number
  /** How many verifikat it drafts and posts. */
  drafts: number
}

function sqlOf(call: Call, extra: Arg[]): { text: string; values: unknown[] } {
  const all = [...call.args, ...extra]
  const named = all.map(([name, , type], i) => `${name} => $${i + 1}::${type}`).join(', ')
  const values = all.map(([, value, type]) => (type === 'jsonb' && value !== null ? JSON.stringify(value) : value))
  return { text: call.table ? `SELECT * FROM public.${call.fn}(${named})` : `SELECT public.${call.fn}(${named}) AS r`, values }
}

/** The scenarios, each preparing a fresh booking per run. */
const SCENARIOS: Array<{ name: string; prepare: (c: Company) => Promise<Call> }> = [
  {
    name: 'bulk_book_transactions: a new samlingsverifikat of two bank lines',
    prepare: async (c) => {
      const tx = [await insertTx(c, -50), await insertTx(c, -75)]
      return {
        fn: 'bulk_book_transactions',
        args: [
          ['p_tx_ids', tx, 'uuid[]'],
          ['p_existing_journal_entry_id', null, 'uuid'],
          [
            'p_new_entry',
            {
              description: 'Bankavgifter',
              lines: [
                { account_number: '6570', debit_amount: 125, credit_amount: 0 },
                { account_number: '1930', debit_amount: 0, credit_amount: 125 },
              ],
            },
            'jsonb',
          ],
          ['p_company_id', c.companyId, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
          ['p_actor_type', 'user', 'text'],
        ],
        events: 2,
        drafts: 1,
      }
    },
  },
  {
    name: 'bulk_book_transactions: rows linked to a posted verifikat (nothing drafted)',
    prepare: async (c) => {
      const voucher = await postedVoucher(c, '6570', '1930', 100)
      const tx = [await insertTx(c, -40), await insertTx(c, -60)]
      return {
        fn: 'bulk_book_transactions',
        args: [
          ['p_tx_ids', tx, 'uuid[]'],
          ['p_existing_journal_entry_id', voucher, 'uuid'],
          ['p_new_entry', null, 'jsonb'],
          ['p_company_id', c.companyId, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
        ],
        events: 2,
        drafts: 0,
      }
    },
  },
  {
    name: 'match_batch_allocate: a deposit against two customer invoices',
    prepare: async (c) => {
      const first = await customerInvoice(c, 'SEK', null, 300)
      const second = await customerInvoice(c, 'SEK', null, 200)
      const tx = await insertTx(c, 500)
      return {
        fn: 'match_batch_allocate',
        args: [
          ['p_tx_id', tx, 'uuid'],
          [
            'p_allocations',
            [
              { kind: 'customer_invoice', invoice_id: first, amount: 300 },
              { kind: 'customer_invoice', invoice_id: second, amount: 200 },
            ],
            'jsonb',
          ],
          ['p_company_id', c.companyId, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
        ],
        events: 2,
        drafts: 1,
      }
    },
  },
  {
    name: 'link_invoice_to_voucher: a EUR invoice settled at another rate (kursdifferens)',
    prepare: async (c) => {
      const invoice = await customerInvoice(c, 'EUR', 11.5, 1000)
      const voucher = await postedVoucher(c, '1930', '1510', 11200)
      return {
        fn: 'link_invoice_to_voucher',
        args: [
          ['p_invoice_id', invoice, 'uuid'],
          ['p_journal_entry_id', voucher, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
          ['p_company_id', c.companyId, 'uuid'],
          ['p_notes', null, 'text'],
        ],
        events: 1,
        drafts: 1,
      }
    },
  },
  {
    name: 'link_invoice_to_voucher: a SEK invoice (nothing drafted)',
    prepare: async (c) => {
      const invoice = await customerInvoice(c, 'SEK', null, 900)
      const voucher = await postedVoucher(c, '1930', '1510', 900)
      return {
        fn: 'link_invoice_to_voucher',
        args: [
          ['p_invoice_id', invoice, 'uuid'],
          ['p_journal_entry_id', voucher, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
          ['p_company_id', c.companyId, 'uuid'],
        ],
        events: 1,
        drafts: 0,
      }
    },
  },
  {
    name: 'link_supplier_invoice_to_voucher: a EUR invoice paid at another rate (kursdifferens)',
    prepare: async (c) => {
      const invoice = await supplierInvoice(c, 'EUR', 11.5, 1000)
      const voucher = await postedVoucher(c, '2440', '1930', 11200)
      return {
        fn: 'link_supplier_invoice_to_voucher',
        args: [
          ['p_supplier_invoice_id', invoice, 'uuid'],
          ['p_journal_entry_id', voucher, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
          ['p_company_id', c.companyId, 'uuid'],
          ['p_notes', null, 'text'],
        ],
        events: 1,
        drafts: 1,
      }
    },
  },
  {
    name: 'create_expense_payout_batch: two claims repaid',
    prepare: async (c) => {
      const claims = [await expenseClaim(c, 500), await expenseClaim(c, 300)]
      return {
        fn: 'create_expense_payout_batch',
        args: [
          ['p_company_id', c.companyId, 'uuid'],
          ['p_claim_ids', claims, 'uuid[]'],
          ['p_payout_date', '2026-05-06', 'date'],
          ['p_cash_account', '1930', 'text'],
          ['p_user_id', c.userId, 'uuid'],
        ],
        events: 2,
        drafts: 1,
      }
    },
  },
  {
    name: 'commit_opening_balance_replacement: a new IB and the storno of the old',
    prepare: async (c) => {
      const { oldEntryId, lines } = await openingBalance(c)
      return {
        fn: 'commit_opening_balance_replacement',
        table: true,
        args: [
          ['p_company_id', c.companyId, 'uuid'],
          ['p_period_id', c.period2027, 'uuid'],
          ['p_expected_old_entry_id', oldEntryId, 'uuid'],
          ['p_user_id', c.userId, 'uuid'],
          ['p_entry_date', '2027-01-01', 'date'],
          ['p_description', 'Ingående balanser (korrigerade)', 'text'],
          ['p_voucher_series', 'A', 'text'],
          ['p_lines', lines, 'jsonb'],
        ],
        events: 2,
        drafts: 2,
      }
    },
  },
]

async function entryIds(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text AS id FROM public.journal_entries WHERE company_id = $1`, [companyId])
  return new Set(rows.map((r) => r.id))
}

async function drawn(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT coalesce(sum(last_number), 0)::int AS n FROM public.voucher_sequences WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!.n
}

async function links(companyId: string): Promise<Array<{ event: string; entry: string; role: string; status: string; source_type: string }>> {
  const { rows } = await getPool().query(
    `SELECT l.business_event_id::text AS event, l.journal_entry_id::text AS entry, l.role, je.status, je.source_type
       FROM public.business_event_entries l JOIN public.journal_entries je ON je.id = l.journal_entry_id
      WHERE l.company_id = $1`,
    [companyId],
  )
  return rows
}

/** The call as the service role (the v1, MCP and approval doors), committed; its answer. */
async function run(call: Call, extra: Arg[] = []): Promise<Record<string, unknown>> {
  const { text, values } = sqlOf(call, extra)
  return runAsServiceRole(async (client: PoolClient) => {
    const { rows } = await client.query(text, values)
    return (call.table ? rows[0] : rows[0]?.r) as Record<string, unknown>
  })
}

function booked(call: Call, answer: Record<string, unknown>): void {
  if (call.table) expect(answer.new_entry_id).toBeTruthy()
  else expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true })
}

describe('link_business_events_to_draft (20261018210000)', () => {
  it('no API role may call it, and it runs as its caller', async () => {
    const { rows } = await getPool().query(
      `SELECT p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
         FROM pg_proc p WHERE p.oid = 'public.link_business_events_to_draft(uuid, uuid, uuid[], text, text)'::regprocedure`,
    )
    expect(rows).toEqual([{ definer: false, anon: false, authenticated: false, service_role: false }])
  })

  it('links nothing without ids, each id once, raises under strict and logs under shadow', async () => {
    const c = await seed()
    const other = await seed()
    const client = await getClient()
    const warnings: string[] = []
    client.on('notice', (msg) => {
      if (msg.severity === 'WARNING') warnings.push(msg.message ?? '')
    })
    try {
      await client.query('BEGIN')
      const draft = randomUUID()
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-05-05', 'Utkast', 'manual', 'draft')`,
        [draft, c.userId, c.companyId, c.periodId],
      )
      const event = randomUUID()
      await client.query(`INSERT INTO public.business_events (id, company_id, kind, occurred_on) VALUES ($1, $2, 'ledger.manual', '2026-05-05')`, [
        event,
        c.companyId,
      ])
      const foreign = randomUUID()
      await client.query(`INSERT INTO public.business_events (id, company_id, kind, occurred_on) VALUES ($1, $2, 'ledger.manual', '2026-05-05')`, [
        foreign,
        other.companyId,
      ])
      const link = async (ids: Array<string | null> | null, mode: string | null, role = 'produced') =>
        (
          await client.query<{ n: number }>(`SELECT public.link_business_events_to_draft($1, $2, $3::uuid[], $4, $5) AS n`, [
            c.companyId,
            draft,
            ids,
            role,
            mode,
          ])
        ).rows[0]!.n
      const count = async () =>
        (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.business_event_entries WHERE journal_entry_id = $1`, [draft])).rows[0]!.n

      expect(await link(null, 'strict')).toBe(0)
      expect(await link([], 'strict')).toBe(0)
      expect(await link([null], 'strict')).toBe(0)
      expect(await count()).toBe(0)

      // Shadow: another company's event is refused by the link guard, logged, nothing written.
      expect(await link([foreign], 'shadow')).toBe(0)
      expect(await link([foreign], null)).toBe(0)
      expect(warnings).toHaveLength(2)
      expect(warnings[0]).toContain('business event link not written (shadow)')
      expect(await count()).toBe(0)

      // Each id once.
      expect(await link([event, event, null], 'shadow')).toBe(1)
      expect(await count()).toBe(1)

      // Strict: the refusal raises.
      await client.query('SAVEPOINT strict')
      await expect(link([foreign], 'strict')).rejects.toThrow(/BUSINESS_EVENT_LINK_COMPANY_MISMATCH/)
      await client.query('ROLLBACK TO SAVEPOINT strict')
      expect(await count()).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('the six SQL posting functions: signature, security, grants and comment', () => {
  it.each([
    ['bulk_book_transactions', 'bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid,text,text,text,uuid[],text)', 'samlingsverifikation'],
    ['match_batch_allocate', 'match_batch_allocate(uuid,jsonb,uuid,uuid,text,text,jsonb,jsonb,jsonb,uuid[],text)', 'samlingsverifikat'],
    ['link_invoice_to_voucher', 'link_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text)', 'customer invoice as its payment'],
    [
      'link_supplier_invoice_to_voucher',
      'link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text,text)',
      'OPEN supplier invoice',
    ],
    ['create_expense_payout_batch', 'create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid,text,text,uuid[],text)', 'reimbursement transfer'],
    [
      'commit_opening_balance_replacement',
      'commit_opening_balance_replacement(uuid,uuid,uuid,uuid,date,text,text,jsonb,text,text,uuid[],text)',
      'opening balance',
    ],
  ])('%s', async (name, signature, phrase) => {
    const { rows } = await getPool().query(
      `SELECT p.oid::regprocedure::text AS sig,
              p.prosecdef AS definer,
              p.proconfig AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec,
              (SELECT array_agg(n) FROM unnest(p.proargnames) n WHERE n LIKE 'p_event_%') AS event_params,
              pg_get_function_arguments(p.oid) AS args,
              obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
      [name],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sig: signature,
      definer: true,
      config: ['search_path=public'],
      anon: false,
      authenticated: true,
      service_role: true,
      public_exec: false,
      event_params: ['p_event_ids', 'p_event_mode'],
    })
    expect(rows[0].args).toMatch(/p_event_ids uuid\[\] DEFAULT NULL::uuid\[\], p_event_mode text DEFAULT NULL::text(, p_link_basis text DEFAULT 'user_confirmed'::text)?$/)
    expect(rows[0].comment).toContain(phrase)
    expect(rows[0].comment).toContain('p_event_ids')
  })
})

describe.each(SCENARIOS)('$name', ({ prepare }) => {
  it('the old call shape books as before and links nothing', async () => {
    const c = await seed()
    const call = await prepare(c)
    const before = await entryIds(c.companyId)
    const numbers = await drawn(c.companyId)
    booked(call, await run(call))
    const fresh = [...(await entryIds(c.companyId))].filter((id) => !before.has(id))
    expect(fresh).toHaveLength(call.drafts)
    expect(await drawn(c.companyId)).toBe(numbers + call.drafts)
    expect(await links(c.companyId)).toEqual([])
  })

  it('with ids under shadow, each draft it writes is linked to its events, nothing else', async () => {
    const c = await seed()
    const call = await prepare(c)
    const events = await Promise.all(Array.from({ length: call.events }, () => insertEvent(c.companyId)))
    const before = await entryIds(c.companyId)
    booked(call, await run(call, [['p_event_ids', events, 'uuid[]'], ['p_event_mode', 'shadow', 'text']]))
    const fresh = [...(await entryIds(c.companyId))].filter((id) => !before.has(id))
    expect(fresh).toHaveLength(call.drafts)
    const linked = await links(c.companyId)
    // Only the verifikat the function drafted, every one posted now.
    expect(linked.every((l) => fresh.includes(l.entry) && l.status === 'posted')).toBe(true)
    if (call.drafts === 0) {
      expect(linked).toEqual([])
    } else if (call.fn === 'commit_opening_balance_replacement') {
      // By position: the new IB (produced), the storno (reversal).
      expect(linked.map(({ event, role, source_type }) => ({ event, role, source_type })).sort((a, b) => a.role.localeCompare(b.role))).toEqual([
        { event: events[0], role: 'produced', source_type: 'opening_balance' },
        { event: events[1], role: 'reversal', source_type: 'storno' },
      ])
    } else {
      expect(new Set(linked.map((l) => l.event))).toEqual(new Set(events))
      expect(linked.every((l) => l.role === 'produced')).toBe(true)
    }
  })

  it('a refused link under shadow still books, without the link', async () => {
    const c = await seed()
    const other = await seed()
    const call = await prepare(c)
    const foreign = await Promise.all(Array.from({ length: call.events }, () => insertEvent(other.companyId)))
    const numbers = await drawn(c.companyId)
    booked(call, await run(call, [['p_event_ids', foreign, 'uuid[]'], ['p_event_mode', 'shadow', 'text']]))
    expect(await drawn(c.companyId)).toBe(numbers + call.drafts)
    expect(await links(c.companyId)).toEqual([])
  })

  it('a refused link under strict books nothing and draws no number', async () => {
    const c = await seed()
    const other = await seed()
    const call = await prepare(c)
    const foreign = await Promise.all(Array.from({ length: call.events }, () => insertEvent(other.companyId)))
    const before = await entryIds(c.companyId)
    const numbers = await drawn(c.companyId)
    const attempt = run(call, [['p_event_ids', foreign, 'uuid[]'], ['p_event_mode', 'strict', 'text']])
    if (call.drafts === 0) {
      // Nothing drafted, nothing to link: it books as before.
      booked(call, await attempt)
    } else {
      await expect(attempt).rejects.toThrow(/BUSINESS_EVENT_LINK_COMPANY_MISMATCH/)
      expect([...(await entryIds(c.companyId))].filter((id) => !before.has(id))).toEqual([])
      expect(await drawn(c.companyId)).toBe(numbers)
    }
    expect(await links(c.companyId)).toEqual([])
    for (const period of [c.periodId, c.period2027]) {
      const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [c.companyId, period])
      expect(gaps.rows).toEqual([])
    }
  })
})

describe('positional SQL callers still resolve', () => {
  it('link_supplier_invoice_to_voucher with five arguments (commit_provider_migration_followup)', async () => {
    const c = await seed()
    const invoice = await supplierInvoice(c, 'EUR', 11.5, 1000)
    const voucher = await postedVoucher(c, '2440', '1930', 11200)
    const answer = await runAsServiceRole(async (client) => {
      const { rows } = await client.query(`SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, 'Provider migration') AS r`, [
        invoice,
        voucher,
        c.userId,
        c.companyId,
      ])
      return rows[0].r as Record<string, unknown>
    })
    expect(answer).toMatchObject({ ok: true })
    expect(answer.fx_journal_entry_id).toBeTruthy()
    expect(await links(c.companyId)).toEqual([])
  })

  it('commit_opening_balance_replacement with its ten arguments', async () => {
    const c = await seed()
    const { oldEntryId, lines } = await openingBalance(c)
    const row = await runAsServiceRole(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM public.commit_opening_balance_replacement($1, $2, $3, $4, '2027-01-01', 'Ingående balanser (korrigerade)', 'A', $5::jsonb, NULL, NULL)`,
        [c.companyId, c.period2027, oldEntryId, c.userId, JSON.stringify(lines)],
      )
      return rows[0] as Record<string, unknown>
    })
    expect(row.new_entry_id).toBeTruthy()
    expect(await links(c.companyId)).toEqual([])
  })
})
