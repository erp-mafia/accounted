import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertPostedBankJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'

/**
 * Covers 20261127180000_inline_rattelse_carries_currency.
 *
 * correct_entry_lines_inline wrote every replacement line in kronor and
 * refused to strike a line in a foreign currency, so a posted verifikat whose
 * kronor are right but whose currency facts are missing could only be fixed
 * with a storno. This proves, against the real function and triggers:
 *
 *   1. a kronor bank line on a currency account gets its code, amount in the
 *      currency and rate inside the same verifikat, the kronor untouched, and
 *      journal_entry_rattelse_log keeps the struck and the added line with
 *      both sides' currency facts and who;
 *   2. "changes nothing" sees the currency facts: the same facts again are
 *      refused, another amount in currency or rate is a change;
 *   3. a line in a foreign currency is struck only when every added line
 *      names its currency (a foreign code, or SEK), and a kronor line stores
 *      no amount in currency or rate;
 *   4. a foreign added line needs a three-letter code and an amount in the
 *      currency and a rate above zero; a refusal writes nothing;
 *   5. only open, unlocked periods after the company lock date;
 *   6. a signed-in member calling the RPC directly gets the same, and the
 *      function keeps its signature, SECURITY DEFINER and grants.
 */

async function chart(companyId: string, userId: string, accounts: string[]): Promise<void> {
  for (const account of accounts) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, 'Konto ' || $3, left($3, 1)::int, 'asset', 'debit')
       ON CONFLICT DO NOTHING`,
      [userId, companyId, account],
    )
  }
}

/**
 * A EUR 1 000 deposit on the 1940 currency account, booked 1940 D 11 000 /
 * 1510 K 11 000 with the 1940 line in kronor only: the bank says EUR, the
 * ledger cannot.
 */
async function bankWorld() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await chart(companyId, userId, ['1940', '1510'])
  const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1940', currency: 'EUR' })
  const txId = await insertTransaction({
    companyId,
    userId,
    currency: 'EUR',
    amount: 1000,
    date: '2026-10-20',
    cashAccountId,
  })
  const entryId = await insertPostedBankJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    transactionId: txId,
    entryDate: '2026-10-20',
    description: 'Inbetalning kundfaktura',
    voucherNumber: 7,
    lines: [
      { accountNumber: '1940', debitAmount: 11000, creditAmount: 0 },
      { accountNumber: '1510', debitAmount: 0, creditAmount: 11000 },
    ],
  })
  await getPool().query('UPDATE public.transactions SET journal_entry_id = $2, is_business = true WHERE id = $1', [
    txId,
    entryId,
  ])
  const bankLineId = await lineId(entryId, '1940')
  return { userId, companyId, fiscalPeriodId, entryId, bankLineId }
}

/** A manual verifikat with a EUR 1510 line (EUR 1 000 at 11) against 1930. */
async function foreignLineWorld() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await chart(companyId, userId, ['1930', '1510', '1511'])
  // Lines written on the draft, then posted, as a builder writes them (the
  // posting fixture writes kronor lines only).
  const entryId = await insertDraftJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-05-04',
    voucherNumber: 3,
  })
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, currency, amount_in_currency, exchange_rate)
     VALUES ($1, '1930', 11000, 0, 0, 'SEK', NULL, NULL),
            ($1, '1510', 0, 11000, 1, 'EUR', 1000, 11)`,
    [entryId],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [entryId])
  return { userId, companyId, fiscalPeriodId, entryId, foreignLineId: await lineId(entryId, '1510') }
}

async function lineId(entryId: string, account: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = $2`,
    [entryId, account],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.id
}

const STRIKE_SQL = `SELECT public.correct_entry_lines_inline(
  p_company_id => $1::uuid, p_entry_id => $2::uuid, p_strike_line_ids => $3::uuid[],
  p_new_lines => $4::jsonb, p_user_id => $5::uuid) AS result`

function strike(companyId: string, entryId: string, strikeIds: string[], lines: unknown[], userId: string) {
  return getPool().query<{ result: { log_id: string; struck_count: number; added_count: number } }>(STRIKE_SQL, [
    companyId,
    entryId,
    strikeIds,
    JSON.stringify(lines),
    userId,
  ])
}

interface StoredLine {
  account_number: string
  debit: number
  credit: number
  currency: string | null
  amount_in_currency: number | null
  exchange_rate: number | null
}

async function state(entryId: string) {
  const [{ rows: entry }, { rows: lines }, { rows: log }] = await Promise.all([
    getPool().query<{ status: string; voucher_number: number }>(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    ),
    getPool().query<{
      account_number: string
      debit: string
      credit: string
      currency: string | null
      amount_in_currency: string | null
      exchange_rate: string | null
    }>(
      `SELECT account_number, debit_amount::text AS debit, credit_amount::text AS credit, currency,
              amount_in_currency::text AS amount_in_currency, exchange_rate::text AS exchange_rate
         FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY account_number, debit_amount DESC`,
      [entryId],
    ),
    getPool().query<{ rattelse_type: string; actor: string; struck_lines: StoredLineJson[]; added_lines: StoredLineJson[] }>(
      `SELECT rattelse_type, actor::text AS actor, struck_lines, added_lines
         FROM public.journal_entry_rattelse_log WHERE journal_entry_id = $1 ORDER BY created_at, id`,
      [entryId],
    ),
  ])
  const num = (v: string | null) => (v === null ? null : Number(v))
  return {
    entry: entry[0]!,
    lines: lines.map(
      (l): StoredLine => ({
        account_number: l.account_number,
        debit: Number(l.debit),
        credit: Number(l.credit),
        currency: l.currency,
        amount_in_currency: num(l.amount_in_currency),
        exchange_rate: num(l.exchange_rate),
      }),
    ),
    log,
  }
}

interface StoredLineJson {
  account_number: string
  debit_amount: number
  credit_amount: number
  currency: string | null
  amount_in_currency: number | null
  exchange_rate: number | null
}

const facts = (l: StoredLineJson) => ({
  account_number: l.account_number,
  debit_amount: Number(l.debit_amount),
  credit_amount: Number(l.credit_amount),
  currency: l.currency,
  amount_in_currency: l.amount_in_currency === null ? null : Number(l.amount_in_currency),
  exchange_rate: l.exchange_rate === null ? null : Number(l.exchange_rate),
})

const sek = (account_number: string, debit: number, credit: number): StoredLine => ({
  account_number,
  debit,
  credit,
  currency: 'SEK',
  amount_in_currency: null,
  exchange_rate: null,
})

/** The 1940 line restated with the bank's EUR figure; the kronor stay. */
const EUR_BANK_LINE = {
  account_number: '1940',
  debit_amount: 11000,
  credit_amount: 0,
  currency: 'eur',
  amount_in_currency: 1000,
  exchange_rate: 11,
}

describe('inline rättelse carries a line\'s currency (pg-real)', () => {
  it('gives a kronor bank line its currency inside the same verifikat, logged with both sides and who', async () => {
    const w = await bankWorld()
    const before = await state(w.entryId)
    expect(before.lines).toEqual([sek('1510', 0, 11000), sek('1940', 11000, 0)])

    const { rows } = await strike(w.companyId, w.entryId, [w.bankLineId], [EUR_BANK_LINE], w.userId)
    expect(rows[0]!.result).toMatchObject({ struck_count: 1, added_count: 1 })

    const after = await state(w.entryId)
    // Same verifikat, same number, still posted; the kronor did not move.
    expect(after.entry).toEqual({ status: 'posted', voucher_number: before.entry.voucher_number })
    expect(after.lines).toEqual([
      sek('1510', 0, 11000),
      { account_number: '1940', debit: 11000, credit: 0, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11 },
    ])
    expect(after.log).toHaveLength(1)
    const [log] = after.log
    expect(log).toMatchObject({ rattelse_type: 'lines', actor: w.userId })
    expect(log!.struck_lines.map(facts)).toEqual([
      { account_number: '1940', debit_amount: 11000, credit_amount: 0, currency: 'SEK', amount_in_currency: null, exchange_rate: null },
    ])
    expect(log!.added_lines.map(facts)).toEqual([
      { account_number: '1940', debit_amount: 11000, credit_amount: 0, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11 },
    ])
  })

  it('refuses the same currency facts again as no change, and takes another amount in currency or rate', async () => {
    const w = await bankWorld()
    await strike(w.companyId, w.entryId, [w.bankLineId], [EUR_BANK_LINE], w.userId)

    // The same facts written another way (code case, rate scale) change nothing.
    const eurLineId = await lineId(w.entryId, '1940')
    await expect(
      strike(
        w.companyId,
        w.entryId,
        [eurLineId],
        [{ ...EUR_BANK_LINE, currency: 'EUR', amount_in_currency: 1000.0, exchange_rate: 11.0 }],
        w.userId,
      ),
    ).rejects.toThrow(/Rättelsen ändrar ingenting/)

    // Another rate alone is a change.
    await strike(w.companyId, w.entryId, [eurLineId], [{ ...EUR_BANK_LINE, exchange_rate: 11.0012 }], w.userId)
    const rateLineId = await lineId(w.entryId, '1940')
    // An amount in the currency is compared as it is stored, to the öre:
    // 999.995 stores as 1000.00, so it changes nothing.
    await expect(
      strike(w.companyId, w.entryId, [rateLineId], [{ ...EUR_BANK_LINE, amount_in_currency: 999.995, exchange_rate: 11.0012 }], w.userId),
    ).rejects.toThrow(/Rättelsen ändrar ingenting/)
    // Another amount in the currency alone is a change, stored to the öre.
    await strike(w.companyId, w.entryId, [rateLineId], [{ ...EUR_BANK_LINE, amount_in_currency: 1000.504, exchange_rate: 11.0012 }], w.userId)

    const after = await state(w.entryId)
    expect(after.lines).toContainEqual({
      account_number: '1940',
      debit: 11000,
      credit: 0,
      currency: 'EUR',
      amount_in_currency: 1000.5,
      exchange_rate: 11.0012,
    })
    expect(after.log.map((l) => l.rattelse_type)).toEqual(['lines', 'lines', 'lines'])
  })

  it('strikes a foreign line only when every added line names its currency', async () => {
    const w = await foreignLineWorld()
    const before = await state(w.entryId)

    // A replacement that names no currency would put the EUR line in kronor.
    await expect(
      strike(w.companyId, w.entryId, [w.foreignLineId], [{ account_number: '1510', debit_amount: 0, credit_amount: 11000 }], w.userId),
    ).rejects.toThrow(/Rättelsen stryker en rad i utländsk valuta\. Ange valuta på varje ny rad/)
    // One unnamed line among named ones is enough to refuse.
    await expect(
      strike(
        w.companyId,
        w.entryId,
        [w.foreignLineId],
        [
          { account_number: '1511', debit_amount: 0, credit_amount: 10000, currency: 'EUR', amount_in_currency: 909.09, exchange_rate: 11 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
        w.userId,
      ),
    ).rejects.toThrow(/Ange valuta på varje ny rad/)
    expect(await state(w.entryId)).toEqual(before)

    // Named, the EUR line moves to 1511 and keeps its currency.
    await strike(
      w.companyId,
      w.entryId,
      [w.foreignLineId],
      [{ account_number: '1511', debit_amount: 0, credit_amount: 11000, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11 }],
      w.userId,
    )
    expect((await state(w.entryId)).lines).toEqual([
      { account_number: '1511', debit: 0, credit: 11000, currency: 'EUR', amount_in_currency: 1000, exchange_rate: 11 },
      sek('1930', 11000, 0),
    ])

    // Stated as SEK, the line goes to kronor on purpose, and a kronor line
    // stores no amount in currency or rate whatever the caller sent.
    const movedLineId = await lineId(w.entryId, '1511')
    await strike(
      w.companyId,
      w.entryId,
      [movedLineId],
      [{ account_number: '1511', debit_amount: 0, credit_amount: 11000, currency: 'sek', amount_in_currency: 5, exchange_rate: 2 }],
      w.userId,
    )
    expect((await state(w.entryId)).lines).toEqual([sek('1511', 0, 11000), sek('1930', 11000, 0)])
  })

  it.each([
    ['a code that is not three letters', { currency: 'EURO', amount_in_currency: 1000, exchange_rate: 11 }, /Valutakoden "EURO" är ogiltig/],
    ['no amount in the currency', { currency: 'EUR', exchange_rate: 11 }, /En rad i EUR måste ha belopp i valutan och kurs/],
    ['an amount in the currency of zero', { currency: 'EUR', amount_in_currency: 0, exchange_rate: 11 }, /måste ha belopp i valutan och kurs/],
    ['a negative amount in the currency', { currency: 'EUR', amount_in_currency: -1000, exchange_rate: 11 }, /måste ha belopp i valutan och kurs/],
    ['no rate', { currency: 'EUR', amount_in_currency: 1000 }, /måste ha belopp i valutan och kurs/],
    ['a rate of zero', { currency: 'EUR', amount_in_currency: 1000, exchange_rate: 0 }, /måste ha belopp i valutan och kurs/],
    // A direct caller's strings: "NaN" casts to a numeric above every number.
    ['an amount in the currency of "NaN"', { currency: 'EUR', amount_in_currency: 'NaN', exchange_rate: 11 }, /måste ha belopp i valutan och kurs/],
    ['a rate of "Infinity"', { currency: 'EUR', amount_in_currency: 1000, exchange_rate: 'Infinity' }, /måste ha belopp i valutan och kurs/],
    ['an amount in the currency as text', { currency: 'EUR', amount_in_currency: 'tusen', exchange_rate: 11 }, /måste ha belopp i valutan och kurs/],
  ])('refuses a foreign added line with %s, writing nothing', async (_name, currencyFacts, message) => {
    const w = await bankWorld()
    const before = await state(w.entryId)
    await expect(
      strike(
        w.companyId,
        w.entryId,
        [w.bankLineId],
        [{ account_number: '1940', debit_amount: 11000, credit_amount: 0, ...currencyFacts }],
        w.userId,
      ),
    ).rejects.toThrow(message)
    expect(await state(w.entryId)).toEqual(before)
  })

  it('is refused in a locked period and behind the company lock date: storno is the path there', async () => {
    const w = await bankWorld()
    const before = await state(w.entryId)

    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [w.fiscalPeriodId])
    await expect(strike(w.companyId, w.entryId, [w.bankLineId], [EUR_BANK_LINE], w.userId)).rejects.toThrow(
      /Perioden är stängd eller låst/,
    )
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = NULL WHERE id = $1`, [w.fiscalPeriodId])

    await getPool().query(
      `INSERT INTO public.company_settings (company_id, bookkeeping_locked_through)
       VALUES ($1, '2026-10-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [w.companyId],
    )
    await expect(strike(w.companyId, w.entryId, [w.bankLineId], [EUR_BANK_LINE], w.userId)).rejects.toThrow(
      /Bokföringen är låst t\.o\.m\. 2026-10-31/,
    )
    expect(await state(w.entryId)).toEqual(before)
  })

  it('works the same for a signed-in member calling the RPC directly', async () => {
    const w = await bankWorld()
    const lines = await withUserContext(w.userId, async (client) => {
      await client.query(STRIKE_SQL, [w.companyId, w.entryId, [w.bankLineId], JSON.stringify([EUR_BANK_LINE]), null])
      const { rows } = await client.query<{ currency: string; amount_in_currency: string; actor: string }>(
        `SELECT l.currency, l.amount_in_currency::text AS amount_in_currency, r.actor::text AS actor
           FROM public.journal_entry_lines l
           JOIN public.journal_entry_rattelse_log r ON r.journal_entry_id = l.journal_entry_id
          WHERE l.journal_entry_id = $1 AND l.account_number = '1940'`,
        [w.entryId],
      )
      return rows
    })
    expect(lines).toEqual([{ currency: 'EUR', amount_in_currency: '1000.00', actor: w.userId }])
  })

  it('keeps one signature, SECURITY DEFINER with search_path public, executable by authenticated and service_role only', async () => {
    const { rows } = await getPool().query<{
      sig: string
      definer: boolean
      config: string[] | null
      anon: boolean
      authenticated: boolean
      service_role: boolean
      public_exec: boolean
    }>(
      `SELECT p.oid::regprocedure::text AS sig,
              p.prosecdef AS definer,
              p.proconfig AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'correct_entry_lines_inline'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sig).toBe('correct_entry_lines_inline(uuid,uuid,uuid[],jsonb,uuid,text,text)')
    expect(rows[0]!.config).toEqual(['search_path=public'])
    expect(rows[0]).toMatchObject({ definer: true, anon: false, authenticated: true, service_role: true, public_exec: false })
  })
})
