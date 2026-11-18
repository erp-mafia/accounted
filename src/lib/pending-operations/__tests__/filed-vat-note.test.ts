/**
 * The filed-momsperiod note on a staged operation (../filed-vat-note.ts):
 * which dates each judged type is asked about, what it hands the VAT block's
 * check, read off the staged row, and the note it becomes. The filed periods
 * and the check are stubbed here; the real chain is
 * lib/vat/__tests__/filed-period-chain.test.ts, and the check's own test is
 * lib/vat/__tests__/voucher-filed-period-warning.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const filed = vi.hoisted(() => ({ dates: new Set<string>() }))
vi.mock('@/lib/vat/filed-period-for-date', () => ({
  filedVatPeriodsOfDates: vi.fn(async (_s: unknown, _c: unknown, dates: readonly string[]) => {
    const q3 = { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-11' }
    return new Map(dates.filter((d) => filed.dates.has(d)).map((d) => [d, q3]))
  }),
}))
const leaf = vi.hoisted(() => ({ filedPeriodVoucherWarning: vi.fn() }))
vi.mock('@/lib/vat/voucher-filed-period-warning', async (importOriginal) => ({
  describeFiledPeriods: (await importOriginal<typeof import('@/lib/vat/voucher-filed-period-warning')>()).describeFiledPeriods,
  filedPeriodVoucherWarning: leaf.filedPeriodVoucherWarning,
}))

import { stagedFiledVatNote } from '../filed-vat-note'

const log = { warn: vi.fn() }
const Q2 = { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-17' }
const Q3 = { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-11' }
const warningFor = (periods: unknown[]) => ({
  code: 'VAT_PERIOD_ALREADY_FILED',
  message_sv: 'sv',
  message_en: 'en',
  details: { entry_date: '2026-09-27', filed_periods: periods },
})

/** A database that answers the corrected verifikat's read (source type and lines), and records it. */
function db(entry: { source_type: string; lines: unknown[] } | null = { source_type: 'manual', lines: [] }) {
  const read = vi.fn(async (..._query: unknown[]) => ({ data: entry, error: null }))
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (c1: string, v1: string) => ({
          eq: (c2: string, v2: string) => ({ maybeSingle: () => read(table, columns, { [c1]: v1, [c2]: v2 }) }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
  return { client, read }
}

const purchase = [
  { account_number: '6540', debit_amount: 400, credit_amount: 0, line_description: 'Loopia' },
  { account_number: '2641', debit_amount: 100, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 500 },
]
const bare = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>) =>
  lines.map(({ account_number, debit_amount, credit_amount }) => ({ account_number, debit_amount, credit_amount }))
const mirrored = purchase.map((l) => ({ ...l, debit_amount: l.credit_amount, credit_amount: l.debit_amount }))

beforeEach(() => {
  vi.clearAllMocks()
  filed.dates = new Set(['2026-09-27'])
  leaf.filedPeriodVoucherWarning.mockResolvedValue(null)
})

describe('stagedFiledVatNote: what each judged type posts', () => {
  it('a bank row: the lines of the preview on the row\'s own date, with nothing read', async () => {
    const { client, read } = db()

    await stagedFiledVatNote(
      client,
      'c-1',
      { operation_type: 'categorize_transaction', params: { transaction_id: 't-1' }, preview_data: { date: '2026-09-27', lines: purchase } },
      log,
    )

    expect(read).not.toHaveBeenCalled()
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', { entry_date: '2026-09-27', lines: bare(purchase) })
  })

  it('a makulering: the storno\'s mirrored lines on the storno\'s date, as an ingående balans when the original is one', async () => {
    const { client, read } = db({ source_type: 'opening_balance', lines: purchase })

    await stagedFiledVatNote(
      client,
      'c-1',
      {
        operation_type: 'reverse_entry',
        params: { entry_id: 'e-1' },
        preview_data: { original: { entry_date: '2026-09-27', lines: purchase }, reversal: { entry_date: '2026-09-27', lines: mirrored } },
      },
      log,
    )

    expect(read).toHaveBeenCalledWith(
      'journal_entries',
      'source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)',
      { id: 'e-1', company_id: 'c-1' },
    )
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', {
      entry_date: '2026-09-27',
      lines: bare(mirrored),
      opening_balance: true,
    })
  })

  it('a rättelse: the new lines in and the original out, both on the original\'s date', async () => {
    const { client } = db()
    const corrected = [{ ...purchase[0], account_number: '5410' }, purchase[1], purchase[2]]

    await stagedFiledVatNote(
      client,
      'c-1',
      {
        operation_type: 'correct_entry',
        params: { entry_id: 'e-1', lines: corrected },
        preview_data: { original: { entry_date: '2026-09-27', lines: purchase } },
      },
      log,
    )

    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', {
      entry_date: '2026-09-27',
      lines: bare(corrected),
      replaces: { entry_date: '2026-09-27', lines: bare(purchase) },
      opening_balance: false,
    })
  })

  it('struck lines: the verifikat before (resulting without the added, with the struck) and after (resulting)', async () => {
    const { client } = db()
    // A momsredovisning corrected inside itself: 2611 and 2641 struck and
    // re-added with new amounts, 2650 kept. Judged whole, it stays a
    // momsredovisning on both sides.
    const kept = { account_number: '2650', debit_amount: 0, credit_amount: 1000 }
    const struck = [
      { account_number: '2611', debit_amount: 2500, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1500 },
    ]
    const added = [
      { account_number: '2611', debit_amount: 2600, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 1600 },
    ]

    await stagedFiledVatNote(
      client,
      'c-1',
      {
        operation_type: 'correct_entry_lines_inline',
        params: { journal_entry_id: 'e-1' },
        preview_data: {
          journal_entry_id: 'e-1',
          entry_date: '2026-09-27',
          struck_lines: struck,
          added_lines: added,
          resulting_lines: [kept, ...added],
        },
      },
      log,
    )

    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', {
      entry_date: '2026-09-27',
      lines: [kept, ...added],
      replaces: { entry_date: '2026-09-27', lines: [kept, ...struck] },
      opening_balance: false,
    })
  })

  it('struck lines: an added line identical to a kept one takes only itself out of the verifikat before', async () => {
    const { client } = db()
    const kept = { account_number: '6540', debit_amount: 200, credit_amount: 0 }
    const struck = [{ account_number: '2641', debit_amount: 100, credit_amount: 0 }]
    const bank = { account_number: '1930', debit_amount: 0, credit_amount: 500 }
    // The moms line is struck and its 100 goes onto a second 6540 line of 200
    // beside the one already there... as two identical lines after.
    const added = [{ account_number: '6540', debit_amount: 200, credit_amount: 0 }, { account_number: '6540', debit_amount: 100, credit_amount: 0 }]
    const before = [kept, bank, struck[0]]

    await stagedFiledVatNote(
      client,
      'c-1',
      {
        operation_type: 'correct_entry_lines_inline',
        params: {},
        preview_data: {
          journal_entry_id: 'e-1',
          entry_date: '2026-09-27',
          struck_lines: struck,
          added_lines: added,
          resulting_lines: [kept, bank, ...added],
        },
      },
      log,
    )

    const [, , posting] = leaf.filedPeriodVoucherWarning.mock.calls[0]
    const sorted = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>) =>
      [...lines].sort((a, b) => `${a.account_number} ${a.debit_amount} ${a.credit_amount}`.localeCompare(`${b.account_number} ${b.debit_amount} ${b.credit_amount}`))
    // Before: the kept 6540 200 is still there once, although an added line
    // equals it. The declaration reads the lines as a set, so the order is free.
    expect(sorted(posting.replaces.lines)).toEqual(sorted(before))
    expect(posting.lines).toEqual([kept, bank, ...added])
  })

  it('a redate: the same lines out on the old date and in on the new one', async () => {
    const { client } = db()
    filed.dates = new Set(['2026-09-30'])

    await stagedFiledVatNote(
      client,
      'c-1',
      {
        operation_type: 'redate_entry',
        params: { journal_entry_id: 'e-1', new_entry_date: '2026-09-30' },
        preview_data: {
          journal_entry_id: 'e-1',
          storno: { entry_date: '2026-10-05', lines: mirrored },
          corrected: { entry_date: '2026-09-30', lines: purchase },
        },
      },
      log,
    )

    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', {
      entry_date: '2026-09-30',
      lines: bare(purchase),
      replaces: { entry_date: '2026-10-05', lines: bare(purchase) },
      opening_balance: false,
    })
  })

  it('a date corrected inside the verifikat: its lines, read, out on the old date and in on the new one', async () => {
    const { client, read } = db({ source_type: 'manual', lines: purchase })
    filed.dates = new Set(['2026-09-30'])
    const row = (old_entry_date: string, new_entry_date: string) => ({
      operation_type: 'correct_entry_metadata',
      params: { journal_entry_id: 'e-1' },
      preview_data: { journal_entry_id: 'e-1', old_entry_date, new_entry_date },
    })

    await stagedFiledVatNote(client, 'c-1', row('2026-10-05', '2026-09-30'), log)
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(client, 'c-1', {
      entry_date: '2026-09-30',
      lines: bare(purchase),
      replaces: { entry_date: '2026-10-05', lines: bare(purchase) },
      opening_balance: false,
    })

    // Only the text changes: nothing to ask, nothing read.
    read.mockClear()
    leaf.filedPeriodVoucherWarning.mockClear()
    expect(await stagedFiledVatNote(client, 'c-1', row('2026-09-30', '2026-09-30'), log)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('reads nothing and asks nothing when no date lies in a filed period', async () => {
    const { client, read } = db()
    filed.dates = new Set()

    expect(
      await stagedFiledVatNote(
        client,
        'c-1',
        { operation_type: 'reverse_entry', params: { entry_id: 'e-1' }, preview_data: { reversal: { entry_date: '2026-10-20', lines: mirrored } } },
        log,
      ),
    ).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('asks nothing of a type it does not judge, create_voucher included (the guard asks that one)', async () => {
    const { client } = db()
    for (const operation_type of ['create_voucher', 'create_invoice', 'update_bookkeeping_lock', 'submit_vat_declaration']) {
      expect(
        await stagedFiledVatNote(client, 'c-1', { operation_type, params: { entry_date: '2026-09-27', lines: purchase }, preview_data: {} }, log),
      ).toBeNull()
    }
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })

  it('asks nothing of a row that states no lines or no date', async () => {
    const { client } = db()
    const rows = [
      { operation_type: 'categorize_transaction', params: {}, preview_data: { date: '2026-09-27' } },
      { operation_type: 'categorize_transaction', params: {}, preview_data: { lines: purchase } },
      { operation_type: 'categorize_transaction', params: {}, preview_data: { date: '2026-09-27', lines: [{ debit_amount: 1 }] } },
      { operation_type: 'reverse_entry', params: {}, preview_data: {} },
      { operation_type: 'correct_entry', params: { lines: purchase }, preview_data: {} },
      { operation_type: 'correct_entry', params: {}, preview_data: null },
      { operation_type: 'correct_entry_lines_inline', params: {}, preview_data: { entry_date: '2026-09-27', struck_lines: [], added_lines: [], resulting_lines: purchase } },
    ]
    for (const row of rows) expect(await stagedFiledVatNote(client, 'c-1', row, log)).toBeNull()
    expect(leaf.filedPeriodVoucherWarning).not.toHaveBeenCalled()
  })
})

describe('stagedFiledVatNote: the note', () => {
  const row = { operation_type: 'categorize_transaction', params: {}, preview_data: { date: '2026-09-27', lines: purchase } }

  it('names the filed period, its filing date and what approving means, in Swedish like the proposal', async () => {
    leaf.filedPeriodVoucherWarning.mockResolvedValue(warningFor([{ ...Q3, rutor_change: { ruta48: 100 } }]))

    expect(await stagedFiledVatNote(db().client, 'c-1', row, log)).toBe(
      'Momsdeklarationen för 2026-Q3 är redan inlämnad (2026-11-11), och bokningen ändrar underlaget för den. ' +
        'Godkänns förslaget kan deklarationen behöva rättas.',
    )
  })

  it('speaks of both declarations in the plural when a move touches two filed periods', async () => {
    leaf.filedPeriodVoucherWarning.mockResolvedValue(
      warningFor([
        { ...Q2, rutor_change: { ruta48: -100 } },
        { ...Q3, rutor_change: { ruta48: 100 } },
      ]),
    )
    filed.dates = new Set(['2026-06-30', '2026-09-27'])

    const note = await stagedFiledVatNote(
      db().client,
      'c-1',
      {
        operation_type: 'redate_entry',
        params: {},
        preview_data: { journal_entry_id: 'e-1', storno: { entry_date: '2026-06-30', lines: mirrored }, corrected: { entry_date: '2026-09-27', lines: purchase } },
      },
      log,
    )

    expect(note).toBe(
      'Momsdeklarationerna för 2026-Q2 (inlämnad 2026-08-17) och 2026-Q3 (inlämnad 2026-11-11) är redan inlämnade, ' +
        'och flytten ändrar underlaget för dem. Godkänns förslaget kan deklarationerna behöva rättas.',
    )
  })

  it('is no note when the approval changes the underlag for no filed declaration', async () => {
    expect(await stagedFiledVatNote(db().client, 'c-1', row, log)).toBeNull()
  })

  it('is no note, and never an error, when the check cannot be made', async () => {
    leaf.filedPeriodVoucherWarning.mockRejectedValue(new Error('filing record unreadable'))

    expect(await stagedFiledVatNote(db().client, 'c-1', row, log)).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
