import type { SupabaseClient } from '@supabase/supabase-js'

import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** What the mapping step offers as a target, and what it renders per option. */
export interface MappingTarget {
  account_number: string
  account_name: string
  /** Grouping in the dropdown. Derived from the number when a row lacks it. */
  account_class?: number
}

/** BAS numbers are 4 digits and the first is the class: 3005 is class 3. */
function classOf(accountNumber: string): number | undefined {
  const first = Number.parseInt(accountNumber.slice(0, 1), 10)
  return Number.isFinite(first) ? first : undefined
}

/**
 * The accounts a Fortnox source account may be mapped onto: the company's own
 * chart first, then the BAS catalogue for standard accounts it has not created
 * yet.
 *
 * Why both. BAS alone hides every account a company added outside the
 * standard, and there are plenty: BAS defines 3000-3004 and stops, so an
 * account like 3005 "Provisioner inom Sverige" can be active in the chart,
 * listed everywhere else in the app, and still impossible to select as a
 * mapping target. The company
 * chart alone would be wrong in the other direction: on a first migration it
 * can be nearly empty, and the user is mapping onto standard accounts the
 * import is about to create.
 *
 * On a collision the company row wins. Its name is whatever the user renamed
 * the account to, and that is the label they are looking for in the list.
 *
 * A failed read degrades to BAS rather than throwing: an incomplete list still
 * lets the migration proceed, an error stops it dead.
 */
export async function buildMappingTargets(
  supabase: SupabaseClient,
  companyId: string,
  log?: { warn: (message: string, meta?: Record<string, unknown>) => void },
): Promise<MappingTarget[]> {
  let own: MappingTarget[] = []
  try {
    const rows = await fetchAllRows(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, account_class')
        .eq('company_id', companyId)
        .order('account_number')
        .range(from, to),
    )
    own = (rows as Array<Record<string, unknown>>).map((r) => ({
      account_number: String(r.account_number),
      account_name: String(r.account_name ?? ''),
      account_class:
        typeof r.account_class === 'number' ? r.account_class : classOf(String(r.account_number)),
    }))
  } catch (error) {
    // Degrading to BAS keeps the migration moving, but it silently reproduces
    // the very problem this function exists to fix: the company's own accounts
    // missing from the list. Leave a trace, so a mapping made against an
    // incomplete list can be explained afterwards rather than looking like a
    // deliberate choice.
    own = []
    log?.warn('chart_of_accounts read failed; mapping targets fall back to BAS only', {
      companyId,
      reason: error instanceof Error ? error.message : 'unknown',
    })
  }

  const seen = new Set(own.map((a) => a.account_number))
  const fromBas = BAS_REFERENCE.filter((b) => !seen.has(b.account_number)).map((b) => ({
    account_number: b.account_number,
    account_name: b.account_name,
    account_class: classOf(b.account_number),
  }))

  // Sorted by number so the dropdown's per-class groups read in order
  // regardless of which source a given account came from.
  return [...own, ...fromBas].sort((a, b) => a.account_number.localeCompare(b.account_number))
}
