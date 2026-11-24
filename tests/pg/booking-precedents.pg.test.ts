/**
 * pg-real test for booking_precedents (20261123193100) and its index
 * idx_transactions_booked_counterparty_key (20261123193000).
 *
 * The function answers, for the counterparty texts handed in, the newest
 * booked bank rows of one company with the same counterparty key and the
 * lines of the verifikat that books each. Verified here: the key and the
 * text it is read from (merchant name, else original description, else
 * description), parity of the key with normalizeCounterpartyName, a text
 * that names no one, posted and non-storno verifikat only, the date window,
 * newest first with the per-counterparty cap, the settlement ledger, the
 * company filter on its own and under row level security, the grants, and
 * that the planner reads the rows off the index.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { namesCounterparty, normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { getClient, getPool, withUserContext } from './setup'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertPostedBankJournalEntry,
  seedCompany,
  type PostedJournalEntryLine,
} from './fixtures'

interface PrecedentLine {
  account: string
  debit: number
  credit: number
}

interface PrecedentBooking {
  transaction_id: string
  date: string
  amount: number
  journal_entry_id: string
  settlement_ledger: string | null
  lines: PrecedentLine[]
}

interface Precedents {
  names: Record<string, string>
  bookings: Record<string, PrecedentBooking[]>
}

const FROM = '2026-04-01'

async function insertBankRow(params: {
  companyId: string
  userId: string
  date: string
  amount?: number
  merchantName?: string | null
  originalDescription?: string | null
  description?: string
  journalEntryId?: string | null
  cashAccountId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        journal_entry_id, merchant_name, category, original_description, cash_account_id)
     VALUES ($1, $2, $3, 'SEK', $4, $5, $6, $7, $8, 'uncategorized', $9, $10)`,
    [
      id,
      params.companyId,
      params.userId,
      params.amount ?? -500,
      params.date,
      params.description ?? 'Bank row',
      params.journalEntryId ?? null,
      params.merchantName ?? null,
      params.originalDescription ?? null,
      params.cashAccountId ?? null,
    ],
  )
  return id
}

interface Company {
  userId: string
  companyId: string
  fiscalPeriodId: string
}

let nextVoucher = 1

/** A bank row booked by a posted verifikat of its own, in one call. */
async function bookRow(
  company: Company,
  row: {
    date: string
    amount?: number
    merchantName?: string | null
    originalDescription?: string | null
    description?: string
    cashAccountId?: string | null
    lines?: PostedJournalEntryLine[]
  },
): Promise<{ transactionId: string; entryId: string }> {
  const transactionId = await insertBankRow({ ...company, ...row })
  const entryId = await insertPostedBankJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: row.date,
    voucherNumber: nextVoucher++,
    transactionId,
    lines: row.lines ?? [
      { accountNumber: '5420', debitAmount: 500, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
    ],
  })
  await getPool().query('UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1', [transactionId, entryId])
  return { transactionId, entryId }
}

/** A bank row pointing at a verifikat that is not a live booking: a draft, or a posted storno. */
async function rowOnUnpostedEntry(company: Company, text: string, date: string, as: 'draft' | 'storno'): Promise<string> {
  const entryId = await insertDraftJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    entryDate: date,
    status: 'draft',
    voucherNumber: as === 'storno' ? nextVoucher++ : 0,
  })
  await getPool().query(
    `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '6110', 500, 0), ($1, '1930', 0, 500)`,
    [entryId],
  )
  // The row goes on before the entry is a storno: the pointer guard refuses
  // the write afterwards and leaves the rows that already have it.
  const transactionId = await insertBankRow({ ...company, date, merchantName: text, journalEntryId: entryId })
  if (as === 'storno') {
    await getPool().query(`UPDATE public.journal_entries SET source_type = 'storno', status = 'posted' WHERE id = $1`, [entryId])
  }
  return transactionId
}

async function precedents(companyId: string, names: string[], from = FROM, perCounterparty?: number): Promise<Precedents> {
  const { rows } = await getPool().query<{ result: Precedents }>(
    perCounterparty === undefined
      ? `SELECT public.booking_precedents($1::uuid, $2::text[], $3::date) AS result`
      : `SELECT public.booking_precedents($1::uuid, $2::text[], $3::date, $4::integer) AS result`,
    perCounterparty === undefined ? [companyId, names, from] : [companyId, names, from, perCounterparty],
  )
  return rows[0].result
}

describe('booking_precedents', () => {
  let a: Company
  let b: Company
  let newest: { transactionId: string; entryId: string }
  let middle: { transactionId: string; entryId: string }
  let oldest: { transactionId: string; entryId: string }
  let beforeWindow: { transactionId: string; entryId: string }
  let onCard: { transactionId: string; entryId: string }
  let foreign: { transactionId: string; entryId: string }
  let stornoRow: string
  let draftRow: string

  beforeAll(async () => {
    a = await seedCompany()
    b = await seedCompany()

    // One counterparty of company A, written three ways the key folds together.
    oldest = await bookRow(a, { date: '2026-04-10', merchantName: 'Nordverk AB' })
    middle = await bookRow(a, {
      date: '2026-05-10',
      merchantName: null,
      originalDescription: 'NORDVERK AB 2026-05-09',
      description: 'Renamed by a person',
      lines: [
        { accountNumber: '6110', debitAmount: 400, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })
    newest = await bookRow(a, { date: '2026-06-10', merchantName: null, originalDescription: null, description: 'Nordverk' })
    // Dated before the window.
    beforeWindow = await bookRow(a, { date: '2026-03-10', merchantName: 'Nordverk AB' })
    // Never a live booking of the counterparty.
    stornoRow = await rowOnUnpostedEntry(a, 'Nordverk AB', '2026-06-12', 'storno')
    draftRow = await rowOnUnpostedEntry(a, 'Nordverk AB', '2026-06-13', 'draft')

    // The merchant name decides the key where a row has one.
    await bookRow(a, { date: '2026-06-01', merchantName: 'Sydkraft', originalDescription: 'Nordverk AB', description: 'Nordverk AB' })

    // A text that names no one, booked.
    await bookRow(a, { date: '2026-06-02', merchantName: null, originalDescription: 'INTERNET BET 4', description: 'INTERNET BET 4' })

    // A row on a cash account with a ledger of its own.
    const cashAccountId = await insertCashAccount({ companyId: a.companyId, ledgerAccount: '1940' })
    onCard = await bookRow(a, {
      date: '2026-06-03',
      merchantName: 'Vattenverket',
      cashAccountId,
      lines: [
        { accountNumber: '5020', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1940', debitAmount: 0, creditAmount: 500 },
      ],
    })

    // The same counterparty, booked by another company.
    foreign = await bookRow(b, {
      date: '2026-06-11',
      merchantName: 'Nordverk AB',
      lines: [
        { accountNumber: '4010', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })
  })

  it('answers the booked rows of the counterparty key, newest first, with the lines of each verifikat', async () => {
    const out = await precedents(a.companyId, ['Nordverk AB'])

    expect(out.names).toEqual({ 'Nordverk AB': 'nordverk' })
    expect(Object.keys(out.bookings)).toEqual(['nordverk'])
    expect(out.bookings.nordverk.map((r) => r.transaction_id)).toEqual([
      newest.transactionId,
      middle.transactionId,
      oldest.transactionId,
    ])
    expect(out.bookings.nordverk[0]).toEqual({
      transaction_id: newest.transactionId,
      date: '2026-06-10',
      amount: -500,
      journal_entry_id: newest.entryId,
      settlement_ledger: null,
      lines: [
        { account: '5420', debit: 500, credit: 0 },
        { account: '1930', debit: 0, credit: 500 },
      ],
    })
    expect(out.bookings.nordverk[1].lines).toEqual([
      { account: '6110', debit: 400, credit: 0 },
      { account: '2641', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 500 },
    ])
  })

  it('leaves out a row dated before the window, on a draft or on a storno', async () => {
    const ids = (await precedents(a.companyId, ['Nordverk AB'])).bookings.nordverk.map((r) => r.transaction_id)
    expect(ids).not.toContain(beforeWindow.transactionId)
    expect(ids).not.toContain(stornoRow)
    expect(ids).not.toContain(draftRow)

    // The window is the caller's date: an earlier one takes the older row in.
    const wider = (await precedents(a.companyId, ['Nordverk AB'], '2026-03-01')).bookings.nordverk.map((r) => r.transaction_id)
    expect(wider).toEqual([newest.transactionId, middle.transactionId, oldest.transactionId, beforeWindow.transactionId])
  })

  it('keys the texts handed in the way it keys the stored rows, as normalizeCounterpartyName does', async () => {
    const texts = ['Nordverk AB', 'NORDVERK AB 2026-05-09', 'Nordverk', 'BANKGIRO Nordverk AB']
    const out = await precedents(a.companyId, texts)

    for (const text of texts) {
      expect(namesCounterparty(text)).toBe(true)
      expect(out.names[text]).toBe(normalizeCounterpartyName(text))
    }
    // Several texts, one key: its bookings are answered once.
    expect(new Set(Object.values(out.names))).toEqual(new Set(['nordverk']))
    expect(Object.keys(out.bookings)).toEqual(['nordverk'])
    expect(out.bookings.nordverk).toHaveLength(3)
  })

  it('reads a stored row by its merchant name before its other texts', async () => {
    const out = await precedents(a.companyId, ['Sydkraft', 'Nordverk AB'])
    expect(out.bookings.sydkraft).toHaveLength(1)
    // The row whose descriptions say Nordverk is Sydkraft's, by its merchant name.
    expect(out.bookings.nordverk).toHaveLength(3)
  })

  it('has no key for a text that names no one, or one too short, however many rows carry it', async () => {
    const out = await precedents(a.companyId, ['INTERNET BET 4', 'A', '', 'Okänd Motpart'])
    expect(namesCounterparty('INTERNET BET 4')).toBe(false)
    expect(out.names).toEqual({ 'Okänd Motpart': normalizeCounterpartyName('Okänd Motpart') })
    expect(out.bookings).toEqual({})
  })

  it('answers empty for no texts', async () => {
    expect(await precedents(a.companyId, [])).toEqual({ names: {}, bookings: {} })
  })

  it('answers at most the asked number of rows per counterparty, the newest', async () => {
    const out = await precedents(a.companyId, ['Nordverk AB'], FROM, 2)
    expect(out.bookings.nordverk.map((r) => r.transaction_id)).toEqual([newest.transactionId, middle.transactionId])
    // Never fewer than one, never more than fifty.
    expect((await precedents(a.companyId, ['Nordverk AB'], FROM, 0)).bookings.nordverk).toHaveLength(1)
    expect((await precedents(a.companyId, ['Nordverk AB'], FROM, 5000)).bookings.nordverk).toHaveLength(3)
  })

  it("names the ledger of the row's own cash account", async () => {
    const out = await precedents(a.companyId, ['Vattenverket'])
    expect(out.bookings.vattenverket).toEqual([
      expect.objectContaining({ transaction_id: onCard.transactionId, settlement_ledger: '1940' }),
    ])
  })

  it('answers only the rows of the company asked for', async () => {
    const ofA = (await precedents(a.companyId, ['Nordverk AB'])).bookings.nordverk.map((r) => r.transaction_id)
    expect(ofA).not.toContain(foreign.transactionId)

    const ofB = await precedents(b.companyId, ['Nordverk AB', 'Vattenverket'])
    expect(ofB.bookings.nordverk.map((r) => r.transaction_id)).toEqual([foreign.transactionId])
    expect(ofB.bookings.nordverk[0].lines.map((l) => l.account)).toEqual(['4010', '1930'])
    expect(ofB.bookings.vattenverket).toBeUndefined()
  })

  it('under row level security a member reads their own company and nothing of another', async () => {
    const call = `SELECT public.booking_precedents($1::uuid, $2::text[], $3::date) AS result`
    const own = await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query<{ result: Precedents }>(call, [a.companyId, ['Nordverk AB'], FROM])
      return rows[0].result
    })
    expect(own.bookings.nordverk).toHaveLength(3)
    expect(own.bookings.nordverk[0].lines).toHaveLength(2)

    const other = await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query<{ result: Precedents }>(call, [b.companyId, ['Nordverk AB'], FROM])
      return rows[0].result
    })
    expect(other.bookings).toEqual({})
  })

  it('is granted to signed-in users and the service role, not to anonymous callers', async () => {
    const { rows } = await getPool().query<{ role: string; may: boolean }>(
      `SELECT r.role, has_function_privilege(r.role, 'public.booking_precedents(uuid, text[], date, integer)', 'EXECUTE') AS may
       FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.may]))).toEqual({
      anon: false,
      authenticated: true,
      service_role: true,
    })
  })
})

interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  Plans?: PlanNode[]
}

function indexNames(node: PlanNode): string[] {
  return [...(node['Index Name'] ? [node['Index Name']] : []), ...(node.Plans ?? []).flatMap(indexNames)]
}

/**
 * The indexes in the plans of the statements a function call runs, the SQL
 * function's own query included: auto_explain, preloaded in the
 * supabase/postgres image, reports nested statements to the client as
 * NOTICEs (the pattern of scale-indexes.pg.test.ts). Sequential scans, bitmap
 * scans and sorts are priced out, so the plan shows what an index can do for
 * the statement, not what is cheapest on a nearly empty table.
 */
async function functionIndexes(call: string, args: unknown[]): Promise<string[]> {
  const client = await getClient()
  const notices: string[] = []
  const onNotice = (notice: { message?: string }) => {
    if (notice.message) notices.push(notice.message)
  }
  client.on('notice', onNotice)
  try {
    await client.query('BEGIN')
    for (const setting of ['enable_seqscan = off', 'enable_bitmapscan = off', 'enable_sort = off']) {
      await client.query(`SET LOCAL ${setting}`)
    }
    for (const setting of ['log_min_duration = 0', 'log_nested_statements = on', 'log_format = json', 'log_level = notice']) {
      await client.query(`SET LOCAL auto_explain.${setting}`)
    }
    await client.query(call, args)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.off('notice', onNotice)
    client.release()
  }
  return notices
    .filter((message) => message.includes('"Plan"'))
    .flatMap((message) => indexNames((JSON.parse(message.slice(message.indexOf('{'))) as { Plan: PlanNode }).Plan))
}

describe('idx_transactions_booked_counterparty_key', () => {
  it('is a valid index on the key expression of the booked rows', async () => {
    const { rows } = await getPool().query<{ def: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
       FROM pg_index i
       WHERE i.indexrelid = 'public.idx_transactions_booked_counterparty_key'::regclass`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].def).toContain('normalize_counterparty_key(')
    expect(rows[0].def).toContain('journal_entry_id IS NOT NULL')
  })

  it("serves the function's read of the booked rows", async () => {
    const indexes = await functionIndexes(`SELECT public.booking_precedents($1::uuid, $2::text[], $3::date)`, [
      '00000000-0000-4000-8000-000000000001',
      ['Nordverk AB', 'Sydkraft'],
      FROM,
    ])
    expect(indexes).toContain('idx_transactions_booked_counterparty_key')
  })
})
