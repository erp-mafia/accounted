/**
 * List recent gnubok dev users. Quick sanity-check tool: given a hosted
 * Supabase project, the easiest way to see who has signed up.
 *
 * Usage: npx tsx scripts/list-dev-users.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

async function main() {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 20 })
  if (error) {
    console.error('listUsers failed:', error.message)
    process.exit(1)
  }
  if (!data.users.length) {
    console.log('No users yet. Sign up at /register first.')
    return
  }
  console.log(`Found ${data.users.length} users (most recent first):`)
  for (const u of data.users) {
    const last = u.last_sign_in_at ? new Date(u.last_sign_in_at).toISOString() : '(never)'
    console.log(`  ${u.id}  ${u.email?.padEnd(40) ?? '(no email)'}  last: ${last}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
