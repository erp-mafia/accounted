import { describe, expect, it } from 'vitest'
import { fxDeviationTooLarge, FX_SAME_DOCUMENT_LIMIT } from '@/lib/bookkeeping/fx-settlement'
import { oreSettlementResidual } from '@/lib/bookkeeping/ore-rounding'
import { ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { getPool } from '@/tests/pg/setup'

/**
 * The bands the SQL doors read beside their TypeScript definitions, on one
 * table of amounts. A band has one definition per language because
 * match_batch_allocate needs it inside its transaction; this is what keeps
 * them the same band.
 */
describe('public.ore_settlement_residual and oreSettlementResidual', () => {
  const PAIRS: ReadonlyArray<[owed: number, bank: number]> = [
    [100, 100],
    [100, 99.01],
    [100, 99],
    [100, 98.99],
    [100, 100.99],
    [100, 101],
    [100, 101.01],
    [100, 100.5],
    [533.75, 534],
    [533.75, 533],
    [0.5, 0],
    [0, 0.99],
    [12345.67, 12346],
    [1.005, 1],
    [1.004, 1],
  ]

  it.each(PAIRS)('owed %d, bank %d', async (owed, bank) => {
    const { rows } = await getPool().query<{ residual: string }>(
      'SELECT public.ore_settlement_residual($1::numeric, $2::numeric) AS residual',
      [String(owed), String(bank)],
    )
    expect(Number(rows[0].residual)).toBe(oreSettlementResidual(owed, bank))
  })

  it('is strictly under the band constant on both sides', async () => {
    const edge = String(100 + ORE_ROUNDING_SETTLEMENT_MAX)
    const { rows } = await getPool().query<{ over: string; under: string }>(
      `SELECT public.ore_settlement_residual(100, $1::numeric) AS over,
              public.ore_settlement_residual($1::numeric, 100) AS under`,
      [edge],
    )
    expect([Number(rows[0].over), Number(rows[0].under)]).toEqual([0, 0])
  })
})

describe('public.fx_deviation_too_large and fxDeviationTooLarge', () => {
  it.each([
    [1100, 1000],
    [1100.01, 1000],
    [900, 1000],
    [899.99, 1000],
    [2161.94, 1965.4],
    [2161.95, 1965.4],
    [-950, -1000],
    [-800, -1000],
    [5700, 11300],
  ])('%d against %d booked', async (sek, booked) => {
    const { rows } = await getPool().query<{ too_large: boolean }>(
      'SELECT public.fx_deviation_too_large($1::numeric, $2::numeric) AS too_large',
      [String(sek), String(booked)],
    )
    expect(rows[0].too_large).toBe(fxDeviationTooLarge(sek, booked))
  })

  it('is the limit the module names', () => {
    expect(fxDeviationTooLarge(1000 * (1 + FX_SAME_DOCUMENT_LIMIT), 1000)).toBe(false)
  })
})
