'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'

interface BankConn {
  id: string
  bank_name: string
  status: string
  provider: string
}

/**
 * On-demand "Sync now" button beside BankSyncStatusChip. Reuses the
 * per-connection sync endpoint that BankingSettingsPanel already calls.
 *
 * Also handles dead PSD2 sessions: a connection whose consent has closed/expired
 * shows a "Förnya anslutning" action that re-authorizes in place (no disconnect
 * needed), and a sync that fails with a session-expiry surfaces the same
 * reconnect action right in the error toast. If the user has multiple
 * connections, a dropdown lets them pick which one to sync/reconnect.
 */
export default function BankSyncNowButton() {
  const t = useTranslations('transactions')
  const { toast } = useToast()
  const router = useRouter()
  const { company } = useCompany()
  const hasBankSync = useCapability(CAPABILITY.bank_sync)
  const [connections, setConnections] = useState<BankConn[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('id, bank_name, status, provider')
      // Include expired/error so the reconnect entry point survives a reload:
      // not just active connections that can sync.
      .in('status', ['active', 'expired', 'error'])
      .eq('company_id', company.id)
      .then(({ data }) => {
        if (!cancelled) setConnections((data as BankConn[]) ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  if (!connections || connections.length === 0) return null

  // Re-authorize an existing connection in place: posts the connection_id so
  // the server reuses the same row, then hands off to the bank's consent screen.
  async function reconnect(conn: BankConn) {
    setBusyId(conn.id)
    try {
      const country = conn.provider?.split('-').pop()?.toUpperCase() || 'SE'
      const res = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: conn.id,
          aspsp_name: conn.bank_name,
          aspsp_country: country,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reconnect failed')
      window.location.href = data.authorization_url
    } catch (error) {
      toast({
        title: t('bank_reconnect'),
        description: error instanceof Error ? error.message : 'Reconnect failed',
        variant: 'destructive',
      })
      setBusyId(null)
    }
  }

  async function syncConnection(conn: BankConn) {
    setBusyId(conn.id)
    try {
      const res = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: conn.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        // A dead PSD2 session can't be fixed by retrying: surface a one-click
        // reconnect in the toast instead of a dead-end error.
        if (data?.reauth_required) {
          toast({
            title: t('bank_sync_session_expired'),
            description: t('bank_sync_session_expired_desc'),
            variant: 'destructive',
            action: (
              <ToastAction altText={t('bank_reconnect')} onClick={() => reconnect(conn)}>
                {t('bank_reconnect')}
              </ToastAction>
            ),
          })
          // Reflect the now-expired status so the button flips to reconnect.
          setConnections((prev) =>
            (prev ?? []).map((c) => (c.id === conn.id ? { ...c, status: 'expired' } : c))
          )
          return
        }
        throw new Error(data.error || 'Sync failed')
      }
      toast({
        title: t('bank_sync_button_now'),
        description: data.imported === 1
          ? t('bank_sync_new_since_last_visit_one')
          : t('bank_sync_new_since_last_visit_many', { count: data.imported ?? 0 }),
      })
      router.refresh()
    } catch (error) {
      toast({
        title: t('bank_sync_button_now'),
        description: error instanceof Error ? error.message : 'Sync failed',
        variant: 'destructive',
      })
    } finally {
      setBusyId((prev) => (prev === conn.id ? null : prev))
    }
  }

  // Active connections sync; expired/error connections reconnect.
  function runFor(conn: BankConn) {
    if (conn.status === 'active') return syncConnection(conn)
    return reconnect(conn)
  }

  const isBusy = busyId !== null
  const syncLabel = isBusy ? t('bank_sync_button_syncing') : t('bank_sync_button_now')

  // Bank sync (and reconnect) is a paid external PSD2 call. Without the
  // capability we keep the button VISIBLE as the conversion surface but inert,
  // and surface an Uppgradera link. CSV/SIE import stays free (separate UI).
  const gateTitle = !hasBankSync ? 'Bankkoppling kräver ett abonnemang' : undefined
  const upsellNote = !hasBankSync ? (
    <span className="text-xs text-muted-foreground">
      Kräver abonnemang.{' '}
      <a href="/settings/billing" className="underline underline-offset-2">
        Uppgradera
      </a>
    </span>
  ) : null

  if (connections.length === 1) {
    const conn = connections[0]
    const needsReconnect = conn.status !== 'active'
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={isBusy || !hasBankSync}
          title={gateTitle}
          onClick={() => runFor(conn)}
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>{needsReconnect ? t('bank_reconnect') : syncLabel}</span>
        </Button>
        {upsellNote}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={isBusy || !hasBankSync}
          title={gateTitle}
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>{syncLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {connections.map((conn) => (
          <DropdownMenuItem
            key={conn.id}
            disabled={isBusy}
            onSelect={() => runFor(conn)}
          >
            {conn.status === 'active'
              ? conn.bank_name
              : `${conn.bank_name} · ${t('bank_reconnect')}`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    {upsellNote}
    </div>
  )
}
