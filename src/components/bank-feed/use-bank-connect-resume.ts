'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { fetchOpenPaymentsConnection, type OpenPaymentsBank } from './open-payments-client'
import { parseBankConnectNew, parseBankConnectReturn, preselectedBank, stripBankConnectReturn } from './return-link'
import type { BankConnectFlow } from './use-bank-connect-flow'

/**
 * Open Koppla banken for what the URL names, once, and drop the parameters:
 * the second signatory arriving with the reminder link, the person coming
 * back from a bank that signs on its own page (ok: the BankID step waits and
 * polls; error: the bank's code with Försök igen), the renewal mail's link
 * (`renew=1`), which opens the flow in renew mode for that connection, its
 * bank read from the row so the list is locked to it, and an agent's connect
 * link (`bank_connect=new[&bic=...]`, gnubok_connect_bank), which opens the
 * flow for a new connection with that bank preselected when `banks` knows
 * the BIC (the picker otherwise). Every entry point that renders the dialog
 * calls this with its own flow, so a return lands on whichever page the
 * signing started from.
 */
export function useBankConnectResume(flow: BankConnectFlow, enabled: boolean, banks: readonly OpenPaymentsBank[] | null = null): void {
  const searchParams = useSearchParams()
  const handled = useRef(false)
  const parsed = parseBankConnectReturn(searchParams)
  const connectionId = parsed?.connectionId ?? null
  const result = parsed?.returned?.result ?? null
  const code = parsed?.returned?.code ?? null
  const renew = parsed?.renew ?? false
  const fresh = parseBankConnectNew(searchParams)
  const wantsNew = fresh !== null
  const newBic = fresh?.bic ?? null
  const open = flow.open
  useEffect(() => {
    if (!enabled || handled.current || (!connectionId && !wantsNew)) return
    handled.current = true
    let cancelled = false
    const timer = setTimeout(() => {
      window.history.replaceState(window.history.state, '', stripBankConnectReturn(window.location.href))
      if (wantsNew) {
        open('new', { bank: preselectedBank(newBic, banks) })
        return
      }
      if (!connectionId) return
      if (!renew) {
        open('resume', { connectionId, returned: result ? { result, code } : null })
        return
      }
      // Renew: the row names the bank; without it the bank list stays open.
      void fetchOpenPaymentsConnection(connectionId)
        .then((connection) => (connection.bank_name ? { bic: connection.bic ?? '', name: connection.bank_name } : null))
        .catch(() => null)
        .then((bank) => {
          if (cancelled) return
          open('renew', { bank, replaceConnectionId: connectionId })
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [enabled, connectionId, result, code, renew, wantsNew, newBic, banks, open])
}
