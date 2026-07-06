#!/usr/bin/env npx tsx
/**
 * Backfill missing accounts into chart_of_accounts for ALL tenants.
 *
 * Finds accounts referenced by journal_entry_lines but not in chart_of_accounts,
 * resolves metadata from BAS reference (primary) or SIE account mappings (fallback),
 * and inserts them.
 *
 * Usage: npx tsx scripts/backfill-import-accounts.ts [--dry-run]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { getBASReference } from '../lib/bookkeeping/bas-reference'
import { classifyAccount } from '../lib/bookkeeping/account-classifier'
import { computeSRUCode } from '../lib/bookkeeping/bas-data/sru-mapping'

const DRY_RUN = process.argv.includes('--dry-run')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

// ---------------------------------------------------------------------------
// Non-BAS account overrides (company-specific sub-accounts not in BAS 2026)
// Only used when BAS reference and SIE source_name both miss.
// ---------------------------------------------------------------------------

interface AccountOverride {
  account_name: string
  account_type?: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'untaxed_reserves'
  normal_balance?: 'debit' | 'credit'
}

const NON_BAS_OVERRIDES: Record<string, AccountOverride> = {
  '1402': { account_name: 'Förråd av varor' },
  '1799': { account_name: 'Observationskonto' },
  '2662': {
    account_name: 'Kortfristig skuld Le comptoir',
    account_type: 'liability',
    normal_balance: 'credit',
  },
  '3041': { account_name: 'Försäljning tjänster 25% Sverige' },
  '3051': { account_name: 'Försäljning varor 25% Sverige' },
  '3052': { account_name: 'Försäljning varor 12% Sverige' },
  '4020': { account_name: 'Alkoholskatt' },
  '4056': { account_name: 'Inköp varor 25% EU' },
  '4057': { account_name: 'Inköp varor 12% EU' },
  '4071': { account_name: 'Lagerkostnader' },
  '4072': { account_name: 'Inköp frakt 25% EU' },
  '4990': { account_name: 'Lagerförändring' },
  '4992': { account_name: 'Varor på väg' },
  '6561': { account_name: 'GS1' },
  '8300': { account_name: 'Ränteintäkter (gruppkonto)' },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getUsedAccountNumbers(userId: string): Promise<Set<string>> {
  const usedSet = new Set<string>()
  const PAGE_SIZE = 1000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data: batch, error } = await supabase
      .from('journal_entry_lines')
      .select('account_number, journal_entries!inner(user_id)')
      .eq('journal_entries.user_id', userId)
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw new Error(`Failed to fetch lines for ${userId}: ${error.message}`)

    for (const row of batch ?? []) {
      usedSet.add(row.account_number)
    }

    hasMore = (batch?.length ?? 0) === PAGE_SIZE
    offset += PAGE_SIZE
  }

  return usedSet
}

async function getSIESourceNames(userId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('sie_account_mappings')
    .select('source_account, source_name')
    .eq('user_id', userId)

  if (error) throw new Error(`Failed to fetch SIE mappings for ${userId}: ${error.message}`)

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    map.set(row.source_account, row.source_name)
  }
  return map
}

// ---------------------------------------------------------------------------
// Per-tenant backfill
// ---------------------------------------------------------------------------

async function backfillForUser(userId: string): Promise<number> {
  console.log(`\n--- User ${userId} ---`)

  // Get existing accounts
  const { data: existingAccounts, error: existingError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('user_id', userId)

  if (existingError) throw new Error(`Failed to fetch accounts: ${existingError.message}`)
  const existingSet = new Set(existingAccounts?.map(a => a.account_number) ?? [])

  // Get used account numbers from journal entries
  const usedSet = await getUsedAccountNumbers(userId)
  const missingAccounts = [...usedSet].filter(num => !existingSet.has(num)).sort()

  if (missingAccounts.length === 0) {
    console.log('  No missing accounts.')
    return 0
  }

  console.log(`  Found ${missingAccounts.length} missing accounts`)

  // Get SIE source names as fallback for account naming
  const sieNames = await getSIESourceNames(userId)

  // Build insert rows
  const rows = missingAccounts.map(accountNumber => {
    const basRef = getBASReference(accountNumber)

    if (basRef) {
      return {
        user_id: userId,
        account_number: accountNumber,
        account_name: basRef.account_name,
        account_class: basRef.account_class,
        account_group: basRef.account_group,
        account_type: basRef.account_type,
        normal_balance: basRef.normal_balance,
        sru_code: basRef.sru_code ?? computeSRUCode(accountNumber),
        k2_excluded: basRef.k2_excluded,
        plan_type: 'full_bas' as const,
        is_active: true,
        is_system_account: false,
      }
    }

    // Check hardcoded overrides (for company-specific accounts with known metadata)
    const override = NON_BAS_OVERRIDES[accountNumber]
    if (override) {
      const classified = classifyAccount(accountNumber)
      const accountType = override.account_type ?? classified.account_type
      const normalBalance = override.normal_balance ?? classified.normal_balance
      const classNum = parseInt(accountNumber.charAt(0), 10)
      return {
        user_id: userId,
        account_number: accountNumber,
        account_name: override.account_name,
        account_class: classNum,
        account_group: accountNumber.substring(0, 2),
        account_type: accountType,
        normal_balance: normalBalance,
        sru_code: computeSRUCode(accountNumber),
        k2_excluded: false,
        plan_type: 'full_bas' as const,
        is_active: true,
        is_system_account: false,
      }
    }

    // Fallback: use SIE source_name if available, otherwise derive
    const sieName = sieNames.get(accountNumber)
    const classNum = parseInt(accountNumber.charAt(0), 10)
    if (sieName) {
      console.warn(`  INFO: Account ${accountNumber} not in BAS: using SIE name: "${sieName}"`)
    } else {
      console.warn(`  WARNING: Account ${accountNumber} not in BAS or SIE: deriving all metadata`)
    }

    const classified = classifyAccount(accountNumber)
    return {
      user_id: userId,
      account_number: accountNumber,
      account_name: sieName ?? `Konto ${accountNumber}`,
      account_class: classNum,
      account_group: accountNumber.substring(0, 2),
      account_type: classified.account_type,
      normal_balance: classified.normal_balance,
      sru_code: computeSRUCode(accountNumber),
      k2_excluded: false,
      plan_type: 'full_bas' as const,
      is_active: true,
      is_system_account: false,
    }
  })

  // Log summary
  const fromBAS = rows.filter(r => getBASReference(r.account_number)).length
  const fromOverride = rows.filter(r => !getBASReference(r.account_number) && NON_BAS_OVERRIDES[r.account_number]).length
  const fromFallback = rows.length - fromBAS - fromOverride
  console.log(`  ${fromBAS} from BAS, ${fromOverride} from overrides, ${fromFallback} from SIE/derived`)

  for (const row of rows) {
    console.log(`    ${row.account_number}: ${row.account_name} (${row.account_type}, SRU: ${row.sru_code ?? 'none'})`)
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would insert ${rows.length} accounts`)
    return rows.length
  }

  const { error: insertError } = await supabase
    .from('chart_of_accounts')
    .insert(rows)

  if (insertError) {
    console.error(`  Insert failed: ${insertError.message}`)
    return 0
  }

  console.log(`  Inserted ${rows.length} accounts`)
  return rows.length
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (DRY_RUN) console.log('=== DRY RUN MODE ===\n')

  // Find all users with missing accounts
  const { data: allImportUsers, error } = await supabase
    .from('sie_imports')
    .select('user_id')

  if (error) {
    console.error('Failed to fetch SIE import users:', error.message)
    process.exit(1)
  }

  const userIds = [...new Set(allImportUsers?.map(r => r.user_id) ?? [])]
  console.log(`Found ${userIds.length} users with SIE imports`)

  let totalInserted = 0
  for (const userId of userIds) {
    totalInserted += await backfillForUser(userId)
  }

  console.log(`\n=== Done: ${totalInserted} accounts ${DRY_RUN ? 'would be' : ''} inserted across ${userIds.length} users ===`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
