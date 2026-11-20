'use client'

import { useCallback, useState } from 'react'
import type { BankConnectReturnSurface, BankConnectReturnTarget } from '@/lib/bank-feed/return-url'
import type { FlowMode } from './flow-steps'
import type { OpenFlowOptions } from './connect-flow-reducer'

export interface BankConnectOptions extends OpenFlowOptions {
  /** Shown on the switch intro: "Gör det senast {date}" (ISO date). */
  deadline?: string | null
}

export interface BankConnectSession {
  /** Changes on every open, so the dialog starts from a clean state each time. */
  key: number
  mode: FlowMode
  options: BankConnectOptions
  /**
   * The entry point this flow belongs to: where a bank's own page sends the
   * browser back. Null when the surface has no page of its own. The signatory
   * page (app/koppla/[token]) is its own target, built from the link's token
   * by the token routes.
   */
  returnTo: BankConnectReturnTarget | null
}

export interface BankConnectFlow {
  session: BankConnectSession | null
  isOpen: boolean
  /** Open Koppla banken: a new connection, a switch from an Enable Banking row, a renewal of an Open Payments row, or a resume for the second signatory or a return from the bank. */
  open: (mode: FlowMode, options?: BankConnectOptions) => void
  close: () => void
}

/**
 * The state behind one Koppla banken dialog: where it was opened from and
 * in which mode. Entry points (settings rows, onboarding, later the worklist
 * and a banner) call `open(mode, options)` and render
 * `<BankConnectDialog flow={flow} />` once. `returnTo` names the entry
 * point's own page, so a bank that signs on its own page can come back to it.
 */
export function useBankConnectFlow(returnTo: BankConnectReturnSurface | null = null): BankConnectFlow {
  const [session, setSession] = useState<BankConnectSession | null>(null)
  const open = useCallback(
    (mode: FlowMode, options: BankConnectOptions = {}) => {
      setSession({ key: Date.now(), mode, options, returnTo })
    },
    [returnTo],
  )
  const close = useCallback(() => setSession(null), [])
  return { session, isOpen: session !== null, open, close }
}
