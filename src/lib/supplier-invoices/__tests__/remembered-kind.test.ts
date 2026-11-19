import { describe, it, expect } from 'vitest'
import { rememberedReverseChargeKind } from '../remembered-kind'

describe('rememberedReverseChargeKind', () => {
  it('is null for a supplier without invoices', () => {
    expect(rememberedReverseChargeKind([])).toBeNull()
  })

  it('takes the kind of the most recently registered invoice', () => {
    expect(
      rememberedReverseChargeKind([
        { reverse_charge_kind: 'eu_services', created_at: '2026-10-20T08:00:00+00:00' },
        { reverse_charge_kind: 'eu_goods', created_at: '2026-10-21T08:00:00+00:00' },
        { reverse_charge_kind: 'eu_services', created_at: '2026-10-19T08:00:00+00:00' },
      ]),
    ).toBe('eu_goods')
  })

  it('skips invoices that never answered, even when they are newer', () => {
    expect(
      rememberedReverseChargeKind([
        { reverse_charge_kind: 'eu_goods', created_at: '2026-10-20T08:00:00+00:00' },
        { reverse_charge_kind: null, created_at: '2026-10-22T08:00:00+00:00' },
      ]),
    ).toBe('eu_goods')
  })

  it('is null when no invoice answered', () => {
    expect(
      rememberedReverseChargeKind([
        { reverse_charge_kind: null, created_at: '2026-09-01T08:00:00+00:00' },
        { created_at: '2026-09-02T08:00:00+00:00' },
      ]),
    ).toBeNull()
  })

  it('ignores a value that is not a kind', () => {
    expect(rememberedReverseChargeKind([{ reverse_charge_kind: 'non_eu_services', created_at: '2026-10-01' }])).toBeNull()
  })
})
