import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20261031110200_journal_entries_company_list_order_indexes.sql.
 *
 * The verifikat list's all-years path orders one company's entries by date
 * (entry_date, voucher_series, voucher_number, id) or by voucher
 * (voucher_series, voucher_number, id), all keys in one direction, and keeps
 * the first page. What makes that a bounded range scan is a catalog property:
 * a plain (non-partial) btree whose keys are company_id followed by exactly
 * the list's sort keys, in that order. That is what this asserts, so a later
 * "redundant index" cleanup cannot drop or reorder them unnoticed.
 *
 * Deliberately NOT asserted: the EXPLAIN shape. A fresh fixture holds a
 * handful of rows, where the planner rightly prefers a sort or a seq scan
 * whatever indexes exist (see targeted-fk-indexes.pg.test.ts for the same
 * reasoning).
 */

const EXPECTED: Record<string, string[]> = {
  idx_journal_entries_company_date_voucher: ['company_id', 'entry_date', 'voucher_series', 'voucher_number', 'id'],
  idx_journal_entries_company_voucher: ['company_id', 'voucher_series', 'voucher_number', 'id'],
}

type IndexRow = {
  index_name: string
  columns: string[]
  predicate: string | null
  is_unique: boolean
}

async function loadIndexes(): Promise<Map<string, IndexRow>> {
  const { rows } = await getPool().query<IndexRow>(
    `SELECT ci.relname AS index_name,
            array_agg(a.attname::text ORDER BY k.ord) AS columns,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            i.indisunique AS is_unique
       FROM pg_index i
       JOIN pg_class ci ON ci.oid = i.indexrelid
       CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = 'public.journal_entries'::regclass
        AND ci.relname = ANY($1::text[])
      GROUP BY ci.relname, i.indpred, i.indrelid, i.indisunique`,
    [Object.keys(EXPECTED)],
  )
  return new Map(rows.map((row) => [row.index_name, row]))
}

describe('journal_entries list order indexes.pg', () => {
  it('creates both indexes on journal_entries', async () => {
    const found = await loadIndexes()
    expect([...found.keys()].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it('keys each index on company_id followed by exactly the list sort keys', async () => {
    const found = await loadIndexes()
    for (const [name, columns] of Object.entries(EXPECTED)) {
      expect({ name, columns: found.get(name)?.columns }).toEqual({ name, columns })
    }
  })

  it('keeps them plain: no predicate the list filter would have to imply, not unique', async () => {
    const found = await loadIndexes()
    for (const name of Object.keys(EXPECTED)) {
      expect({ name, predicate: found.get(name)?.predicate ?? null, unique: found.get(name)?.is_unique }).toEqual({
        name,
        predicate: null,
        unique: false,
      })
    }
  })
})
