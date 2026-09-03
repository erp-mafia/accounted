/**
 * Read-only lister for #2058: employees whose jämkningsbeslut is stored but
 * can never be applied because jamkning_valid_to is null.
 *
 * WHY: until #2058 the v1 API and MCP accepted jamkning_percentage +
 * jamkning_valid_from without jamkning_valid_to. isJamkningValid in
 * lib/salary/calculation-engine.ts applies a beslut only when BOTH dates are
 * set, so these rows fall back to the tax table on every payslip and AGI
 * while the stored beslut says otherwise. Every write path now rejects the
 * shape; this script finds the rows that were stored before that.
 *
 * WHAT IT DOES: lists the rows per company with employee id, masked name,
 * percentage and start date. It writes NOTHING. The repair is a per-company
 * decision (set an end date, or clear the beslut): either changes the next
 * payslip, so it is made by a human through the employee page or the API,
 * not by this script.
 *
 * Usage:
 *   npx tsx scripts/list-incomplete-jamkning.ts
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION (read-only here, still: be sure
 * which project you are looking at).
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

interface Row {
  id: string
  company_id: string
  first_name: string
  last_name: string
  is_active: boolean
  jamkning_percentage: number
  jamkning_valid_from: string | null
  jamkning_valid_to: string | null
}

/** Initials only: this output may end up in a ticket. */
function maskName(first: string, last: string): string {
  const f = first.trim().charAt(0)
  const l = last.trim().charAt(0)
  return `${f}${f ? '.' : ''} ${l}${l ? '.' : ''}`.trim()
}

async function main() {
  const PAGE = 1000
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('employees')
      .select('id, company_id, first_name, last_name, is_active, jamkning_percentage, jamkning_valid_from, jamkning_valid_to')
      .not('jamkning_percentage', 'is', null)
      .is('jamkning_valid_to', null)
      .order('company_id')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('employees query failed:', error.message)
      process.exit(1)
    }
    rows.push(...((data ?? []) as Row[]))
    if (!data || data.length < PAGE) break
  }

  if (rows.length === 0) {
    console.log('No employees with a jämkning percentage but no valid_to. Nothing to decide.')
    return
  }

  const companyIds = [...new Set(rows.map((r) => r.company_id))]
  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    .select('id, name')
    .in('id', companyIds)
  if (companiesError) {
    console.error('companies query failed:', companiesError.message)
    process.exit(1)
  }
  const companyName = new Map((companies ?? []).map((c) => [c.id as string, c.name as string]))

  console.log(`${rows.length} employee row(s) across ${companyIds.length} company(ies) with an inert jämkningsbeslut:\n`)
  for (const companyId of companyIds) {
    console.log(`${companyName.get(companyId) ?? '(unknown company)'}  ${companyId}`)
    for (const r of rows.filter((x) => x.company_id === companyId)) {
      const state = r.is_active ? 'active  ' : 'inactive'
      const from = r.jamkning_valid_from ?? '(no start date)'
      console.log(`  ${r.id}  ${state}  ${maskName(r.first_name, r.last_name).padEnd(6)}  ${r.jamkning_percentage} %  from ${from}  to (null)`)
    }
    console.log('')
  }
  console.log('Decide per company: set jamkning_valid_to (a beslut normally runs to 31 December of')
  console.log('the from-year) or clear jamkning_percentage. Either changes the next payslip; the')
  console.log('engine ignores these rows until then. Inactive employees can usually be cleared.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
