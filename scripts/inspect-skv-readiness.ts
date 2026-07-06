/**
 * READ-ONLY inspection: shows what Jakob's account looks like in prod and
 * whether kontrollera can be run safely without seeding any test data.
 *
 * Verifies:
 *   1. The user exists and active_company_id is set
 *   2. The active company has a usable org_number + entity_type
 *      → so formatRedovisare() can produce the 12-digit SKV redovisare
 *   3. There's at least one closed fiscal period with VAT-relevant journal
 *      entries we could pick for the kontrollera call
 *   4. There are no leftover skatteverket_tokens that would surprise us
 *
 * Writes nothing. Safe to run against prod.
 *
 * Usage: npx tsx scripts/inspect-skv-readiness.ts <EMAIL>
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

const email = process.argv[2]
if (!email) {
  console.error('Usage: npx tsx scripts/inspect-skv-readiness.ts <EMAIL>')
  process.exit(1)
}

function formatRedovisareLocal(orgNumber: string, entityType: string): string {
  const digits = orgNumber.replace(/[-\s]/g, '')
  if (digits.length === 12) return digits
  if (digits.length !== 10) return `(invalid: ${orgNumber})`
  if (entityType === 'aktiebolag') return `16${digits}`
  // EF: prefix century. For births 19XX vs 20XX we'd need the actual logic.
  const centuryByte = digits.substring(0, 2)
  const yearByte = parseInt(centuryByte, 10)
  // Heuristic mirrors lib/skatteverket/format.ts
  return yearByte < 50 ? `20${digits}` : `19${digits}`
}

async function main() {
  console.log(`Inspecting SKV readiness for ${email}\n`)

  // 1. user_id
  const { data: usersData, error: userErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (userErr) throw new Error(`listUsers: ${userErr.message}`)
  const user = usersData.users.find(u => u.email === email)
  if (!user) {
    console.error(`User ${email} not found.`)
    process.exit(1)
  }
  console.log(`✓ user_id = ${user.id}`)

  // 2. user_preferences
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', user.id)
    .maybeSingle()
  console.log(`  active_company_id = ${prefs?.active_company_id ?? '(none)'}`)

  // 3. company memberships
  const { data: memberships, error: memErr } = await supabase
    .from('company_members')
    .select('company_id, role, companies(id, name, org_number, entity_type, archived_at)')
    .eq('user_id', user.id)
  if (memErr) throw new Error(`memberships: ${memErr.message}`)
  if (!memberships?.length) {
    console.error('User has no company memberships. Sign up flow may be incomplete.')
    process.exit(1)
  }
  console.log(`\nCompanies:`)
  for (const m of memberships) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (Array.isArray(m.companies) ? m.companies[0] : m.companies) as any
    if (!c) continue
    const archived = c.archived_at ? ' [ARCHIVED]' : ''
    const active = c.id === prefs?.active_company_id ? ' ← ACTIVE' : ''
    const redovisare = c.org_number ? formatRedovisareLocal(c.org_number, c.entity_type) : '(no org_number)'
    console.log(`  ${c.id}  ${c.name}${archived}${active}`)
    console.log(`    role=${m.role}  org=${c.org_number}  entity=${c.entity_type}  → redovisare=${redovisare}`)
  }

  const activeCompany = memberships.find(m => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (Array.isArray(m.companies) ? m.companies[0] : m.companies) as any
    return c?.id === prefs?.active_company_id
  })
  if (!activeCompany) {
    console.warn('\n⚠ No active company set. UI will pick the first one.')
    process.exit(0)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ac = (Array.isArray(activeCompany.companies) ? activeCompany.companies[0] : activeCompany.companies) as any
  console.log(`\n--- Active company: ${ac.name} ---`)

  // 4. Fiscal periods with closed status
  const { data: fps } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed')
    .eq('company_id', ac.id)
    .order('period_start', { ascending: false })
    .limit(5)
  console.log(`\nMost recent fiscal periods:`)
  if (!fps?.length) {
    console.log('  (none)')
  } else {
    for (const fp of fps) {
      console.log(`  ${fp.period_start} → ${fp.period_end}  closed=${fp.is_closed}  ${fp.name}`)
    }
  }

  // 5. Count VAT-relevant journal_entry_lines for the most recent month
  const today = new Date()
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0)
  const startStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`
  const endStr = `${lastMonthEnd.getFullYear()}-${String(lastMonthEnd.getMonth() + 1).padStart(2, '0')}-${String(lastMonthEnd.getDate()).padStart(2, '0')}`

  const vatAccounts = ['2611', '2621', '2631', '2614', '2641', '2645', '3001', '3002', '3003', '3308', '3105']
  const { data: lines, error: lineErr } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, journal_entries!inner(company_id, entry_date, status)')
    .in('account_number', vatAccounts)
    .eq('journal_entries.company_id', ac.id)
    .eq('journal_entries.status', 'posted')
    .gte('journal_entries.entry_date', startStr)
    .lte('journal_entries.entry_date', endStr)
    .limit(200)
  if (lineErr) throw new Error(`lines: ${lineErr.message}`)
  console.log(`\nVAT activity in ${startStr} → ${endStr}: ${lines?.length ?? 0} lines on ${vatAccounts.join('/')}`)

  // 6. Existing skatteverket_tokens?
  const { data: tokens } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, expires_at, refresh_count, scope, created_at')
    .eq('user_id', user.id)
  if (tokens?.length) {
    console.log(`\n⚠ Existing skatteverket_tokens row(s):`)
    for (const t of tokens) {
      console.log(`  expires_at=${t.expires_at}  refresh_count=${t.refresh_count}  scope=${t.scope}`)
    }
  } else {
    console.log('\n✓ No existing skatteverket_tokens: clean slate for OAuth.')
  }

  console.log('\nDone (read-only).')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
