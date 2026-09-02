import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

/**
 * Parties, phase 0 (migration 20260902120000): pg_trgm is available for
 * trigram blocking of counterparty keys, and the two context-graph tables
 * whose feature code was never merged are gone, so local replays agree with
 * prod (where they were dropped during the context-graph revert).
 */
describe('parties phase 0 (pg)', () => {
  it('pg_trgm is installed', async () => {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`,
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('trigram similarity ranks the same vendor above a different one', async () => {
    const { rows } = await getPool().query<{ same: number; other: number }>(
      `SELECT extensions.similarity('levfakt beijer byggmaterial 097', 'beijer byggmaterial') AS same,
              extensions.similarity('levfakt beijer byggmaterial 097', 'skelleftea plat') AS other`,
    )
    expect(Number(rows[0]!.same)).toBeGreaterThan(Number(rows[0]!.other))
    expect(Number(rows[0]!.same)).toBeGreaterThan(0.3)
  })

  it('the reverted context-graph tables are gone', async () => {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('graph_counterparties', 'graph_transaction_counterparties')`,
    )
    expect(rows[0]!.n).toBe(0)
  })
})
