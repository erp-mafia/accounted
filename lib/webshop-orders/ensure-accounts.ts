import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { WEBSHOP_PREFILL_ACCOUNTS } from './booking-lines'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

/**
 * Add the BAS accounts our own webshop prefill needs to the company's chart,
 * so booking an order does not fail on AccountsNotInChartError.
 *
 * Why this exists: seed_chart_of_accounts() seeds a deliberately small chart.
 * 3001/3002/3003 and 2611/2621/2631 are in it; 3004 (momsfri försäljning),
 * 3740 (öresavrundning) and 1686 (the clearing account) are not. Every one of
 * those is reachable from a perfectly ordinary order: a 0%-rate line, an öre
 * residual, or simply no payment-method mapping yet. Before this, the user's
 * first click on Bokför returned "kontot saknas i kontoplanen" with no way
 * forward except hand-adding accounts they had no reason to know about.
 *
 * Deliberately narrow: only account numbers in WEBSHOP_PREFILL_ACCOUNTS are
 * ever created, and only when a submitted line actually uses one. An account
 * the user typed or picked themselves is never auto-created, so a typo still
 * surfaces as a real error instead of quietly growing the chart.
 *
 * Reactivates a soft-deleted (is_active = false) row rather than inserting a
 * duplicate: the engine treats inactive exactly like missing, and the unique
 * (company_id, account_number) index would reject the insert anyway.
 *
 * Non-fatal by design. If this cannot write, booking proceeds and the engine
 * raises its normal typed error; we never block a verifikat on a chart tidy-up.
 */
export async function ensureWebshopPrefillAccounts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountNumbers: string[],
  log?: Logger,
): Promise<void> {
  const wanted = [...new Set(accountNumbers)].filter((n) =>
    WEBSHOP_PREFILL_ACCOUNTS.includes(n),
  )
  if (wanted.length === 0) return

  try {
    const { data: existing, error } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number, is_active')
      .eq('company_id', companyId)
      .in('account_number', wanted)
    if (error) {
      log?.warn('webshop chart lookup failed; booking continues', { error: error.message })
      return
    }

    const present = new Map<string, { id: string; is_active: boolean }>()
    for (const row of existing ?? []) {
      present.set(row.account_number as string, {
        id: row.id as string,
        is_active: row.is_active as boolean,
      })
    }

    const toReactivate = wanted
      .map((n) => present.get(n))
      .filter((row): row is { id: string; is_active: boolean } => !!row && !row.is_active)
      .map((row) => row.id)
    if (toReactivate.length > 0) {
      const { error: reactivateError } = await supabase
        .from('chart_of_accounts')
        .update({ is_active: true })
        .in('id', toReactivate)
        .eq('company_id', companyId)
      if (reactivateError) {
        log?.warn('webshop chart reactivate failed; booking continues', {
          error: reactivateError.message,
        })
      }
    }

    const missing = wanted.filter((n) => !present.has(n))
    if (missing.length === 0) return

    // Inserted one row at a time with a literal payload on purpose: the
    // no-phantom-columns guard can only verify columns it can resolve
    // statically, and a .map()-built array reads as an opaque expression. At
    // most eight accounts, only on first use, so the extra round trips are
    // cheaper than an unverifiable insert.
    for (const accountNumber of missing) {
      // Every WEBSHOP_PREFILL_ACCOUNTS member is a real BAS 2026 account, so a
      // miss here means the reference data drifted: skip rather than invent
      // metadata for an account we cannot describe.
      const bas = getBASReference(accountNumber)
      if (!bas) {
        log?.warn('no BAS reference for webshop prefill account', { accountNumber })
        continue
      }
      // Concurrent bookings of two orders race here; ignoreDuplicates makes
      // the loser a no-op instead of a 23505 that would fail a fine entry.
      const { error: insertError } = await supabase.from('chart_of_accounts').upsert(
        {
          user_id: userId,
          company_id: companyId,
          account_number: accountNumber,
          account_name: bas.account_name,
          account_class: bas.account_class,
          account_group: bas.account_group,
          account_type: bas.account_type,
          normal_balance: bas.normal_balance,
          sru_code: bas.sru_code ?? null,
          k2_excluded: bas.k2_excluded ?? false,
          plan_type: 'full_bas',
          is_active: true,
          is_system_account: false,
        },
        { onConflict: 'company_id,account_number', ignoreDuplicates: true },
      )
      if (insertError) {
        log?.warn('webshop chart insert failed; booking continues', {
          accountNumber,
          error: insertError.message,
        })
      }
    }
  } catch (err) {
    log?.warn('webshop chart ensure threw; booking continues', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
