import { describe, it, expect } from 'vitest'
import {
  buildAnlaggningstillgangarNote,
  _buildRollforwardForTests,
} from '../anlaggningstillgangar-note'

const PERIOD_START = '2025-01-01'
const PERIOD_END = '2025-12-31'

describe('buildAnlaggningstillgangarNote — roll-forward', () => {
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
        {
          category: 'equipment',
          acquisition_date: '2020-01-01',
          acquisition_cost: 100_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: '2024-12-31',
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toEqual([])
  })

  it('records IB anskaffningsvärde for assets acquired before the period', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2024-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(0)
    expect(r.ubAnskaffning).toBe(60_000)
    // 1 year of depreciation on the books at IB (Jan 1 2024 → Dec 31 2024)
    expect(r.ibAck).toBeGreaterThan(11_500)
    expect(r.ibAck).toBeLessThan(12_500)
    // Year's depreciation ≈ 12,000 (60,000 / 5)
    expect(r.aretsAvskrivning).toBeGreaterThan(11_500)
    expect(r.aretsAvskrivning).toBeLessThan(12_500)
  })

  it('records tillkommande for assets acquired during the period', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2025-07-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(0)
    expect(r.tillkommande).toBe(60_000)
    expect(r.ibAck).toBe(0)
    // ~6 months depreciation ≈ 6,000
    expect(r.aretsAvskrivning).toBeGreaterThan(5_500)
    expect(r.aretsAvskrivning).toBeLessThan(6_500)
  })

  it('records avgående for assets disposed during the period', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2023-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: '2025-06-30',
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.avgaende).toBe(60_000)
    expect(r.ubAnskaffning).toBe(0)
    // Disposed asset: at IB it had 2 years of depreciation ≈ 24,000;
    // at disposal it had ~2.5 years ≈ 30,000.
    expect(r.avgaendeAck).toBeGreaterThan(29_000)
    expect(r.avgaendeAck).toBeLessThan(31_000)
  })

  it('groups multiple assets in the same category', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2024-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
        {
          category: 'equipment',
          acquisition_date: '2025-01-01',
          acquisition_cost: 40_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(40_000)
    expect(r.ubAnskaffning).toBe(100_000)
  })

  it('separates categories', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2024-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
        {
          category: 'computer',
          acquisition_date: '2024-01-01',
          acquisition_cost: 20_000,
          salvage_value: 0,
          useful_life_months: 36,
          disposed_at: null,
        },
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
        {
          category: 'equipment',
          acquisition_date: '2024-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
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
    expect(note!.body).toContain('Utgående redovisat värde')
  })

  it('respects salvage_value when computing depreciation', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2024-01-01',
          acquisition_cost: 60_000,
          salvage_value: 10_000,
          useful_life_months: 60,
          disposed_at: null,
        },
      ],
      PERIOD_START,
      PERIOD_END,
    )
    // Depreciable base 50,000 over 5 years → 10,000/yr (not 12,000)
    expect(rows[0].aretsAvskrivning).toBeGreaterThan(9_500)
    expect(rows[0].aretsAvskrivning).toBeLessThan(10_500)
  })

  it('caps accumulated depreciation at depreciable base after useful life', () => {
    const rows = _buildRollforwardForTests(
      [
        {
          category: 'equipment',
          acquisition_date: '2010-01-01',
          acquisition_cost: 60_000,
          salvage_value: 0,
          useful_life_months: 60,
          disposed_at: null,
        },
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
