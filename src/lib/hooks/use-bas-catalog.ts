'use client'

import { useEffect, useMemo, useState } from 'react'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { getSelectableCorrectionCatalog } from '@/lib/bookkeeping/correction-line-account'
import { useAccounts } from '@/lib/reference-data/hooks'
import type { BASAccount } from '@/types'

const EMPTY_CATALOG: CatalogAccount[] = []

export interface BasCatalogState {
  /**
   * The BAS catalogue for a booking picker, beyond the active chart: what it
   * lists as activated at booking. Without the accounts the company
   * deactivated unless the host asked for them (see useBasCatalog).
   */
  catalog: CatalogAccount[]
  /** The company's whole chart, inactive accounts included; null while loading or after a failed load. */
  chart: BASAccount[] | null
}

/**
 * The catalogue for an AccountCombobox's `catalog` prop in a booking dialog
 * (crm#1101): with it the picker lists the standard accounts the company has
 * not added yet instead of answering "Hittade inget konto" for them. Loaded
 * on mount through the session-wide loadBasCatalog (a failed load retries
 * on the next mount); the chart comes from the session cache.
 *
 * `includeDeactivated` lists the accounts the company deactivated as well,
 * for a host that activates the picked account before it books (the Bokför
 * review, through activateBasAccounts), as JournalEntryForm lists them and
 * reactivates one on its activation confirm. Without it they stay out, as in
 * the correction dialogs and the invoice match, whose engine paths add a
 * missing standard account but never reactivate one.
 */
export function useBasCatalog(options: { includeDeactivated?: boolean } = {}): BasCatalogState {
  const includeDeactivated = options.includeDeactivated === true
  const [bas, setBas] = useState<CatalogAccount[]>(EMPTY_CATALOG)
  useEffect(() => {
    let alive = true
    void loadBasCatalog().then((data) => {
      if (alive) setBas(data)
    })
    return () => {
      alive = false
    }
  }, [])
  const { accounts, isLoading, error } = useAccounts(false)
  const chart = isLoading || error ? null : accounts
  // Offered only once the chart says which accounts the company deactivated.
  const catalog = useMemo(
    () => (!chart ? EMPTY_CATALOG : includeDeactivated ? bas : getSelectableCorrectionCatalog(chart, bas)),
    [chart, bas, includeDeactivated],
  )
  return { catalog, chart }
}
