'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'

interface ActiveConnection {
  id: string
  bank_name: string
}

/**
 * On-demand "Sync now" button beside BankSyncStatusChip. Reuses the
 * per-connection sync endpoint that BankingSettingsPanel already calls;
 * if the user has multiple active connections, a dropdown lets them
 * pick which one to sync.
 */
export default function BankSyncNowButton() {
  const t = useTranslations('transactions')
  const { toast } = useToast()
  const router = useRouter()
  const { company } = useCompany()
  const [connections, setConnections] = useState<ActiveConnection[] | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('id, bank_name')
      .eq('company_id', company.id)
      .eq('status', 'active')
      .then(({ data }) => {
        if (!cancelled) setConnections(data ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  if (!connections || connections.length === 0) return null

  async function syncConnection(connectionId: string) {
    setSyncingId(connectionId)
    try {
      const res = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })
      const data = await res.json()
      if (!res.ok) {
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
      setSyncingId(null)
    }
  }

  const isSyncing = syncingId !== null
  const label = isSyncing ? t('bank_sync_button_syncing') : t('bank_sync_button_now')

  if (connections.length === 1) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        disabled={isSyncing}
        onClick={() => syncConnection(connections[0].id)}
      >
        {isSyncing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        <span>{label}</span>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={isSyncing}
        >
          {isSyncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {connections.map((conn) => (
          <DropdownMenuItem
            key={conn.id}
            disabled={isSyncing}
            onSelect={() => syncConnection(conn.id)}
          >
            {conn.bank_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
