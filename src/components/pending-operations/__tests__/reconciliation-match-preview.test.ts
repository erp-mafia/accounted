/**
 * The approval card of a reconciliation_match (crm#1147). Reported: the card
 * of "Koppla 8 rad(er) på skattekonto" showed a pair count and a source, so
 * the reviewer could not see which Skatteverket rows went to which verifikat.
 * The card must show, per pair, the rows (date, text, amount), their sum and
 * the verifikat with what it holds on the account, and must keep working for
 * an operation staged before those details existed. Amounts are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatCurrency } from '@/lib/utils'

// The real Swedish strings, so a missing key shows as its raw name.
vi.mock('next-intl', async () => {
  const sv = (await import('@/messages/sv.json')).default as { pending: Record<string, unknown> }
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], sv.pending)
  const t = (key: string, values?: Record<string, unknown>) => {
    const text = lookup(key)
    return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name])) : key
  }
  return { useTranslations: () => Object.assign(t, { has: (key: string) => typeof lookup(key) === 'string' }) }
})

const { OperationPreview } = await import('../OperationPreview')
const { hasReconciliationMatchDetails } = await import('../ReconciliationMatchPreview')

const render = (preview_data: Record<string, unknown>, detail = false) =>
  renderToStaticMarkup(
    createElement(OperationPreview, { op: { operation_type: 'reconciliation_match', preview_data }, detail }),
  )

const sek = (amount: number) => formatCurrency(amount, 'SEK')

const ROW_TAX = '11111111-1111-4111-8111-111111111111'
const ROW_FEE = '22222222-2222-4222-8222-222222222222'
const ENTRY = '33333333-3333-4333-8333-333333333333'

/** What gnubok_reconcile_match staged before the details existed. */
const LEGACY = {
  account_key: 'skattekonto',
  pair_count: 1,
  pairs: [{ external_ids: [ROW_TAX, ROW_FEE], journal_entry_ids: [ENTRY] }],
  skipped_at_stage: [],
  source: 'explicit',
}

const payrollPair = (extra: Record<string, unknown> = {}) => ({
  rows: [
    { external_id: ROW_TAX, date: '2026-09-14', text: 'Avdragen skatt augusti 2026', amount: -4521 },
    { external_id: ROW_FEE, date: '2026-09-16', text: 'Arbetsgivaravgift augusti 2026', amount: -7704 },
  ],
  row_count: 2,
  rows_total: -12225,
  entries: [
    {
      journal_entry_id: ENTRY,
      voucher_series: 'A',
      voucher_number: 412,
      entry_date: '2026-09-14',
      description: 'Skattekonto september',
      account_debit: 12225,
      account_credit: 12225,
    },
  ],
  ...extra,
})

const ENRICHED = {
  ...LEGACY,
  ledger_account: '1630',
  pair_details: [payrollPair({ already_linked_count: 1, already_linked_total: 12225, remainder_amount: 0 })],
}

describe('the approval card of a reconciliation_match (crm#1147)', () => {
  it('shows each row with date, text and amount, their sum, and the verifikat with its amounts on the account', () => {
    const html = render(ENRICHED, true)

    for (const text of ['2026-09-14', 'Avdragen skatt augusti 2026', '2026-09-16', 'Arbetsgivaravgift augusti 2026']) {
      expect(html).toContain(text)
    }
    for (const amount of [-4521, -7704, -12225]) expect(html).toContain(sek(amount))
    expect(html).toContain('Summa')
    // The verifikat: series and number, date, text.
    expect(html).toContain('A412')
    expect(html).toContain('Skattekonto september')
    expect(html).toContain('På konto 1630')
    expect(html).toContain(`debet ${sek(12225)}, kredit ${sek(12225)}`)
    // The sum check: the payment row already on the verifikat is part of it.
    expect(html).toContain('Redan kopplat')
    expect(html).toContain(`${sek(12225)} (1 st)`)
    expect(html).toContain('Summan stämmer: tillsammans med det som redan är kopplat')
  })

  it('never shows an id or a staging field name', () => {
    const html = render(ENRICHED, true)
    for (const raw of [ROW_TAX, ROW_FEE, ENTRY, 'pair_details', 'external_id', 'account_key', 'explicit', 'skipped_at_stage']) {
      expect(html).not.toContain(raw)
    }
  })

  it('says what stays on the verifikat when the rows do not explain all of it', () => {
    const html = render({ ...ENRICHED, pair_details: [payrollPair({ remainder_amount: 12225 })] }, true)
    expect(html).toContain(`Kvar på verifikatet efter kopplingen: ${sek(12225)}`)
    expect(html).not.toContain('Summan stämmer')
  })

  it('says the sum matches without "already linked" when nothing was linked before', () => {
    const html = render({ ...ENRICHED, pair_details: [payrollPair({ remainder_amount: 0 })] }, true)
    expect(html).toContain('Summan stämmer: händelserna motsvarar hela verifikatets belopp på kontot.')
    expect(html).not.toContain('Redan kopplat')
  })

  it('states both sums and no verdict for a bank pair, in the rows\' own currency', () => {
    const html = render(
      {
        account_key: 'bank:44444444-4444-4444-8444-444444444444',
        pair_count: 1,
        ledger_account: '1932',
        pair_details: [
          {
            rows: [{ external_id: ROW_TAX, date: '2026-09-02', text: 'Payment', amount: 100, currency: 'EUR' }],
            row_count: 1,
            rows_total: 100,
            rows_currency: 'EUR',
            entries: [
              { journal_entry_id: ENTRY, voucher_series: 'B', voucher_number: 7, entry_date: '2026-09-02', description: 'EUR-betalning', account_debit: 1130, account_credit: 0 },
            ],
          },
        ],
      },
      true,
    )
    expect(html).toContain(formatCurrency(100, 'EUR'))
    expect(html).not.toContain(sek(100))
    expect(html).toContain('B7')
    expect(html).toContain('På konto 1932')
    expect(html).toContain(`debet ${sek(1130)}`)
    expect(html).not.toContain('kredit')
    expect(html).not.toContain('Summan stämmer')
    expect(html).not.toContain('Kvar på verifikatet')
  })

  it('shows the slice per verifikat of a row split over several', () => {
    const html = render(
      {
        account_key: 'bank:44444444-4444-4444-8444-444444444444',
        pair_count: 1,
        ledger_account: '1930',
        pair_details: [
          {
            rows: [{ external_id: ROW_TAX, date: '2026-09-02', text: 'Leverantörsbetalning', amount: -800 }],
            row_count: 1,
            rows_total: -800,
            entries: [
              { journal_entry_id: ENTRY, voucher_series: 'A', voucher_number: 40, entry_date: '2026-09-01', description: 'Faktura 1', account_debit: 0, account_credit: 500, allocated_amount: -500 },
              { journal_entry_id: ROW_FEE, voucher_series: 'A', voucher_number: 41, entry_date: '2026-09-01', description: 'Faktura 2', account_debit: 0, account_credit: 300, allocated_amount: -300 },
            ],
          },
        ],
      },
      true,
    )
    for (const text of ['A40', 'A41', 'Faktura 1', 'Faktura 2', 'Andel av händelsen', sek(-500), sek(-300), sek(-800)]) {
      expect(html).toContain(text)
    }
  })

  it('stops after three pairs and five rows outside the review panel, and counts the rest', () => {
    const pair = (n: number) =>
      payrollPair({
        rows: Array.from({ length: 7 }, (_, i) => ({ external_id: `r-${n}-${i}`, date: `2026-09-0${i + 1}`, text: `Par ${n} rad ${i + 1}`, amount: -1 })),
        row_count: 7,
        rows_total: -7,
      })
    const data = { ...LEGACY, pair_count: 5, ledger_account: '1630', pair_details: [1, 2, 3, 4, 5].map(pair) }

    const compact = render(data)
    expect(compact).toContain('Kopplingar: 5')
    expect(compact).toContain('Par 3 rad 5')
    expect(compact).not.toContain('Par 3 rad 6')
    expect(compact).not.toContain('Par 4 rad 1')
    // The sum still covers every row of the pair.
    expect(compact).toContain(sek(-7))

    const full = render(data, true)
    expect(full).toContain('Par 5 rad 7')
  })

  it('shows verifikat linked against each other from the dry run\'s own list, also for an older operation', () => {
    const settled = {
      account_key: 'bank:44444444-4444-4444-8444-444444444444',
      pair_count: 1,
      pairs: [{ external_ids: [], journal_entry_ids: [ENTRY, ROW_FEE] }],
      settled: [
        {
          settlement_id: null,
          account_number: '1930',
          entries: [
            { journal_entry_id: ENTRY, voucher_series: 'A', voucher_number: 55, entry_date: '2026-08-03', amount: 900 },
            { journal_entry_id: ROW_FEE, voucher_series: 'A', voucher_number: 61, entry_date: '2026-08-20', amount: -900 },
          ],
        },
      ],
      skipped_at_stage: [],
      source: 'explicit',
    }
    const html = render(settled, true)
    expect(html).toContain('Verifikat som kopplas mot varandra på konto 1930')
    for (const text of ['A55', 'A61', '2026-08-03', sek(900), sek(-900)]) expect(html).toContain(text)
  })
})

describe('an operation staged before the details existed', () => {
  it('keeps the generic preview, exactly as before', () => {
    expect(hasReconciliationMatchDetails(LEGACY)).toBe(false)
    const html = render(LEGACY, true)
    const generic = renderToStaticMarkup(
      createElement(OperationPreview, { op: { operation_type: 'some_unknown_operation', preview_data: LEGACY }, detail: true }),
    )
    expect(html).toBe(generic)
    expect(html).toContain('Antal par')
  })

  it.each([
    ['null', null],
    ['a string', 'details'],
    ['an empty list', []],
    ['a list of non-objects', [1, 'x', null]],
    ['a pair without rows', [{ rows: [], row_count: 0, rows_total: 0, entries: [] }]],
    ['a pair with a malformed row', [payrollPair({ rows: [{ date: 20260914, text: null, amount: 'x' }] })]],
    ['a pair with a malformed verifikat', [payrollPair({ entries: [{ voucher_number: 412 }] })]],
    ['a pair without its sum', [payrollPair({ rows_total: undefined })]],
  ])('never crashes on %s for pair_details: falls back to the generic preview', (_label, pair_details) => {
    const data = { ...LEGACY, pair_details }
    expect(hasReconciliationMatchDetails(data)).toBe(false)
    expect(() => render(data, true)).not.toThrow()
    expect(render(data, true)).toContain('Antal par')
  })

  it('renders the readable pairs and counts the ones it cannot read', () => {
    const html = render(
      { ...LEGACY, pair_count: 3, ledger_account: '1630', pair_details: [payrollPair(), { rows: 'broken' }, null] },
      true,
    )
    expect(html).toContain('Avdragen skatt augusti 2026')
    expect(html).toContain('visas inte här')
  })

  it('tolerates missing optional fields on a pair', () => {
    const html = render(
      {
        pair_details: [
          {
            rows: [{ date: '2026-09-14', text: '', amount: -1 }],
            row_count: 1,
            rows_total: null,
            entries: [{ entry_date: '2026-09-14', description: '', account_debit: 0, account_credit: 0 }],
          },
        ],
      },
      true,
    )
    expect(html).toContain('På kontot')
    expect(html).toContain(sek(-1))
  })
})
