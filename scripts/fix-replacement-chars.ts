#!/usr/bin/env npx tsx
/**
 * Find and repair U+FFFD (replacement character) corruption in user-facing
 * text columns across the production database.
 *
 * Cause: prior to the fix in lib/import/sie-parser.ts:decodeBuffer, the SIE
 * importer's encoding detector sampled only the first 4 KB of each file. When
 * Swedish characters appeared only deeper in the file, the detector defaulted
 * to UTF-8. Decoding a Windows-1252 byte like 0xD6 (Ö) as UTF-8 produces the
 * replacement character U+FFFD: silently, because TextDecoder defaults to
 * `fatal: false`. The mangled strings ended up in customers, suppliers,
 * journal_entries, etc.
 *
 * Recovery is not deterministic: the original byte is lost. This script does
 * heuristic substitution against a small Swedish-word dictionary:
 *
 *   1. Find rows where any text column contains U+FFFD.
 *   2. For each U+FFFD-containing word, try substituting Å/Ä/Ö (uppercase
 *      context) or å/ä/ö (lowercase). Use the surrounding word casing to
 *      pick the case.
 *   3. If exactly one substitution matches a known Swedish stem, apply it.
 *   4. Otherwise log the row for manual review and leave it untouched.
 *
 * Idempotent: re-running matches zero rows once successful repairs are applied.
 *
 * Usage:
 *   # Preview every company
 *   npx tsx scripts/fix-replacement-chars.ts
 *
 *   # Preview a single company
 *   npx tsx scripts/fix-replacement-chars.ts --company-id <uuid>
 *
 *   # Apply
 *   npx tsx scripts/fix-replacement-chars.ts --commit
 *   npx tsx scripts/fix-replacement-chars.ts --company-id <uuid> --commit
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { recoverStringWithFFFD } from '../lib/import/shared/encoding'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const COMPANY_ID = arg('company-id') ?? null
const COMMIT = process.argv.includes('--commit')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey) as SupabaseClient

const REPLACEMENT = '\uFFFD'

interface ColumnSpec {
  table: string
  /** Column for tenant filtering. Most have company_id; legacy tables may use user_id. */
  tenantColumn: 'company_id' | 'user_id' | null
  /** Free-text columns to scan for U+FFFD. */
  columns: readonly string[]
  /** Optional row filter: used to skip immutable/posted rows. */
  filter?: (row: Record<string, unknown>) => boolean
  /** Extra SELECTs needed by the filter: pulled but not scanned for U+FFFD. */
  extraSelect?: readonly string[]
}

const TARGETS: readonly ColumnSpec[] = [
  {
    table: 'customers',
    tenantColumn: 'company_id',
    columns: ['name', 'address_line1', 'address_line2', 'city', 'country', 'notes'],
  },
  {
    table: 'suppliers',
    tenantColumn: 'company_id',
    columns: ['name', 'address_line1', 'address_line2', 'city', 'country', 'category', 'notes'],
  },
  {
    table: 'transactions',
    tenantColumn: 'company_id',
    columns: ['description', 'merchant_name', 'notes'],
  },
  {
    table: 'chart_of_accounts',
    tenantColumn: 'company_id',
    columns: ['account_name', 'description'],
  },
  {
    table: 'journal_entries',
    tenantColumn: 'company_id',
    columns: ['description'],
    extraSelect: ['status'],
    // Skip posted entries: they're legally immutable per BFL.
    filter: (row) => row.status !== 'posted',
  },
  // Note: journal_entry_lines.line_description is intentionally NOT scanned.
  // The table has no direct company_id column, and posted lines are immutable
  // per the engine's enforcement triggers. If line descriptions need repair,
  // run a targeted SQL query against drafts only.
  {
    table: 'voucher_gap_explanations',
    tenantColumn: 'company_id',
    columns: ['explanation'],
  },
  {
    table: 'cost_centers',
    tenantColumn: 'company_id',
    columns: ['name'],
  },
  {
    table: 'projects',
    tenantColumn: 'company_id',
    columns: ['name'],
  },
  {
    table: 'receipts',
    tenantColumn: 'company_id',
    columns: ['merchant_name', 'representation_purpose'],
  },
  {
    table: 'receipt_line_items',
    tenantColumn: 'company_id',
    columns: ['description'],
  },
  {
    table: 'employees',
    tenantColumn: 'company_id',
    columns: ['first_name', 'last_name', 'address_line1', 'postal_code', 'city'],
  },
  {
    table: 'invoices',
    tenantColumn: 'company_id',
    columns: ['your_reference', 'our_reference', 'notes', 'reverse_charge_text'],
  },
  {
    table: 'invoice_items',
    tenantColumn: 'company_id',
    columns: ['description'],
  },
  {
    table: 'supplier_invoices',
    tenantColumn: 'company_id',
    columns: ['notes'],
    extraSelect: ['status'],
    filter: (row) => !['paid', 'credited', 'reversed'].includes(String(row.status)),
  },
  {
    table: 'supplier_invoice_items',
    tenantColumn: 'company_id',
    columns: ['description'],
  },
  {
    table: 'categorization_templates',
    tenantColumn: 'company_id',
    columns: ['counterparty_name'],
  },
  {
    table: 'companies',
    tenantColumn: null, // top-level: filter directly on id when --company-id is given
    columns: ['name', 'address_line1', 'address_line2', 'city'],
  },
]

const PAGE_SIZE = 500

async function fetchAll(spec: ColumnSpec): Promise<Record<string, unknown>[]> {
  const selectCols = ['id', ...spec.columns, ...(spec.extraSelect ?? [])]
  if (spec.tenantColumn) selectCols.push(spec.tenantColumn)

  const all: Record<string, unknown>[] = []
  let from = 0
  for (;;) {
    let query = supabase
      .from(spec.table)
      .select(selectCols.join(','))
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (COMPANY_ID) {
      if (spec.tenantColumn === 'company_id') {
        query = query.eq('company_id', COMPANY_ID)
      } else if (spec.table === 'companies') {
        query = query.eq('id', COMPANY_ID)
      }
    }

    const { data, error } = await query
    if (error) throw new Error(`Failed to read ${spec.table}: ${error.message}`)
    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

interface Report {
  table: string
  scanned: number
  affected: number
  recovered: number
  ambiguous: number
  applied: number
  failed: number
}

async function scanTable(spec: ColumnSpec): Promise<Report> {
  const rows = await fetchAll(spec)
  const filtered = spec.filter ? rows.filter(spec.filter) : rows
  let affected = 0
  let recovered = 0
  let ambiguous = 0
  let applied = 0
  let failed = 0

  for (const row of filtered) {
    const updates: Record<string, string> = {}
    const ambiguousFields: { field: string; value: string }[] = []
    let rowHasFFFD = false

    for (const col of spec.columns) {
      const value = row[col]
      if (typeof value !== 'string' || !value.includes(REPLACEMENT)) continue
      rowHasFFFD = true

      const fixed = recoverStringWithFFFD(value)
      if (fixed !== null && fixed !== value) {
        updates[col] = fixed
      } else {
        ambiguousFields.push({ field: col, value })
      }
    }

    if (!rowHasFFFD) continue
    affected++

    const id = row.id as string
    const tenantId = spec.tenantColumn ? row[spec.tenantColumn] : null

    if (Object.keys(updates).length > 0) {
      recovered++
      console.log(`\n  · ${spec.table}.${id}${tenantId ? ` (${spec.tenantColumn}=${tenantId})` : ''}`)
      for (const [field, fixed] of Object.entries(updates)) {
        const before = row[field] as string
        console.log(`      ${field}:`)
        console.log(`        before: ${JSON.stringify(before)}`)
        console.log(`        after : ${JSON.stringify(fixed)}`)
      }

      if (COMMIT) {
        const { error } = await supabase.from(spec.table).update(updates).eq('id', id)
        if (error) {
          console.error(`      FAILED: ${error.message}`)
          failed++
        } else {
          applied++
        }
      }
    }

    if (ambiguousFields.length > 0) {
      ambiguous++
      console.log(
        `\n  · ${spec.table}.${id}${tenantId ? ` (${spec.tenantColumn}=${tenantId})` : ''}: AMBIGUOUS (manual review):`
      )
      for (const { field, value } of ambiguousFields) {
        console.log(`      ${field}: ${JSON.stringify(value)}`)
      }
    }
  }

  return {
    table: spec.table,
    scanned: filtered.length,
    affected,
    recovered,
    ambiguous,
    applied,
    failed,
  }
}

async function main() {
  console.log('─────────────────────────────────────────────────────────')
  console.log('U+FFFD repair across user-facing text columns')
  console.log('─────────────────────────────────────────────────────────')
  console.log('Supabase URL :', supabaseUrl)
  console.log('Company      :', COMPANY_ID ?? '(all)')
  console.log('Mode         :', COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)')
  console.log('─────────────────────────────────────────────────────────\n')

  const reports: Report[] = []
  for (const spec of TARGETS) {
    console.log(`[${spec.table}]`)
    try {
      const report = await scanTable(spec)
      reports.push(report)
      console.log(
        `  · Scanned ${report.scanned} rows; ${report.affected} affected (${report.recovered} recovered, ${report.ambiguous} ambiguous)`
      )
    } catch (err) {
      console.error(`  · FAILED: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log('\n─────────────────────────────────────────────────────────')
  console.log('Summary')
  console.log('─────────────────────────────────────────────────────────')
  const totals = reports.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      affected: acc.affected + r.affected,
      recovered: acc.recovered + r.recovered,
      ambiguous: acc.ambiguous + r.ambiguous,
      applied: acc.applied + r.applied,
      failed: acc.failed + r.failed,
    }),
    { scanned: 0, affected: 0, recovered: 0, ambiguous: 0, applied: 0, failed: 0 }
  )
  for (const r of reports) {
    if (r.affected === 0) continue
    console.log(
      `${r.table.padEnd(28)}: ${r.affected.toString().padStart(4)} affected, ${r.recovered.toString().padStart(4)} recovered, ${r.ambiguous.toString().padStart(4)} ambiguous`
    )
  }
  console.log('─────────────────────────────────────────────────────────')
  console.log(
    `TOTAL                       : ${totals.affected.toString().padStart(4)} affected, ${totals.recovered.toString().padStart(4)} recovered, ${totals.ambiguous.toString().padStart(4)} ambiguous`
  )
  if (COMMIT) {
    console.log(`Applied                     : ${totals.applied}`)
    console.log(`Failed                      : ${totals.failed}`)
  } else {
    console.log('\nDry run: no changes written. Re-run with --commit to apply.')
    console.log(
      'Ambiguous rows are NOT touched: review them by hand and update manually if needed.'
    )
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
