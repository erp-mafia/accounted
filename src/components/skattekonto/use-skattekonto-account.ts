'use client'

import { useEffect, useState } from 'react'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import {
  SKATTEKONTO_ACCOUNT_DEFAULT,
  isSkattekontoLedgerAccount,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'

const ROUTE = '/api/settings/skattekonto-account?view=account'

/** One read per company per page load: the account changes only in settings. */
const cache = new Map<string, Promise<SkattekontoLedgerAccount>>()

function load(companyId: string): Promise<SkattekontoLedgerAccount> {
  let pending = cache.get(companyId)
  if (!pending) {
    pending = fetch(ROUTE)
      .then(async (res) => {
        if (!res.ok) return SKATTEKONTO_ACCOUNT_DEFAULT
        const json = (await res.json()) as { data?: { account?: unknown } }
        return isSkattekontoLedgerAccount(json.data?.account) ? json.data.account : SKATTEKONTO_ACCOUNT_DEFAULT
      })
      .catch(() => {
        // A failed read is retried on the next mount, never cached.
        cache.delete(companyId)
        return SKATTEKONTO_ACCOUNT_DEFAULT
      })
    cache.set(companyId, pending)
  }
  return pending
}

/**
 * The active company's skattekonto account (1630, or 2012 for an enskild
 * firma that runs it there, PH 175), for previews of a booking template's
 * lines: the server books the template on this account, so the preview must
 * show the same. 1630 until the read lands.
 */
export function useSkattekontoAccount(): SkattekontoLedgerAccount {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const [account, setAccount] = useState<SkattekontoLedgerAccount>(SKATTEKONTO_ACCOUNT_DEFAULT)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    void load(companyId).then((a) => {
      if (!cancelled) setAccount(a)
    })
    return () => {
      cancelled = true
    }
  }, [companyId])
  return account
}
