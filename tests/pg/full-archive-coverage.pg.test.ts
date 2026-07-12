import { describe, it, expect, beforeAll } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  MASTER_DATA_DUMP_TABLES,
  ARCHIVE_COVERED_ELSEWHERE_TABLES,
  ARCHIVE_EXCLUDED_TABLES,
} from '@/lib/reports/full-archive-export'

/**
 * Anti-rot guard for the full-archive backup (BFL 7-year retention).
 *
 * The säkerhetsbackup dumps company data table-by-table from an explicit list.
 * That list rotted once already: salary, assets, dimensions, articles and
 * rot/rut shipped without ever joining the dump, and three child tables were
 * queried by a company_id column they do not have (silent error stubs in every
 * backup). This test makes the schema and the dump contract converge:
 *
 *   every public base table with a company_id column must be classified as
 *   DUMPED, COVERED ELSEWHERE in the archive, or EXCLUDED with a reason.
 *
 * A migration adding a company-scoped table fails here until the author makes
 * an explicit call about its place in the backup.
 */

interface ColumnRow {
  table_name: string
  column_name: string
}

let columnsByTable: Map<string, Set<string>>

beforeAll(async () => {
  const { rows } = await getPool().query<ColumnRow>(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
  `)
  columnsByTable = new Map()
  for (const row of rows) {
    let set = columnsByTable.get(row.table_name)
    if (!set) {
      set = new Set()
      columnsByTable.set(row.table_name, set)
    }
    set.add(row.column_name)
  }
})

function companyScopedTables(): string[] {
  return [...columnsByTable.entries()]
    .filter(([, cols]) => cols.has('company_id'))
    .map(([name]) => name)
    .sort()
}

describe('full-archive coverage contract', () => {
  it('classifies every company-scoped table (new tables must be triaged)', () => {
    const dumped = new Set(MASTER_DATA_DUMP_TABLES.map((t) => t.name))
    const covered = new Set(Object.keys(ARCHIVE_COVERED_ELSEWHERE_TABLES))
    const excluded = new Set(Object.keys(ARCHIVE_EXCLUDED_TABLES))

    const unclassified = companyScopedTables().filter(
      (t) => !dumped.has(t) && !covered.has(t) && !excluded.has(t)
    )

    expect(
      unclassified,
      `Company-scoped tables missing from the backup contract: ${unclassified.join(', ')}. ` +
        'Add each to MASTER_DATA_DUMP_TABLES, ARCHIVE_COVERED_ELSEWHERE_TABLES or ' +
        'ARCHIVE_EXCLUDED_TABLES in lib/reports/full-archive-export.ts (with a reason).'
    ).toEqual([])
  })

  it('classifies only tables that actually exist (catches renames and drops)', () => {
    const allClassified = [
      ...MASTER_DATA_DUMP_TABLES.map((t) => t.name),
      ...Object.keys(ARCHIVE_COVERED_ELSEWHERE_TABLES),
      ...Object.keys(ARCHIVE_EXCLUDED_TABLES),
    ]
    const missing = allClassified.filter((t) => !columnsByTable.has(t))
    expect(
      missing,
      `Classified tables that no longer exist in the schema: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('keeps the three classification buckets disjoint', () => {
    const dumped = MASTER_DATA_DUMP_TABLES.map((t) => t.name)
    const covered = Object.keys(ARCHIVE_COVERED_ELSEWHERE_TABLES)
    const excluded = Object.keys(ARCHIVE_EXCLUDED_TABLES)
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const name of [...dumped, ...covered, ...excluded]) {
      if (seen.has(name)) duplicates.push(name)
      seen.add(name)
    }
    expect(duplicates).toEqual([])
  })

  it('dumps direct tables by an existing company_id column', () => {
    const broken = MASTER_DATA_DUMP_TABLES.filter(
      (t) => !t.via && !columnsByTable.get(t.name)?.has('company_id')
    ).map((t) => t.name)
    expect(
      broken,
      `Direct dump tables without a company_id column (the query would error and ` +
        `the backup would contain an error stub): ${broken.join(', ')}`
    ).toEqual([])
  })

  it('pages every dump table by an existing unique key', () => {
    const broken = MASTER_DATA_DUMP_TABLES.filter(
      (t) => !columnsByTable.get(t.name)?.has(t.pageKey ?? 'id')
    ).map((t) => `${t.name}.${t.pageKey ?? 'id'}`)
    expect(broken, `page keys missing from schema: ${broken.join(', ')}`).toEqual([])
  })

  it('fetches via-tables through a real parent/fk relationship', () => {
    for (const t of MASTER_DATA_DUMP_TABLES) {
      if (!t.via) continue
      const childCols = columnsByTable.get(t.name)
      expect(childCols, `via-table ${t.name} does not exist`).toBeDefined()
      expect(
        childCols!.has(t.via.fk),
        `via-table ${t.name} has no column ${t.via.fk}`
      ).toBe(true)
      expect(
        childCols!.has('company_id'),
        `via-table ${t.name} HAS a company_id column: dump it directly instead`
      ).toBe(false)
      expect(
        columnsByTable.get(t.via.parent)?.has('company_id'),
        `via-parent ${t.via.parent} of ${t.name} has no company_id column`
      ).toBe(true)
    }
  })

  it('orders every dump query by columns that exist', () => {
    const broken = MASTER_DATA_DUMP_TABLES.filter(
      (t) => t.orderBy && !columnsByTable.get(t.name)?.has(t.orderBy)
    ).map((t) => `${t.name}.${t.orderBy}`)
    expect(broken, `orderBy columns missing from schema: ${broken.join(', ')}`).toEqual([])
  })

  it('writes each table to a unique file', () => {
    const files = MASTER_DATA_DUMP_TABLES.map((t) => t.file)
    expect(new Set(files).size).toBe(files.length)
  })
})
