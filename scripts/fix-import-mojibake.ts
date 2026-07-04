#!/usr/bin/env npx tsx
/**
 * Re-decode mojibake'd Swedish characters in supplier and customer text fields.
 *
 * Background: prior to the CSV-encoding fix in lib/import/shared/workbook-reader.ts,
 * the supplier/customer CSV importer passed raw bytes to xlsx with `type: 'array'`,
 * which decodes UTF-8 multi-byte sequences as Latin-1: turning "GÖTEBORG" into
 * "GÃ–TEBORG" (and similar for å, ä, å, Å, Ä, Ö). This script repairs those rows.
 *
 * Idempotent: lib/import/shared/encoding.ts:decodeStringContent is a no-op on
 * strings that already contain correct Swedish characters, so it is safe to
 * re-run.
 *
 * Usage:
 *   # Preview every company
 *   npx tsx scripts/fix-import-mojibake.ts
 *
 *   # Preview a single company
 *   npx tsx scripts/fix-import-mojibake.ts --company-id <uuid>
 *
 *   # Apply
 *   npx tsx scripts/fix-import-mojibake.ts --commit
 *   npx tsx scripts/fix-import-mojibake.ts --company-id <uuid> --commit
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decodeStringContent, hasEncodingIssues } from '../lib/import/shared/encoding'

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

console.log('─────────────────────────────────────────────────────────')
console.log('Mojibake repair: suppliers + customers')
console.log('─────────────────────────────────────────────────────────')
console.log('Supabase URL :', supabaseUrl)
console.log('Company      :', COMPANY_ID ?? '(all)')
console.log('Mode         :', COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)')
console.log('─────────────────────────────────────────────────────────\n')

const SUPPLIER_TEXT_FIELDS = [
  'name',
  'address_line1',
  'address_line2',
  'city',
  'country',
  'category',
  'notes',
] as const

const CUSTOMER_TEXT_FIELDS = [
  'name',
  'address_line1',
  'address_line2',
  'city',
  'country',
  'notes',
] as const

const PAGE_SIZE = 500

async function fetchAll(table: 'suppliers' | 'customers', columns: string[]) {
  const all: Record<string, unknown>[] = []
  let from = 0
  for (;;) {
    let query = supabase
      .from(table)
      .select(['id', 'company_id', ...columns].join(','))
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (COMPANY_ID) {
      query = query.eq('company_id', COMPANY_ID)
    }

    const { data, error } = await query
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`)
    const rows = ((data ?? []) as unknown) as Record<string, unknown>[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

interface RepairResult {
  scanned: number
  affected: number
  fields: number
  applied: number
  failed: number
}

async function repair(
  table: 'suppliers' | 'customers',
  textFields: readonly string[],
): Promise<RepairResult> {
  console.log(`[${table}]`)
  const rows = await fetchAll(table, [...textFields])
  console.log(`  · Scanned ${rows.length} rows`)

  let affected = 0
  let fieldsFixed = 0
  let applied = 0
  let failed = 0

  for (const row of rows) {
    const updates: Record<string, string | null> = {}
    const before: Record<string, string> = {}
    for (const field of textFields) {
      const value = row[field]
      if (typeof value !== 'string' || value === '') continue
      if (!hasEncodingIssues(value)) continue
      const fixed = decodeStringContent(value)
      if (fixed === value) continue
      updates[field] = fixed
      before[field] = value
    }

    if (Object.keys(updates).length === 0) continue

    affected++
    fieldsFixed += Object.keys(updates).length

    const id = row.id as string
    const companyId = row.company_id as string
    console.log(`\n  · ${table}.${id} (company ${companyId})`)
    for (const [field, fixed] of Object.entries(updates)) {
      console.log(`      ${field}:`)
      console.log(`        before: ${JSON.stringify(before[field])}`)
      console.log(`        after : ${JSON.stringify(fixed)}`)
    }

    if (!COMMIT) continue

    const { error } = await supabase.from(table).update(updates).eq('id', id)
    if (error) {
      console.error(`      FAILED: ${error.message}`)
      failed++
    } else {
      applied++
    }
  }

  return { scanned: rows.length, affected, fields: fieldsFixed, applied, failed }
}

async function main() {
  try {
    const sup = await repair('suppliers', SUPPLIER_TEXT_FIELDS)
    const cus = await repair('customers', CUSTOMER_TEXT_FIELDS)

    console.log('\n─────────────────────────────────────────────────────────')
    console.log('Summary')
    console.log('─────────────────────────────────────────────────────────')
    console.log(`suppliers   : ${sup.affected}/${sup.scanned} rows affected (${sup.fields} fields)`)
    console.log(`customers   : ${cus.affected}/${cus.scanned} rows affected (${cus.fields} fields)`)
    if (COMMIT) {
      console.log(`Applied     : ${sup.applied + cus.applied}`)
      console.log(`Failed      : ${sup.failed + cus.failed}`)
    } else {
      console.log('\nRe-run with --commit to apply.')
    }
  } catch (err) {
    console.error('\nFATAL:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

main()
