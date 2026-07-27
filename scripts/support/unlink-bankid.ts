/**
 * Support action: unlink a BankID identity from an account (#1231).
 *
 * WHY: when a user's personnummer is linked to a stale/abandoned account,
 * BankID login strands them there (the Chillen support case, 2026-07-27) and
 * /bankid/link on their real account returns 409 already_linked. The safe
 * support fix is to unlink the stale account: that grants nobody access
 * (re-linking still requires a password login to the target account plus a
 * live BankID session), it just frees the personnummer.
 *
 * What it does on --execute:
 * 1. deletes the bankid_identities row for the user,
 * 2. clears app_metadata.bankid_linked (read-merge-write: updateUserById
 *    replaces app_metadata wholesale, see app/api/account/password/route.ts),
 * 3. writes an append-only audit_log row (SECURITY_EVENT) carrying the full
 *    old row so the action is traceable and restorable.
 *
 * The dry run prints the row snapshot and account context so you can verify
 * you have the right user BEFORE anything changes. Save that output: it is
 * also your restore path.
 *
 * Usage:
 *   npx tsx scripts/support/unlink-bankid.ts --email user@example.se --reason "GH-1234"            # dry run
 *   npx tsx scripts/support/unlink-bankid.ts --email user@example.se --reason "GH-1234" --execute  # performs the unlink
 *   (accepts --user-id <uuid> instead of --email when the profile has no email)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION: the dry run is read-only.
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

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const EXECUTE = process.argv.includes('--execute')
const EMAIL = argValue('--email')?.trim().toLowerCase() ?? null
const USER_ID = argValue('--user-id')?.trim() ?? null
const REASON = argValue('--reason')?.trim() ?? null

if (!EMAIL && !USER_ID) {
  console.error('Usage: npx tsx scripts/support/unlink-bankid.ts --email <email> [--reason <ref>] [--execute]')
  process.exit(1)
}
if (EXECUTE && !REASON) {
  console.error('--execute requires --reason (support ticket / issue reference for the audit log)')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

async function main() {
  // Resolve the user. profiles mirrors auth emails for active accounts;
  // anonymized accounts may lack it, hence the --user-id escape hatch.
  let userId = USER_ID
  if (!userId) {
    const { data: profile, error } = await sb
      .from('profiles')
      .select('id, email')
      .eq('email', EMAIL)
      .maybeSingle()
    if (error) {
      console.error('profiles lookup failed:', error.message)
      process.exit(1)
    }
    if (!profile) {
      console.error(`No profile with email ${EMAIL}. If the account is anonymized, pass --user-id.`)
      process.exit(1)
    }
    userId = profile.id
  }
  if (!userId) {
    console.error('Could not resolve a user id')
    process.exit(1)
  }

  const { data: authUser, error: authError } = await sb.auth.admin.getUserById(userId)
  if (authError || !authUser?.user) {
    console.error('auth user not found:', authError?.message ?? userId)
    process.exit(1)
  }

  const { data: identity, error: identityError } = await sb
    .from('bankid_identities')
    .select('user_id, personal_number_hash, personal_number_enc, given_name, surname, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (identityError) {
    console.error('bankid_identities lookup failed:', identityError.message)
    process.exit(1)
  }
  if (!identity) {
    console.log(`No BankID identity linked to ${authUser.user.email} (${userId}). Nothing to do.`)
    process.exit(0)
  }

  // Account context so the operator can confirm this is the STALE account
  // (the expected shape: few companies, no journal entries).
  const { data: memberships } = await sb
    .from('company_members')
    .select('company_id, companies:company_id(name, org_number)')
    .eq('user_id', userId)
  const companyIds = (memberships ?? []).map((m) => m.company_id)
  let entryCount = 0
  if (companyIds.length > 0) {
    const { count } = await sb
      .from('journal_entries')
      .select('*', { count: 'exact', head: true })
      .in('company_id', companyIds)
    entryCount = count ?? 0
  }

  console.log('-- BankID unlink ------------------------------------------')
  console.log('account:        ', authUser.user.email, `(${userId})`)
  console.log('bankid holder:  ', [identity.given_name, identity.surname].filter(Boolean).join(' '))
  console.log('linked since:   ', identity.created_at)
  console.log('companies:      ', (memberships ?? []).map((m) => {
    const c = m.companies as unknown as { name?: string; org_number?: string } | null
    return `${c?.name ?? '?'} (${c?.org_number ?? 'no orgnr'})`
  }).join(', ') || 'none')
  console.log('journal entries:', entryCount)
  if (entryCount > 0) {
    console.log('WARNING: this account has real bookkeeping. Unlinking BankID from an')
    console.log('ACTIVE account is unusual: double-check you have the right one.')
  }
  console.log('row snapshot (KEEP THIS: restore = re-insert):')
  console.log(JSON.stringify(identity))
  console.log('-----------------------------------------------------------')

  if (!EXECUTE) {
    console.log('Dry run. Re-run with --reason <ref> --execute to unlink.')
    return
  }

  const { error: deleteError } = await sb
    .from('bankid_identities')
    .delete()
    .eq('user_id', userId)
    .eq('personal_number_hash', identity.personal_number_hash)
  if (deleteError) {
    console.error('DELETE failed, nothing changed:', deleteError.message)
    process.exit(1)
  }

  // Clear the settings-page "BankID linked" flag. Merge, never replace.
  const priorMeta = authUser.user.app_metadata ?? {}
  const { error: metaError } = await sb.auth.admin.updateUserById(userId, {
    app_metadata: { ...priorMeta, bankid_linked: false },
  })
  if (metaError) {
    console.error('app_metadata update failed (unlink itself succeeded):', metaError.message)
  }

  // Append-only audit trail. user_id = the affected user, so the entry is
  // visible to them under the audit_log RLS select policy.
  const { error: auditError } = await sb.from('audit_log').insert({
    user_id: userId,
    action: 'SECURITY_EVENT',
    table_name: 'bankid_identities',
    record_id: userId,
    old_state: identity,
    description: `support unlink-bankid: ${REASON}`,
  })
  if (auditError) {
    console.error('audit_log insert failed. The unlink went through; file the printed')
    console.error('snapshot above manually. Error:', auditError.message)
    process.exit(1)
  }

  console.log('Unlinked. The user can now link BankID from their other account:')
  console.log('password login there, then Inställningar → Konto → koppla BankID.')
}

main()
