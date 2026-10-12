'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { parseBankConnectReturn, stripBankConnectReturn } from './return-link'
import type { BankConnectFlow } from './use-bank-connect-flow'

/**
 * Open Koppla banken for a connection the URL names, once, and drop the
 * parameters: the second signatory arriving with the reminder link, and the
 * person coming back from a bank that signs on its own page (ok: the BankID
 * step waits and polls; error: the bank's code with Försök igen). Every
 * entry point that renders the dialog calls this with its own flow, so a
 * return lands on whichever page the signing started from.
 */
export function useBankConnectResume(flow: BankConnectFlow, enabled: boolean): void {
  const searchParams = useSearchParams()
  const handled = useRef(false)
  const parsed = parseBankConnectReturn(searchParams)
  const connectionId = parsed?.connectionId ?? null
  const result = parsed?.returned?.result ?? null
  const code = parsed?.returned?.code ?? null
  const open = flow.open
  useEffect(() => {
    if (!enabled || !connectionId || handled.current) return
    handled.current = true
    const timer = setTimeout(() => {
      open('resume', { connectionId, returned: result ? { result, code } : null })
      window.history.replaceState(window.history.state, '', stripBankConnectReturn(window.location.href))
    }, 0)
    return () => clearTimeout(timer)
  }, [enabled, connectionId, result, code, open])
}
