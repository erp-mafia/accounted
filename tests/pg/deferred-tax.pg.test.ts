import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * Migration 20261031200501_deferred_tax: uppskjuten skatt in a K3 legal
 * entity (BFNAR 2012:1 kap. 29).
 *
 * Pinned here:
 *   - commit_deferred_tax posts a year_end voucher on 8940/2240/1370 dated
 *     the balansdag and records the items in the same transaction;
 *   - it refuses another account on the voucher, a net change other than
 *     p_change, items that do not sum to p_closing, a malformed item, a
 *     second posting for the year while the first stands, and a closed year;
 *   - a storno lets the year be posted again;
 *   - a posted voucher with no items (closing deferred tax zero) still
 *     counts as the year's posting;
 *   - the items are immutable;
 *   - a loss recognised needs its reason (29.29) in the assessment, and the
 *     reason is copied onto the posted item, which keeps it when the
 *     assessment changes;
 *   - only a year reported under K3 (its fiscal_period_frameworks row, not
 *     the company's latest framework) takes deferred tax.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

/** The year reported under K3, as the company (its latest framework). */
async function setYearFramework(seed: Seed, framework: 'k2' | 'k3', fiscalPeriodId = seed.fiscalPeriodId) {
  await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = $2 WHERE fiscal_period_id = $1`, [fiscalPeriodId, framework])
}

async function k3Seed(overrides: { isClosed?: boolean } = {}): Promise<Seed> {
  const seed = await seedCompany(overrides)
  await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [seed.companyId])
  await setYearFramework(seed, 'k3')
  return seed
}

const COMMIT_SQL = `SELECT * FROM public.commit_deferred_tax(
  $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric, $6::jsonb
)`

async function insertDraft(
  seed: Seed,
  lines: Array<[string, number, number]>,
  options: { sourceType?: string; entryDate?: string } = {},
): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Uppskjuten skatt', $6, 'draft')`,
    [entryId, seed.userId, seed.companyId, seed.fiscalPeriodId, options.entryDate ?? '2026-12-31', options.sourceType ?? 'year_end'],
  )
  for (const [account, debit, credit] of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [entryId, account, debit, credit],
    )
  }
  return entryId
}

/** A recognised loss carried forward: its deferred tax asset is negative here. */
function lossItem(deferredTax: number, deficit = 100_000) {
  return {
    kind: 'loss_carryforward',
    label: 'Underskottsavdrag',
    carrying_amount: 0,
    tax_value: deficit,
    temporary_difference: -deficit,
    tax_rate: 0.206,
    deferred_tax: deferredTax,
    reason: 'Avtal med ny storkund från januari ger överskott de närmaste åren.',
  }
}

function assetDraft(seed: Seed, amount: number) {
  return insertDraft(seed, [
    ['1370', amount, 0],
    ['8940', 0, amount],
  ])
}

function commit(seed: Seed, entryId: string, closing: number, change: number, items: unknown[]) {
  return getPool().query<{ voucher_number: number }>(COMMIT_SQL, [
    seed.companyId,
    entryId,
    seed.fiscalPeriodId,
    closing,
    change,
    JSON.stringify(items),
  ])
}

async function storno(seed: Seed, entryId: string) {
  const stornoId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, 900, 'A', '2026-12-31', 'Makulering', 'storno', 'draft', $5)`,
      [stornoId, seed.userId, seed.companyId, seed.fiscalPeriodId, entryId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [stornoId, entryId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [stornoId])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [entryId, stornoId],
  )
}

describe('commit_deferred_tax', () => {
  it('posts the year\'s change and records the items', async () => {
    const seed = await k3Seed()
    // A recognised loss of 100 000 kr: an asset of 20 600 kr (-20 600 as a liability).
    const entryId = await assetDraft(seed, 20_600)
    const { rows } = await commit(seed, entryId, -20_600, -20_600, [lossItem(-20_600)])
    expect(rows[0].voucher_number).toBeGreaterThan(0)

    const { rows: items } = await getPool().query<{ kind: string; deferred_tax: string; journal_entry_id: string }>(
      `SELECT kind, deferred_tax, journal_entry_id FROM public.deferred_tax_items WHERE fiscal_period_id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(items).toEqual([{ kind: 'loss_carryforward', deferred_tax: '-20600.00', journal_entry_id: entryId }])
    const { rows: entry } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
  })

  it('refuses another account, a wrong change and items that do not sum to the closing', async () => {
    const seed = await k3Seed()
    const other = await insertDraft(seed, [
      ['1370', 20_600, 0],
      ['8910', 0, 20_600],
    ])
    await expect(commit(seed, other, -20_600, -20_600, [lossItem(-20_600)])).rejects.toMatchObject({ code: '23514' })

    const draft = await assetDraft(seed, 20_600)
    await expect(commit(seed, draft, -20_600, -10_000, [lossItem(-20_600)])).rejects.toMatchObject({ code: '23514' })
    await expect(commit(seed, draft, -20_600, -20_600, [lossItem(-10_000)])).rejects.toMatchObject({ code: '23514' })
    await expect(
      commit(seed, draft, -20_600, -20_600, [{ ...lossItem(-20_600), kind: 'reserves' }]),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('wants a year_end draft dated the balansdag', async () => {
    const seed = await k3Seed()
    const midYear = await insertDraft(
      seed,
      [
        ['1370', 20_600, 0],
        ['8940', 0, 20_600],
      ],
      { entryDate: '2026-06-30' },
    )
    await expect(commit(seed, midYear, -20_600, -20_600, [lossItem(-20_600)])).rejects.toMatchObject({ code: '22023' })
  })

  it('posts once per year until the voucher is reversed', async () => {
    const seed = await k3Seed()
    const first = await assetDraft(seed, 20_600)
    await commit(seed, first, -20_600, -20_600, [lossItem(-20_600)])

    const second = await assetDraft(seed, 1_000)
    await expect(commit(seed, second, -21_600, -1_000, [lossItem(-21_600)])).rejects.toMatchObject({
      code: 'PT409',
      message: 'DEFERRED_TAX_ALREADY_POSTED',
    })

    await storno(seed, first)
    const again = await assetDraft(seed, 21_600)
    await expect(commit(seed, again, -21_600, -21_600, [lossItem(-21_600)])).resolves.toBeTruthy()
  })

  it('counts a posting with no items as the year\'s posting', async () => {
    const seed = await k3Seed()
    // The year's closing deferred tax is zero: the voucher takes a liability
    // the ledger held back through 8940 and records no item.
    const reversal = await insertDraft(seed, [
      ['2240', 5_000, 0],
      ['8940', 0, 5_000],
    ])
    await commit(seed, reversal, 0, -5_000, [])
    const { rowCount } = await getPool().query(
      `SELECT 1 FROM public.deferred_tax_items WHERE fiscal_period_id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(rowCount).toBe(0)

    const second = await assetDraft(seed, 20_600)
    await expect(commit(seed, second, -20_600, -20_600, [lossItem(-20_600)])).rejects.toMatchObject({
      code: 'PT409',
      message: 'DEFERRED_TAX_ALREADY_POSTED',
    })

    await storno(seed, reversal)
    await expect(commit(seed, second, -20_600, -20_600, [lossItem(-20_600)])).resolves.toBeTruthy()
  })

  it('keeps the 29.29 reason on the posted item and refuses a loss without one', async () => {
    const seed = await k3Seed()
    await getPool().query(
      `INSERT INTO public.deferred_tax_assessments (company_id, fiscal_period_id, loss_recognised, loss_reason)
       VALUES ($1, $2, true, 'Avtal med ny storkund från januari ger överskott de närmaste åren.')`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    const draft = await assetDraft(seed, 20_600)
    const withoutReason: Record<string, unknown> = { ...lossItem(-20_600) }
    delete withoutReason.reason
    await expect(commit(seed, draft, -20_600, -20_600, [withoutReason])).rejects.toMatchObject({ code: '22023' })
    await expect(
      commit(seed, draft, -20_600, -20_600, [{ ...lossItem(-20_600), reason: '   ' }]),
    ).rejects.toMatchObject({ code: '22023' })

    await commit(seed, draft, -20_600, -20_600, [lossItem(-20_600)])
    // The assessment stays editable while the year is open; the item does not follow.
    await getPool().query(
      `UPDATE public.deferred_tax_assessments SET loss_reason = 'Ändrad bedömning' WHERE fiscal_period_id = $1`,
      [seed.fiscalPeriodId],
    )
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM public.deferred_tax_items WHERE journal_entry_id = $1`,
      [draft],
    )
    expect(rows).toEqual([{ reason: 'Avtal med ny storkund från januari ger överskott de närmaste åren.' }])
    await expect(
      getPool().query(`UPDATE public.deferred_tax_items SET reason = 'Ändrad' WHERE journal_entry_id = $1`, [draft]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  // B1: the company column holds the latest year's framework. With 2027
  // elected K3, the open 2026 year is still K2 and takes no deferred tax;
  // 2027 does.
  it('refuses a K2 year whose next year is K3, and posts in the K3 year', async () => {
    const seed = await seedCompany()
    const y2027 = await insertFiscalPeriod({
      userId: seed.userId,
      companyId: seed.companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [seed.companyId])
    await setYearFramework(seed, 'k3', y2027)

    const k2Year = await assetDraft(seed, 20_600)
    await expect(commit(seed, k2Year, -20_600, -20_600, [lossItem(-20_600)])).rejects.toMatchObject({
      code: 'PT409',
      message: 'DEFERRED_TAX_NOT_APPLICABLE',
    })

    const next = { ...seed, fiscalPeriodId: y2027 }
    const k3Year = await insertDraft(
      next,
      [
        ['1370', 20_600, 0],
        ['8940', 0, 20_600],
      ],
      { entryDate: '2027-12-31' },
    )
    await expect(commit(next, k3Year, -20_600, -20_600, [lossItem(-20_600)])).resolves.toBeTruthy()
  })

  it('refuses a closed year', async () => {
    const seed = await k3Seed({ isClosed: true })
    const draft = await assetDraft(seed, 20_600).catch(() => null)
    // A closed year refuses the draft itself or the commit; nothing posts.
    if (draft) {
      await expect(commit(seed, draft, -20_600, -20_600, [lossItem(-20_600)])).rejects.toBeTruthy()
    }
    const { rowCount } = await getPool().query(
      `SELECT 1 FROM public.deferred_tax_items WHERE fiscal_period_id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(rowCount).toBe(0)
  })

  it('keeps the items immutable', async () => {
    const seed = await k3Seed()
    const entryId = await assetDraft(seed, 20_600)
    await commit(seed, entryId, -20_600, -20_600, [lossItem(-20_600)])
    await expect(
      getPool().query(`UPDATE public.deferred_tax_items SET deferred_tax = 0 WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`DELETE FROM public.deferred_tax_items WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('deferred_tax_assessments', () => {
  it('needs a reason to recognise a loss carried forward', async () => {
    const seed = await k3Seed()
    await expect(
      getPool().query(
        `INSERT INTO public.deferred_tax_assessments (company_id, fiscal_period_id, loss_recognised)
         VALUES ($1, $2, true)`,
        [seed.companyId, seed.fiscalPeriodId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await getPool().query(
      `INSERT INTO public.deferred_tax_assessments (company_id, fiscal_period_id, loss_recognised, loss_reason)
       VALUES ($1, $2, true, 'Avtal med ny storkund från januari ger överskott de närmaste åren.')`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.deferred_tax_assessments (company_id, fiscal_period_id) VALUES ($1, $2)`,
        [seed.companyId, seed.fiscalPeriodId],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})
