import { describe, it, expect } from 'vitest'
import {
  buildAnlaggningstillgangarNote,
  computeRollforwardTotals,
  _buildRollforwardForTests,
  type AnlaggningAsset,
} from '../anlaggningstillgangar-note'

const PERIOD_START = '2025-01-01'
const PERIOD_END = '2025-12-31'

// Depreciation figures are resolved upstream (asset-note-figures.ts) from
// posted schedules; this suite supplies them and pins the aggregation and
// formatting only. The exact-amount assertions replace the old approximate
// bands: the builder must pass figures through verbatim.
function makeAsset(overrides: Partial<AnlaggningAsset> = {}): AnlaggningAsset {
  return {
    category: 'equipment',
    acquisition_date: '2024-01-01',
    acquisition_cost: 60_000,
    salvage_value: 0,
    useful_life_months: 60,
    disposed_at: null,
    figures: { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
    ...overrides,
  }
}

describe('buildAnlaggningstillgangarNote: roll-forward', () => {
  it('returns null when no assets fall in the period', () => {
    expect(
      buildAnlaggningstillgangarNote({
        noteNumber: 5,
        assets: [],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).toBeNull()
  })

  it('skips assets disposed before the period', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2020-01-01',
          acquisition_cost: 100_000,
          disposed_at: '2024-12-31',
          figures: { ibAck: 100_000, aretsAvskrivning: 0, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toEqual([])
  })

  it('records IB anskaffningsvärde and booked depreciation for assets acquired before the period', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(0)
    expect(r.ubAnskaffning).toBe(60_000)
    expect(r.ibAck).toBe(12_000)
    expect(r.aretsAvskrivning).toBe(12_000)
    expect(r.ubAck).toBe(24_000)
    expect(r.ubRedovisat).toBe(36_000)
  })

  it('records tillkommande for assets acquired during the period without any IB ack', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2025-07-01',
          figures: { ibAck: 999, aretsAvskrivning: 6_049, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(0)
    expect(r.tillkommande).toBe(60_000)
    // ibAck only accrues for assets acquired before the period, even if the
    // upstream figure carried a nonzero value.
    expect(r.ibAck).toBe(0)
    expect(r.aretsAvskrivning).toBe(6_049)
  })

  it('records avgående and the reversed accumulated depreciation for in-period disposals', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2023-01-01',
          disposed_at: '2025-06-30',
          figures: { ibAck: 24_000, aretsAvskrivning: 5_951, avgaendeAck: 29_951 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.avgaende).toBe(60_000)
    expect(r.ubAnskaffning).toBe(0)
    expect(r.avgaendeAck).toBe(29_951)
    expect(r.ubAck).toBe(0)
    expect(r.ubRedovisat).toBe(0)
  })

  it('groups multiple assets in the same category', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          acquisition_date: '2025-01-01',
          acquisition_cost: 40_000,
          figures: { ibAck: 0, aretsAvskrivning: 8_000, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(40_000)
    expect(r.ubAnskaffning).toBe(100_000)
    expect(r.aretsAvskrivning).toBe(20_000)
    expect(r.ubAck).toBe(32_000)
  })

  it('separates categories', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          category: 'computer',
          acquisition_cost: 20_000,
          useful_life_months: 36,
          figures: { ibAck: 6_667, aretsAvskrivning: 6_667, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.category === 'equipment')?.ibAnskaffning).toBe(60_000)
    expect(rows.find((r) => r.category === 'computer')?.ibAnskaffning).toBe(20_000)
  })

  it('emits a note with all expected lines when assets exist', () => {
    const note = buildAnlaggningstillgangarNote({
      noteNumber: 5,
      assets: [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })
    expect(note).not.toBeNull()
    expect(note!.number).toBe(5)
    expect(note!.title).toBe('Anläggningstillgångar')
    expect(note!.body).toContain('Inventarier')
    expect(note!.body).toContain('Ingående anskaffningsvärde')
    expect(note!.body).toContain('Utgående anskaffningsvärde')
    expect(note!.body).toContain('Ingående ackumulerade avskrivningar')
    // sv-SE formatting uses a non-breaking thousands separator: build the
    // expected strings with the same formatter instead of literal spaces.
    const sv = (n: number) => n.toLocaleString('sv-SE')
    expect(note!.body).toContain(`Årets avskrivningar: -${sv(12_000)} kr`)
    expect(note!.body).toContain(`Utgående redovisat värde: ${sv(36_000)} kr`)
  })

  it('passes upstream figures through verbatim without recomputing', () => {
    // Deliberately "impossible" figures for the asset's schedule: the
    // builder must not derive anything from cost/life/dates on its own.
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 1_234.56, aretsAvskrivning: 7_890.12, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows[0].ibAck).toBe(1_234.56)
    expect(rows[0].aretsAvskrivning).toBe(7_890.12)
    expect(rows[0].ubAck).toBe(9_124.68)
  })

  it('caps at the depreciable base only via upstream figures (fully depreciated asset)', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2010-01-01',
          figures: { ibAck: 60_000, aretsAvskrivning: 0, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows[0].ibAck).toBe(60_000)
    expect(rows[0].aretsAvskrivning).toBe(0)
    expect(rows[0].ubAck).toBe(60_000)
    expect(rows[0].ubRedovisat).toBe(0)
  })
})

describe('computeRollforwardTotals', () => {
  it('sums closing book value and accumulated depreciation across categories', () => {
    const totals = computeRollforwardTotals(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          category: 'computer',
          acquisition_cost: 20_000,
          figures: { ibAck: 6_667, aretsAvskrivning: 6_667, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    // equipment: 60,000 - 24,000 = 36,000; computer: 20,000 - 13,334 = 6,666
    expect(totals.ubAck).toBe(37_334)
    expect(totals.ubRedovisat).toBe(42_666)
  })
})
