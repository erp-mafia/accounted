'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ExclamationTriangleIcon } from '@/components/icons'
import { createClient } from '@/lib/supabase/client'
import { onBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSelfHosted } from '@/lib/env/public-flags'
import {
  getChipState,
  type ConnectionRow,
} from '@/lib/transactions/bank-sync-chip-state'
import { chooseAccountsHref } from '@/lib/bank-feed/connection-links'

export function useAgeFormatter() {
  const t = useTranslations('transactions')
  return (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    const min = Math.floor(ms / 60000)
    if (min < 1) return t('bank_sync_age_just_now')
    if (min < 60) return t('bank_sync_age_minutes', { count: min })
    const h = Math.floor(min / 60)
    if (h < 24) return t('bank_sync_age_hours', { count: h })
    const d = Math.floor(h / 24)
    return t('bank_sync_age_days', { count: d })
  }
}

export default function BankSyncStatusChip() {
  const t = useTranslations('transactions')
  const formatAge = useAgeFormatter()
  const { company } = useCompany()
  const hasBankSync = useCapability(CAPABILITY.bank_sync)
  const [rows, setRows] = useState<ConnectionRow[] | null>(null)

  useEffect(() => {
    if (!company?.id) return
    const companyId = company.id
    let cancelled = false
    const supabase = createClient()

    const load = () => {
      supabase
        .from('bank_connections')
        .select('id, status, last_synced_at, consent_expires, aggregator')
        .eq('company_id', companyId)
        .then(({ data, error }) => {
          if (cancelled) return
          // On error keep the chip hidden (empty rows) rather than rendering a
          // false "healthy" state from stale data.
          setRows(error ? [] : (data ?? []))
        })
    }

    load()
    // Refetch when a manual "Sync now" / reconnect elsewhere on the page
    // changes the connections, so the chip doesn't keep showing "synced 2d ago".
    const unsubscribe = onBankSyncUpdated(load)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [company?.id])

  if (!rows) return null

  const state = getChipState(rows, { hasBankSync })

  if (state.kind === 'none') return null

  if (state.kind === 'paused') {
    // Hosted points at billing, self-host at the connector key (never the
    // Stripe page). This chip is the transactions page's upgrade path for a
    // company with a bank connection but no bank_sync plan.
    const selfHosted = isSelfHosted()
    return (
      <Link
        href={selfHosted ? '/settings/banking' : '/settings/billing'}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-attn transition-colors hover:bg-secondary/60"
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        <span>
          {selfHosted
            ? t('bank_sync_paused_connector_key')
            : t('bank_sync_paused_subscription')}
        </span>
      </Link>
    )
  }

  if (state.kind === 'attention') {
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        <span>
          {state.count === 1
            ? t('bank_sync_attention_one')
            : t('bank_sync_attention_many', { count: state.count })}
        </span>
      </Link>
    )
  }

  if (state.kind === 'selection') {
    // The bank is authorized but no accounts were chosen, so nothing syncs.
    // Links straight into the account choice for that connection: Koppla
    // banken for an Open Payments row, the Enable Banking panel's picker for
    // the rest (lib/bank-feed/connection-links.ts). Same neutral shape +
    // ochre text as 'expiring'.
    return (
      <Link
        href={chooseAccountsHref({ id: state.connectionId, aggregator: state.aggregator })}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-attn transition-colors hover:bg-secondary/60"
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        <span>
          {state.count === 1
            ? t('bank_sync_selection_one')
            : t('bank_sync_selection_many', { count: state.count })}
        </span>
      </Link>
    )
  }

  if (state.kind === 'expiring') {
    // The consent is still alive, so the connection syncs today; the ochre
    // text says "act before it dies" without the terracotta of a dead one.
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-attn transition-colors hover:bg-secondary/60"
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        <span>
          {state.count === 1
            ? t('bank_sync_expiring_one', { days: state.daysLeft })
            : t('bank_sync_expiring_many', { count: state.count, days: state.daysLeft })}
        </span>
      </Link>
    )
  }

  if (state.kind === 'stale') {
    // Same neutral shape as the healthy chip: the ochre text is the signal,
    // never an amber box (convention 12: status colors are data, not chrome).
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-attn transition-colors hover:bg-secondary/60"
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5" />
        <span>
          {t('bank_sync_stale_warning')}
          <span className="ml-1 tabular-nums opacity-70">({formatAge(state.mostRecent)})</span>
        </span>
      </Link>
    )
  }

  // Healthy: nothing to say. A nightly sync that ran is the expected state,
  // and a permanent pill reporting it is chrome. Every state that needs the
  // person (paused, attention, expiring consent, stale) speaks above.
  return null
}
