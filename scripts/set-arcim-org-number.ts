/**
 * One-off: set the org_number on Arcim Technology AB.
 *
 * Writes ONE row in `companies`. Verifies the company id, name, and current
 * value before writing. Refuses to overwrite a non-null org_number unless
 * --force is passed.
 *
 * Usage: npx tsx scripts/set-arcim-org-number.ts <COMPANY_ID> <ORG_NUMBER_10DIGIT> [--force]
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

const [, , companyId, orgNumberRaw, ...flags] = process.argv
const force = flags.includes('--force')

if (!companyId || !orgNumberRaw) {
  console.error('Usage: npx tsx scripts/set-arcim-org-number.ts <COMPANY_ID> <ORG_NUMBER_10DIGIT> [--force]')
  process.exit(1)
}

const orgNumber = orgNumberRaw.replace(/[-\s]/g, '')
if (!/^\d{10}$/.test(orgNumber)) {
  console.error(`Org number must be 10 digits (got ${orgNumber.length}: "${orgNumberRaw}")`)
  process.exit(1)
}

async function main() {
  const { data: before, error: readErr } = await supabase
    .from('companies')
    .select('id, name, org_number, entity_type, archived_at')
    .eq('id', companyId)
    .single()
  if (readErr || !before) {
    console.error(`Company ${companyId} not found: ${readErr?.message}`)
    process.exit(1)
  }
  console.log(`Before:`)
  console.log(`  id:          ${before.id}`)
  console.log(`  name:        ${before.name}`)
  console.log(`  org_number:  ${before.org_number ?? '(null)'}`)
  console.log(`  entity_type: ${before.entity_type}`)
  console.log(`  archived_at: ${before.archived_at ?? '(null)'}`)

  if (before.archived_at) {
    console.error('\nCompany is archived. Refusing to update.')
    process.exit(1)
  }
  if (before.org_number && before.org_number !== orgNumber && !force) {
    console.error(`\nCompany already has org_number=${before.org_number}. Refusing to overwrite without --force.`)
    process.exit(1)
  }
  if (before.org_number === orgNumber) {
    console.log(`\nNo change needed: org_number is already ${orgNumber}.`)
    return
  }

  console.log(`\nUpdating org_number → ${orgNumber}`)
  const { data: after, error: updateErr } = await supabase
    .from('companies')
    .update({ org_number: orgNumber })
    .eq('id', companyId)
    .select('id, name, org_number, entity_type')
    .single()
  if (updateErr || !after) {
    console.error(`Update failed: ${updateErr?.message}`)
    process.exit(1)
  }
  console.log(`\nAfter:`)
  console.log(`  org_number: ${after.org_number}`)
  const expectedRedovisare =
    after.entity_type === 'aktiebolag' ? `16${after.org_number}` : `(EF prefix)`
  console.log(`  → redovisare for SKV API: ${expectedRedovisare}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
