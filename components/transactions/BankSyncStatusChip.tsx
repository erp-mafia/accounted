'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { onBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/info-tooltip'

interface ConnectionRow {
  id: string
  status: string | null
  last_synced_at: string | null
}

const STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000

type ChipState =
  | { kind: 'none' }
  | { kind: 'attention'; count: number }
  | { kind: 'stale'; mostRecent: string }
  | { kind: 'healthy'; mostRecent: string | null }

export function getChipState(rows: ConnectionRow[], now: number = Date.now()): ChipState {
  if (rows.length === 0) return { kind: 'none' }

  const needsAttention = rows.filter(
    (r) => r.status === 'expired' || r.status === 'error',
  )
  if (needsAttention.length > 0) {
    return { kind: 'attention', count: needsAttention.length }
  }

  const mostRecent = rows
    .map((r) => r.last_synced_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop()

  if (mostRecent && now - new Date(mostRecent).getTime() > STALE_THRESHOLD_MS) {
    return { kind: 'stale', mostRecent }
  }

  return { kind: 'healthy', mostRecent: mostRecent ?? null }
}

function useAgeFormatter() {
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
  const [rows, setRows] = useState<ConnectionRow[] | null>(null)

  useEffect(() => {
    if (!company?.id) return
    const companyId = company.id
    let cancelled = false
    const supabase = createClient()

    const load = () => {
      supabase
        .from('bank_connections')
        .select('id, status, last_synced_at')
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

  const state = getChipState(rows)

  if (state.kind === 'none') return null

  if (state.kind === 'attention') {
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          {state.count === 1
            ? t('bank_sync_attention_one')
            : t('bank_sync_attention_many', { count: state.count })}
        </span>
      </Link>
    )
  }

  if (state.kind === 'stale') {
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1 text-xs text-warning transition-colors hover:bg-warning/10"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          {t('bank_sync_stale_warning')}
          <span className="ml-1 tabular-nums opacity-70">({formatAge(state.mostRecent)})</span>
        </span>
      </Link>
    )
  }

  // healthy
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
            <span>
              {t('bank_sync_auto_nightly')}
              {state.mostRecent && (
                <>
                  {t('bank_sync_last_separator')}
                  <span className="tabular-nums">{formatAge(state.mostRecent)}</span>
                </>
              )}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[320px]">
          <div className="text-sm leading-relaxed">{t('bank_sync_latency_hint')}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
