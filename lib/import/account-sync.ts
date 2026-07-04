/**
 * Chart-of-accounts synchronization for SIE imports.
 *
 * Single home for the "ensure every mapped target account exists" logic that
 * previously lived in three near-identical copies (executeSIEImport, the
 * /api/import/sie/execute route, and the arcim-migration extension), plus the
 * rename pass that carries customized #KONTO names from the SIE file into
 * accounts that already exist (e.g. the K1-seeded defaults).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBASReference, type BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { AccountMapping } from './types'

export interface AccountSyncResult {
  /** Accounts inserted into chart_of_accounts */
  created: number
  /** Existing accounts whose name was updated from the SIE file */
  renamed: number
  /** Detail of each rename, for warnings/logging */
  renamedAccounts: Array<{ accountNumber: string; from: string; to: string }>
  /** Renames that failed (non-fatal: the import proceeds with old names) */
  renameFailed: number
  /** Fatal error from the create pass; null on success */
  error: string | null
}

function emptyResult(): AccountSyncResult {
  return { created: 0, renamed: 0, renamedAccounts: [], renameFailed: 0, error: null }
}

/**
 * Build a chart_of_accounts insert row with the richest metadata available:
 * BAS reference when the number is in BAS_REFERENCE (incl. description and
 * k2_excluded), otherwise derived from the account number.
 */
function buildInsertRow(
  accountNumber: string,
  accountName: string,
  basRef: BASReferenceAccount | undefined,
  companyId: string,
  userId: string,
) {
  const sortOrder = /^\d+$/.test(accountNumber) ? parseInt(accountNumber, 10) : null

  if (basRef) {
    return {
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: accountName,
      account_class: basRef.account_class,
      account_group: basRef.account_group,
      account_type: basRef.account_type,
      normal_balance: basRef.normal_balance,
      sru_code: basRef.sru_code ?? computeSRUCode(accountNumber),
      k2_excluded: basRef.k2_excluded,
      plan_type: 'full_bas' as const,
      is_active: true,
      is_system_account: false,
      description: basRef.description,
      sort_order: sortOrder,
    }
  }

  // Sub-account not in the BAS reference (e.g. 1932 Sparkonto). Derive
  // metadata from the account number.
  const classified = classifyAccount(accountNumber)
  return {
    user_id: userId,
    company_id: companyId,
    account_number: accountNumber,
    account_name: accountName,
    account_class: parseInt(accountNumber.charAt(0), 10),
    account_group: accountNumber.substring(0, 2),
    account_type: classified.account_type,
    normal_balance: classified.normal_balance,
    sru_code: computeSRUCode(accountNumber),
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: accountName,
    sort_order: sortOrder,
  }
}

/**
 * Ensure every mapped target account exists in chart_of_accounts and,
 * when `updateAccountNames` is true, carry the SIE file's #KONTO names into
 * the chart.
 *
 * Name resolution: the file's name applies only to IDENTITY mappings
 * (sourceAccount === targetAccount with a non-empty sourceName): when the
 * user remaps a source to a different target, the file name describes the
 * source account, not the target, so the target keeps its BAS/current name.
 *
 *   - Create: account_name = file name (identity, flag on)
 *       ?? BAS reference name
 *       ?? targetName/sourceName fallback (non-BAS numbers)
 *       ?? `Konto ${number}`.
 *   - Rename (flag on only): existing accounts that are identity targets and
 *     whose stored name differs from the file name get a scoped UPDATE of
 *     account_name, and nothing else. Applies to is_system_account rows too
 *     (K1-seeded defaults); the flag itself is never touched. Equal names are
 *     a no-op, so replace-mode re-imports (Fortnox re-sync) are idempotent.
 *
 * When `updateAccountNames` is false the behavior matches the legacy code
 * exactly: BAS defaults on create, existing accounts untouched.
 */
export async function syncMappedAccounts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  mappings: AccountMapping[],
  updateAccountNames: boolean,
): Promise<AccountSyncResult> {
  const result = emptyResult()

  const targetAccounts = [...new Set(
    mappings.filter((m) => m.targetAccount).map((m) => m.targetAccount)
  )]
  if (targetAccounts.length === 0) return result

  // The SIE file's name for each identity-mapped account. Last write wins on
  // duplicate #KONTO records (rare, benign).
  const desiredNames = new Map<string, string>()
  if (updateAccountNames) {
    for (const m of mappings) {
      const name = m.sourceName?.trim()
      if (name && m.targetAccount && m.sourceAccount === m.targetAccount) {
        desiredNames.set(m.targetAccount, name)
      }
    }
  }

  // Legacy create-time fallback for numbers outside the BAS reference.
  const fallbackNames = new Map<string, string>()
  for (const m of mappings) {
    const fallback = m.targetName || m.sourceName
    if (m.targetAccount && fallback) fallbackNames.set(m.targetAccount, fallback)
  }

  // Fetch the company's chart once (paged) and filter in JS: avoids a huge
  // .in() URL for full-chart imports and the silent 1000-row PostgREST cap.
  let existingByNumber: Map<string, string>
  try {
    const targetSet = new Set(targetAccounts)
    const allAccounts = await fetchAllRows<{ account_number: string; account_name: string }>(
      ({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select('account_number, account_name')
          .eq('company_id', companyId)
          // Stable total order on the unique account_number: paging is only
          // correct with a deterministic order, else rows duplicate/skip across
          // pages (see fetch-all.ts ordering invariant). The result is read into
          // a Map below, so this order is invisible to callers.
          .order('account_number', { ascending: true })
          .range(from, to)
    )
    existingByNumber = new Map(
      allAccounts
        .filter((a) => targetSet.has(a.account_number))
        .map((a) => [a.account_number, a.account_name])
    )
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Failed to load chart of accounts'
    return result
  }

  // Create pass: insert missing target accounts.
  const missing = targetAccounts.filter((num) => !existingByNumber.has(num))
  if (missing.length > 0) {
    const inserts = missing.map((num) => {
      const basRef = getBASReference(num)
      const name =
        desiredNames.get(num) ??
        basRef?.account_name ??
        fallbackNames.get(num) ??
        `Konto ${num}`
      return buildInsertRow(num, name, basRef, companyId, userId)
    })

    const { error: insertError } = await supabase.from('chart_of_accounts').insert(inserts)
    // A duplicate means a concurrent import (or the replace flow) created the
    // account between our read and write: the account exists, which is all
    // this pass guarantees.
    if (insertError && !insertError.message.includes('duplicate')) {
      result.error = insertError.message
      return result
    }
    result.created = missing.length
  }

  // Rename pass: carry the file's names into existing accounts. The diff set
  // is small (only names that actually changed), so the UPDATEs run
  // concurrently in bounded batches: a full-chart re-sync must not serialize
  // N round trips, but also must not stampede the API with 1000+ in flight.
  if (updateAccountNames) {
    const renames: Array<{ num: string; from: string; to: string }> = []
    for (const [num, currentName] of existingByNumber) {
      const desired = desiredNames.get(num)
      if (desired && desired !== currentName) {
        renames.push({ num, from: currentName, to: desired })
      }
    }

    const RENAME_BATCH_SIZE = 25
    for (let i = 0; i < renames.length; i += RENAME_BATCH_SIZE) {
      const batch = renames.slice(i, i + RENAME_BATCH_SIZE)
      const outcomes = await Promise.allSettled(
        batch.map(async ({ num, to }) => {
          const { error: updateError } = await supabase
            .from('chart_of_accounts')
            .update({ account_name: to })
            .eq('company_id', companyId)
            .eq('account_number', num)
          if (updateError) throw new Error(updateError.message)
        })
      )

      outcomes.forEach((outcome, idx) => {
        if (outcome.status === 'rejected') {
          // Non-fatal: the import is still correct with the old name.
          result.renameFailed++
          return
        }
        result.renamed++
        const { num, from, to } = batch[idx]
        result.renamedAccounts.push({ accountNumber: num, from, to })
      })
    }
  }

  return result
}
