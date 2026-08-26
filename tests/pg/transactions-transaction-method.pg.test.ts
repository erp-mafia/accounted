import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TransactionMethod } from '@/types'
import { seedCompany, insertTransaction } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for transactions.transaction_method
 * (20260808090000_transactions_transaction_method.sql + the paired backfill
 * 20260808090100_..._backfill.sql).
 *
 * Locks in:
 *   - The closed-vocabulary CHECK constraint.
 *   - The backfill's trailing-phrase classification (real production strings),
 *     its precedence (word-boundary: "Löneinsättning" is salary, never
 *     deposit), the MCC and Stripe-prefix fallbacks, and the NULL result for
 *     unclassifiable rows.
 *   - FEED-ROW SCOPE: user-created rows (import_source NULL/manual/mcp) are
 *     never classified and never rewritten ("Egen insättning" stays intact).
 *   - Title stripping: unedited titles lose the trailing channel phrase but
 *     are never emptied; user-edited titles are untouched even when the
 *     original carries a phrase (classification still fires off the original);
 *     the adjective guard keeps "Egen insättning" whole even on feed rows.
 *   - Idempotence: a second run changes nothing.
 */

// Run the real backfill migration SQL so the test exercises exactly what
// ships, not a re-implementation.
const BACKFILL_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260808090100_transactions_transaction_method_backfill.sql',
  ),
  'utf8',
)
async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertFeedRow(params: {
  companyId: string
  userId: string
  description: string
  originalDescription?: string | null
  titleEditedAt?: string | null
  /** Defaults to a bank feed; pass null/'manual'/'mcp' for user-created rows. */
  importSource?: string | null
  mccCode?: number | null
}): Promise<string> {
  const id = await insertTransaction({
    companyId: params.companyId,
    userId: params.userId,
    description: params.description,
  })
  await getPool().query(
    `UPDATE public.transactions
        SET original_description = $2,
            title_edited_at = $3::timestamptz,
            import_source = $4,
            mcc_code = $5
      WHERE id = $1`,
    [
      id,
      params.originalDescription === undefined ? params.description : params.originalDescription,
      params.titleEditedAt ?? null,
      params.importSource === undefined ? 'enable_banking' : params.importSource,
      params.mccCode ?? null,
    ],
  )
  return id
}

async function getRow(
  txId: string,
): Promise<{ description: string; transaction_method: TransactionMethod | null }> {
  const { rows } = await getPool().query(
    `SELECT description, transaction_method FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return rows[0]
}

describe('transactions.transaction_method: CHECK constraint', () => {
  it('accepts vocabulary values and NULL, rejects anything else', async () => {
    const { userId, companyId } = await seedCompany()
    const tx = await insertTransaction({ companyId, userId })

    await getPool().query(
      `UPDATE public.transactions SET transaction_method = 'card' WHERE id = $1`,
      [tx],
    )
    await getPool().query(
      `UPDATE public.transactions SET transaction_method = NULL WHERE id = $1`,
      [tx],
    )
    await expect(
      getPool().query(
        `UPDATE public.transactions SET transaction_method = 'bankid' WHERE id = $1`,
        [tx],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('transactions.transaction_method: backfill classification + title strip', () => {
  it('classifies the real production strings and strips the trailing phrase', async () => {
    const { userId, companyId } = await seedCompany()
    const cases: Array<{
      description: string
      method: TransactionMethod
      stripped: string
    }> = [
      {
        description: 'Vercel Jul Överföring via internet',
        method: 'transfer',
        stripped: 'Vercel Jul',
      },
      {
        description: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO Kortköp/uttag',
        method: 'card',
        stripped: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO',
      },
      {
        description: 'Inbetalning skat BG 0000050501055 Bg-bet. via internet',
        method: 'bankgiro',
        stripped: 'Inbetalning skat BG 0000050501055',
      },
      { description: '1260624917587 Europabetalning', method: 'international', stripped: '1260624917587' },
      { description: '1260624917587 Pris betalning', method: 'fee', stripped: '1260624917587' },
      { description: 'SWED2607270AUEOU Insättning', method: 'deposit', stripped: 'SWED2607270AUEOU' },
      { description: 'Lön Juli Emil Överföring via internet', method: 'transfer', stripped: 'Lön Juli Emil' },
      { description: 'ACME AB Löneinsättning', method: 'salary', stripped: 'ACME AB' },
      { description: 'Swish till Erik Andersson', method: 'swish', stripped: 'Swish till Erik Andersson' },
    ]
    const ids = []
    for (const c of cases) {
      ids.push(await insertFeedRow({ companyId, userId, description: c.description }))
    }

    await runBackfill()

    for (let i = 0; i < cases.length; i++) {
      const row = await getRow(ids[i])
      expect(row.transaction_method).toBe(cases[i].method)
      expect(row.description).toBe(cases[i].stripped)
    }
  })

  it('never touches user-created rows (import_source NULL, manual, mcp)', async () => {
    const { userId, companyId } = await seedCompany()
    const cases = [null, 'manual', 'mcp']
    const ids: string[] = []
    for (const src of cases) {
      // Titles that WOULD classify+strip if they came from a bank feed.
      ids.push(
        await insertFeedRow({ companyId, userId, description: 'Egen insättning', importSource: src }),
      )
    }

    await runBackfill()

    for (const id of ids) {
      const row = await getRow(id)
      expect(row.transaction_method).toBeNull()
      expect(row.description).toBe('Egen insättning')
    }
  })

  it('adjective guard: feed rows classify but keep "Egen insättning"-style titles', async () => {
    const { userId, companyId } = await seedCompany()
    const deposit = await insertFeedRow({ companyId, userId, description: 'Egen insättning' })
    const withdrawal = await insertFeedRow({ companyId, userId, description: 'Eget uttag' })
    const transfer = await insertFeedRow({ companyId, userId, description: 'Intern överföring' })

    await runBackfill()

    expect(await getRow(deposit)).toEqual({
      description: 'Egen insättning',
      transaction_method: 'deposit',
    })
    expect(await getRow(withdrawal)).toEqual({
      description: 'Eget uttag',
      transaction_method: 'withdrawal',
    })
    expect(await getRow(transfer)).toEqual({
      description: 'Intern överföring',
      transaction_method: 'transfer',
    })
  })

  it('never empties a title that IS the phrase', async () => {
    const { userId, companyId } = await seedCompany()
    const tx = await insertFeedRow({ companyId, userId, description: 'Insättning' })

    await runBackfill()

    const row = await getRow(tx)
    expect(row.transaction_method).toBe('deposit')
    expect(row.description).toBe('Insättning')
  })

  it('classifies an edited row from the original but leaves the edited title alone', async () => {
    const { userId, companyId } = await seedCompany()
    const tx = await insertFeedRow({
      companyId,
      userId,
      description: 'Serverhyra juli Överföring via internet',
      originalDescription: 'Hetzner GmbH Överföring via internet',
      titleEditedAt: '2026-07-01T10:00:00Z',
    })

    await runBackfill()

    const row = await getRow(tx)
    expect(row.transaction_method).toBe('transfer')
    // User-edited titles are never rewritten, even when they end in a phrase.
    expect(row.description).toBe('Serverhyra juli Överföring via internet')
  })

  it('falls back to the legacy description when original_description is NULL', async () => {
    const { userId, companyId } = await seedCompany()
    const tx = await insertFeedRow({
      companyId,
      userId,
      description: 'TELIA AB Autogiro',
      originalDescription: null,
    })

    await runBackfill()

    const row = await getRow(tx)
    expect(row.transaction_method).toBe('autogiro')
    expect(row.description).toBe('TELIA AB')

    // The strip must preserve the only copy of the full bank string: a legacy
    // NULL original_description is filled from the pre-strip description in
    // the same statement, never lost.
    const { rows } = await getPool().query(
      `SELECT original_description FROM public.transactions WHERE id = $1`,
      [tx],
    )
    expect(rows[0].original_description).toBe('TELIA AB Autogiro')
  })

  it('uses MCC presence as the card-rail fallback (6011 = withdrawal)', async () => {
    const { userId, companyId } = await seedCompany()
    const card = await insertFeedRow({
      companyId,
      userId,
      description: 'COOP KONSUM STOCKHOLM',
      mccCode: 5411,
    })
    const atm = await insertFeedRow({
      companyId,
      userId,
      description: 'BANKOMAT VASAGATAN',
      mccCode: 6011,
    })

    await runBackfill()

    expect((await getRow(card)).transaction_method).toBe('card')
    expect((await getRow(atm)).transaction_method).toBe('withdrawal')
    // No phrase → the title is untouched.
    expect((await getRow(card)).description).toBe('COOP KONSUM STOCKHOLM')
  })

  it('classifies Stripe feed rows from their deterministic prefixes', async () => {
    const { userId, companyId } = await seedCompany()
    const mk = (description: string) =>
      insertFeedRow({ companyId, userId, description, importSource: 'stripe' })
    const fee = await mk('Stripe-avgift (Stripe-betalning Carl)')
    const usage = await mk('Stripe: Billing - Usage Fee (2026-07-26)')
    const charge = await mk('Stripe-betalning Fredrik Schöön')
    const payout = await mk('Stripe-utbetalning po_1')

    await runBackfill()

    expect((await getRow(fee)).transaction_method).toBe('fee')
    expect((await getRow(usage)).transaction_method).toBe('fee')
    expect((await getRow(charge)).transaction_method).toBe('card')
    expect((await getRow(payout)).transaction_method).toBe('transfer')
  })

  it('leaves unclassifiable rows NULL and untouched, and is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    const plain = await insertFeedRow({ companyId, userId, description: 'Okänd transaktion' })
    const phrased = await insertFeedRow({
      companyId,
      userId,
      description: 'Vercel Jul Överföring via internet',
    })
    // Pre-classified rows must not be reclassified.
    const preset = await insertFeedRow({ companyId, userId, description: 'X Kortköp' })
    await getPool().query(
      `UPDATE public.transactions SET transaction_method = 'swish' WHERE id = $1`,
      [preset],
    )

    await runBackfill()
    const first = [await getRow(plain), await getRow(phrased), await getRow(preset)]
    await runBackfill()
    const second = [await getRow(plain), await getRow(phrased), await getRow(preset)]

    expect(first[0]).toEqual({ description: 'Okänd transaktion', transaction_method: null })
    expect(first[1]).toEqual({ description: 'Vercel Jul', transaction_method: 'transfer' })
    expect(first[2].transaction_method).toBe('swish')
    expect(second).toEqual(first)
  })
})
