#!/usr/bin/env npx tsx
/**
 * Backfill auth.users.app_metadata.has_password for the BankID-MFA lockout fix.
 *
 *   - BankID-linked users (app_metadata.bankid_linked === true) with the flag
 *     unset → set has_password = false. Banner in SecuritySettings will then
 *     guide them through /account/set-password before MFA enroll is unlocked.
 *
 *   - All other users with the flag unset (legacy email/password signups) →
 *     set has_password = true. They have a real password.
 *
 *   - Anyone with the flag already set is left alone: fully idempotent.
 *
 * Usage:
 *   npx tsx scripts/backfill-has-password.ts            # apply
 *   npx tsx scripts/backfill-has-password.ts --dry-run  # report only
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const DRY_RUN = process.argv.includes('--dry-run')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local',
  )
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function main() {
  let page = 1
  const perPage = 200
  let totalScanned = 0
  let setFalse = 0
  let setTrue = 0
  let skipped = 0

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    })
    if (error) {
      console.error('listUsers failed', error)
      process.exit(1)
    }
    if (!data.users || data.users.length === 0) break

    for (const user of data.users) {
      totalScanned++
      const meta = (user.app_metadata ?? {}) as Record<string, unknown>
      const flagAlreadySet =
        meta.has_password === true || meta.has_password === false

      if (flagAlreadySet) {
        skipped++
        continue
      }

      const isBankIdLinked = meta.bankid_linked === true
      const nextValue = isBankIdLinked ? false : true

      if (DRY_RUN) {
        if (nextValue) setTrue++
        else setFalse++
        continue
      }

      const merged = { ...meta, has_password: nextValue }
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        { app_metadata: merged },
      )
      if (updateError) {
        console.error(`failed to update user ${user.id}`, updateError)
        continue
      }
      if (nextValue) setTrue++
      else setFalse++
    }

    if (data.users.length < perPage) break
    page++
  }

  console.log(JSON.stringify({
    mode: DRY_RUN ? 'dry-run' : 'apply',
    scanned: totalScanned,
    set_true: setTrue,
    set_false: setFalse,
    skipped_already_set: skipped,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
