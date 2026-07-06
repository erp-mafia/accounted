/**
 * Create a dedicated SKV test company in gnubok.
 *
 * Why this exists: testing the Skatteverket sandbox APIs against Arcim's real
 * orgnummer would put real revenue/VAT figures in SKV's test logs under the
 * real entity. Better hygiene: a separate gnubok company that uses one of
 * SKV's *published* test orgnummer (which are already pre-wired in their
 * test registry), seeded with synthetic data only.
 *
 * Inserts:
 *   - companies row with name `[TEST] SKV Sandbox`, org_number=1128000013,
 *     entity_type=aktiebolag, created_by=<user_id>
 *   - company_members row giving <user_id> owner role
 *   - company_settings row with the same org_number + entity_type
 *   - chart_of_accounts seeded via the seed_chart_of_accounts RPC
 *   - flips user_preferences.active_company_id to the new company so the UI
 *     starts using it immediately
 *
 * To revert: delete the company row (CASCADE removes members + settings),
 * then update user_preferences.active_company_id back to the previous value.
 *
 * Usage: npx tsx scripts/create-skv-test-company.ts <USER_ID>
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const TEST_NAME = '[TEST] SKV Sandbox'
const TEST_ORG_NUMBER = '1128000013' // → 161128000013, registered for moms in SKV test
const TEST_ENTITY_TYPE = 'aktiebolag'

const userId = process.argv[2]
if (!userId) {
  console.error('Usage: npx tsx scripts/create-skv-test-company.ts <USER_ID>')
  process.exit(1)
}

async function main() {
  // Sanity check: don't create duplicates if the script is rerun.
  const { data: existing } = await supabase
    .from('companies')
    .select('id, name, org_number')
    .eq('created_by', userId)
    .eq('name', TEST_NAME)
    .maybeSingle()

  if (existing) {
    console.log(`Test company already exists:`)
    console.log(`  id:         ${existing.id}`)
    console.log(`  name:       ${existing.name}`)
    console.log(`  org_number: ${existing.org_number}`)
    console.log(`\nIf you want a fresh one, delete it first:`)
    console.log(`  delete from companies where id = '${existing.id}';`)
    return
  }

  console.log(`Creating test company for user ${userId}...`)

  // 1. Insert the company.
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .insert({
      name: TEST_NAME,
      org_number: TEST_ORG_NUMBER,
      entity_type: TEST_ENTITY_TYPE,
      created_by: userId,
    })
    .select('id')
    .single()
  if (companyErr || !company) throw new Error(`companies insert: ${companyErr?.message}`)
  const companyId = company.id
  console.log(`  ✓ companies.id = ${companyId}`)

  // 2. Owner membership.
  const { error: memberErr } = await supabase
    .from('company_members')
    .insert({ company_id: companyId, user_id: userId, role: 'owner' })
  if (memberErr) throw new Error(`company_members insert: ${memberErr.message}`)
  console.log(`  ✓ owner membership created`)

  // 3. company_settings (the validate handler reads org_number from here).
  const { error: settingsErr } = await supabase
    .from('company_settings')
    .insert({
      company_id: companyId,
      org_number: TEST_ORG_NUMBER,
      entity_type: TEST_ENTITY_TYPE,
    })
  if (settingsErr) throw new Error(`company_settings insert: ${settingsErr.message}`)
  console.log(`  ✓ company_settings created`)

  // 4. Seed the chart of accounts.
  const { error: seedErr } = await supabase.rpc('seed_chart_of_accounts', {
    p_company_id: companyId,
    p_entity_type: TEST_ENTITY_TYPE,
  })
  if (seedErr) throw new Error(`seed_chart_of_accounts: ${seedErr.message}`)
  console.log(`  ✓ chart of accounts seeded`)

  // 5. Make this the user's active company so the UI uses it on next load.
  const { data: prevPref } = await supabase
    .from('user_preferences')
    .select('active_company_id')
    .eq('user_id', userId)
    .maybeSingle()
  const previousActive = prevPref?.active_company_id ?? null

  const { error: prefErr } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, active_company_id: companyId },
      { onConflict: 'user_id' },
    )
  if (prefErr) throw new Error(`user_preferences upsert: ${prefErr.message}`)
  console.log(`  ✓ active_company_id flipped to test company`)

  console.log(`\nDone.\n`)
  console.log(`Test company id:           ${companyId}`)
  console.log(`Test company name:         ${TEST_NAME}`)
  console.log(`org_number (10-digit):     ${TEST_ORG_NUMBER}`)
  console.log(`SKV redovisare (12-digit): 16${TEST_ORG_NUMBER}`)
  console.log(`Previous active_company_id: ${previousActive ?? '(none)'}`)
  console.log(`\nNext step: seed VAT fixtures for SKV's pre-wired periods:`)
  console.log(`  npx tsx scripts/seed-skv-test-data.ts ${companyId} 2024 1`)
  console.log(`  npx tsx scripts/seed-skv-test-data.ts ${companyId} 2024 2`)
  console.log(`\nWhen done testing, switch back via the UI's company switcher,`)
  console.log(`or run:`)
  console.log(`  update user_preferences set active_company_id = '${previousActive}' where user_id = '${userId}';`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
