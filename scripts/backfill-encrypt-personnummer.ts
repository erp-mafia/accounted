/**
 * One-off backfill: encrypt any employees.personnummer still stored as
 * plaintext (12 digits) into aes-256-gcm ciphertext, matching the format
 * written by encryptPersonnummer().
 *
 * WHY: the v1 REST create route used to store personnummer unencrypted, which
 * 500'd every decrypt-on-read path with ERR_CRYPTO_INVALID_AUTH_TAG
 * ("Invalid authentication tag length: 6"). The code fix stops new plaintext;
 * this repairs the rows already in the DB and closes the GDPR at-rest gap.
 * Run AFTER the code fix is deployed.
 *
 * Idempotent: only touches rows whose personnummer matches /^\d{12}$/, and each
 * update is guarded on the exact plaintext value so a re-run or a concurrent
 * write can never double-encrypt. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-encrypt-personnummer.ts            # dry run (read-only)
 *   npx tsx scripts/backfill-encrypt-personnummer.ts --confirm  # performs the writes
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * PERSONNUMMER_ENCRYPTION_KEY from .env.local. Treat .env.local as pointing at
 * PRODUCTION: the dry run is read-only; --confirm mutates PII.
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
// Refuse to run without the real key: encrypting with the dev fallback key
// would make the values unreadable in production.
if (!process.env.PERSONNUMMER_ENCRYPTION_KEY) {
  console.error(
    'Missing PERSONNUMMER_ENCRYPTION_KEY. Refusing to run so rows are not encrypted with the dev fallback key.',
  )
  process.exit(1)
}

const CONFIRM = process.argv.includes('--confirm')
const PLAINTEXT = /^\d{12}$/

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

async function main() {
  const host = new URL(SUPABASE_URL!).host
  console.log(`Target: ${host}   mode: ${CONFIRM ? 'WRITE (--confirm)' : 'DRY RUN (read-only)'}`)

  const { data, error } = await sb
    .from('employees')
    .select('id, company_id, personnummer, personnummer_last4')
  if (error) throw new Error(`select employees: ${error.message}`)

  const rows = data ?? []
  const plaintextRows = rows.filter((r) => PLAINTEXT.test(String(r.personnummer ?? '')))

  const byCompany = new Map<string, number>()
  for (const r of plaintextRows) {
    byCompany.set(r.company_id, (byCompany.get(r.company_id) ?? 0) + 1)
  }

  console.log(
    `Scanned ${rows.length} employees; ${plaintextRows.length} plaintext across ${byCompany.size} companies.`,
  )
  for (const [companyId, n] of byCompany) console.log(`  company ${companyId}: ${n} row(s)`)

  if (plaintextRows.length === 0) {
    console.log('Nothing to backfill.')
    return
  }
  if (!CONFIRM) {
    console.log('\nDRY RUN: no writes performed. Re-run with --confirm to encrypt these rows.')
    return
  }

  let updated = 0
  for (const r of plaintextRows) {
    const plaintext = String(r.personnummer)
    const last4 = plaintext.slice(-4)
    const patch: Record<string, string> = { personnummer: encryptPersonnummer(plaintext) }
    if (r.personnummer_last4 !== last4) patch.personnummer_last4 = last4

    // Guard on the still-plaintext value: makes the update idempotent and safe
    // against a concurrent write (never double-encrypts).
    const { error: upErr } = await sb
      .from('employees')
      .update(patch)
      .eq('id', r.id)
      .eq('personnummer', plaintext)
    if (upErr) throw new Error(`update ${r.id}: ${upErr.message}`)
    updated++
  }

  console.log(`\nEncrypted ${updated} row(s). Re-run without --confirm to verify 0 remain.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
