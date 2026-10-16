'use client'

import { useCallback, useEffect, useState } from 'react'
import { LIVE_CONNECTION_STATUSES } from '@/lib/bank-sync/aggregator'
import { createClient } from '@/lib/supabase/client'
import { onBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { connectionKind, type ConnectionKind } from './connection-kind'
import type { BankConnectionStatus } from '@/types'

/** A bank_connections row as the settings rows read it: identity, state and which service reads it. */
export interface BankConnectionRow {
  id: string
  bank_name: string | null
  provider: string | null
  status: BankConnectionStatus
  consent_expires: string | null
  kind: ConnectionKind
}

export interface BankConnectionsState {
  /** Null until the first read answered. */
  rows: BankConnectionRow[] | null
  openPayments: BankConnectionRow[]
  enableBanking: BankConnectionRow[]
  refresh: () => void
}

/**
 * The company's live bank connections, split by the service that reads them.
 * Revoked rows and attempts in progress are left out; an expired consent
 * stays listed so the row can say "Förnya", and a connection whose sync
 * failed so the row can say so. Hiding that one left a company with a
 * connection it could neither see nor remove, and every new attempt at the
 * same bank was refused for it. Refetches when a sync or a connect signals a change
 * (lib/transactions/bank-sync-signal), so a flow that just finished shows up
 * without a reload.
 */
export function useOpenPaymentsConnections(companyId: string | null): BankConnectionsState {
  const [rows, setRows] = useState<BankConnectionRow[] | null>(null)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('id, bank_name, provider, status, consent_expires')
      .eq('company_id', companyId)
      .in('status', [...LIVE_CONNECTION_STATUSES])
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return
        const list = ((data ?? []) as Array<Omit<BankConnectionRow, 'kind'>>).map((row) => ({ ...row, kind: connectionKind(row) }))
        setRows(list)
      })
    return () => {
      cancelled = true
    }
  }, [companyId, generation])

  useEffect(() => onBankSyncUpdated(refresh), [refresh])

  // A change made outside this page sends no signal here: a switch finished
  // after the BankID app on a phone (the browser may have reloaded the page
  // mid-flow), in another tab, or by a firmatecknare on the signatory link.
  // Without a fresh read the page kept the old Enable Banking row beside the
  // new one, still offering the switch. Read again when the page is shown,
  // at most every five seconds.
  useEffect(() => {
    let last = 0
    const onShown = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - last < 5_000) return
      last = now
      refresh()
    }
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('pageshow', onShown)
    return () => {
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('pageshow', onShown)
    }
  }, [refresh])

  const list = rows ?? []
  return {
    rows,
    openPayments: list.filter((r) => r.kind === 'open_payments'),
    enableBanking: list.filter((r) => r.kind === 'enable_banking'),
    refresh,
  }
}
