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
 * 1. writes an append-only audit_log row (SECURITY_EVENT) carrying the full
 *    old row FIRST: if the audit insert fails nothing is deleted, and if the
 *    delete fails the audit row merely over-records (the safe direction),
 * 2. deletes the bankid_identities row for the user,
 * 3. clears app_metadata.bankid_linked (read-merge-write: updateUserById
 *    replaces app_metadata wholesale, see app/api/account/password/route.ts).
 *
 * The dry run prints only non-sensitive account context (never the
 * personnummer hash or ciphertext: the unsalted hash is brute-forceable
 * over the small personnummer space). The restore path is the audit_log
 * row's old_state, readable with the service key.
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
    .select('id, user_id, personal_number_hash, personal_number_enc, given_name, surname, linked_at, created_at, updated_at')
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
  // (the expected shape: few companies, no journal entries). Fail closed:
  // a failed context query must never make an unknown account look empty.
  const { data: memberships, error: membershipsError } = await sb
    .from('company_members')
    .select('company_id, companies:company_id(name, org_number)')
    .eq('user_id', userId)
  if (membershipsError) {
    console.error('company_members lookup failed, aborting:', membershipsError.message)
    process.exit(1)
  }
  const companyIds = (memberships ?? []).map((m) => m.company_id)
  let entryCount = 0
  if (companyIds.length > 0) {
    const { count, error: entriesError } = await sb
      .from('journal_entries')
      .select('*', { count: 'exact', head: true })
      .in('company_id', companyIds)
    if (entriesError || count === null) {
      console.error('journal_entries count failed, aborting:', entriesError?.message ?? 'null count')
      process.exit(1)
    }
    entryCount = count
  }

  console.log('-- BankID unlink ------------------------------------------')
  console.log('account:        ', authUser.user.email, `(${userId})`)
  console.log('bankid holder:  ', [identity.given_name, identity.surname].filter(Boolean).join(' '))
  console.log('linked since:   ', identity.linked_at)
  console.log('companies:      ', (memberships ?? []).map((m) => {
    const c = m.companies as unknown as { name?: string; org_number?: string } | null
    return `${c?.name ?? '?'} (${c?.org_number ?? 'no orgnr'})`
  }).join(', ') || 'none')
  console.log('journal entries:', entryCount)
  if (entryCount > 0) {
    console.log('WARNING: this account has real bookkeeping. Unlinking BankID from an')
    console.log('ACTIVE account is unusual: double-check you have the right one.')
  }
  console.log('identity row id: ', identity.id)
  console.log('-----------------------------------------------------------')

  if (!EXECUTE) {
    console.log('Dry run. Re-run with --reason <ref> --execute to unlink.')
    return
  }

  // Append-only audit trail FIRST, so a partial failure can never leave a
  // deletion without a trace. The full old row (including hash + ciphertext)
  // lives only here, RLS-protected; user_id = the affected user, so the
  // entry is visible to them under the audit_log RLS select policy.
  const { error: auditError } = await sb.from('audit_log').insert({
    user_id: userId,
    action: 'SECURITY_EVENT',
    table_name: 'bankid_identities',
    record_id: identity.id,
    old_state: identity,
    description: `support unlink-bankid (delete follows this entry): ${REASON}`,
  })
  if (auditError) {
    console.error('audit_log insert failed, aborting BEFORE delete. Nothing changed.')
    console.error('Error:', auditError.message)
    process.exit(1)
  }

  const { error: deleteError } = await sb
    .from('bankid_identities')
    .delete()
    .eq('id', identity.id)
  if (deleteError) {
    console.error('DELETE failed AFTER the audit row was written: the audit entry')
    console.error(`(record_id ${identity.id}) over-records; the identity row still exists.`)
    console.error('Error:', deleteError.message)
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

  console.log('Unlinked. Restore path: audit_log old_state for record_id', identity.id)
  console.log('The user can now link BankID from their other account:')
  console.log('password login there, then Inställningar → Konto → koppla BankID.')
}

main()
