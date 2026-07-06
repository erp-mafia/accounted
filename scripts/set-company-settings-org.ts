/**
 * Update company_settings.org_number for a given company.
 *
 * The Skatteverket validate handler reads org_number from company_settings
 * (not companies), so this is what actually controls the redovisare sent
 * to SKV. Mirrors set-arcim-org-number.ts but for the settings table.
 *
 * Usage: npx tsx scripts/set-company-settings-org.ts <COMPANY_ID> <ORG_NUMBER_10DIGIT> [--force]
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

const [, , companyId, orgRaw, ...flags] = process.argv
const force = flags.includes('--force')

if (!companyId || !orgRaw) {
  console.error('Usage: npx tsx scripts/set-company-settings-org.ts <COMPANY_ID> <ORG_NUMBER_10DIGIT> [--force]')
  process.exit(1)
}

const org = orgRaw.replace(/[-\s]/g, '')
if (!/^\d{10}$/.test(org)) {
  console.error(`Org number must be 10 digits (got ${org.length})`)
  process.exit(1)
}

async function main() {
  const { data: before, error: readErr } = await supabase
    .from('company_settings')
    .select('id, company_id, org_number, entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  if (readErr) {
    console.error(`read failed: ${readErr.message}`)
    process.exit(1)
  }

  if (!before) {
    // No settings row yet: need to insert. Pull entity_type from companies.
    const { data: company } = await supabase
      .from('companies')
      .select('id, name, entity_type')
      .eq('id', companyId)
      .single()
    if (!company) {
      console.error(`Company ${companyId} not found`)
      process.exit(1)
    }
    console.log(`No company_settings row for ${company.name}: inserting one.`)
    const { error: insertErr } = await supabase
      .from('company_settings')
      .insert({ company_id: companyId, org_number: org, entity_type: company.entity_type })
    if (insertErr) {
      console.error(`insert failed: ${insertErr.message}`)
      process.exit(1)
    }
    console.log(`✓ Inserted company_settings with org_number=${org}, entity_type=${company.entity_type}`)
    return
  }

  console.log(`Before:`)
  console.log(`  company_id:  ${before.company_id}`)
  console.log(`  org_number:  ${before.org_number ?? '(null)'}`)
  console.log(`  entity_type: ${before.entity_type}`)

  if (before.org_number === org) {
    console.log(`\nNo change: already ${org}.`)
    return
  }
  if (before.org_number && !force) {
    console.error(`\nAlready set to ${before.org_number}. Pass --force to overwrite.`)
    process.exit(1)
  }

  const { data: after, error: updateErr } = await supabase
    .from('company_settings')
    .update({ org_number: org })
    .eq('company_id', companyId)
    .select('org_number, entity_type')
    .single()
  if (updateErr || !after) {
    console.error(`update failed: ${updateErr?.message}`)
    process.exit(1)
  }
  const redovisare =
    after.entity_type === 'aktiebolag' ? `16${after.org_number}` : `(EF prefix)`
  console.log(`\nAfter:`)
  console.log(`  org_number: ${after.org_number}`)
  console.log(`  → redovisare for SKV API: ${redovisare}`)
}

main().catch(err => { console.error(err); process.exit(1) })
