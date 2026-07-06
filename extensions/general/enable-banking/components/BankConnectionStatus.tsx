'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatDate } from '@/lib/utils'
import { getDaysUntilExpiry, isConsentExpiringSoon } from '../lib/api-client'
import Link from 'next/link'
import {
  CreditCard,
  AlertTriangle,
  RefreshCw,
  Settings,
  Trash2,
  Loader2,
  CheckCircle,
  ChevronDown,
  XCircle,
  Upload,
} from 'lucide-react'
import type { BankConnection } from '@/types'

interface BankConnectionStatusProps {
  connection: BankConnection
  onSync: (connectionId: string) => void
  onDisconnect: (connectionId: string) => void
  onReconnect?: (connection: BankConnection, psuType?: 'personal' | 'business') => void
  onManageAccounts?: (connectionId: string) => void
  isSyncing?: boolean
}

export function BankConnectionStatus({
  connection,
  onSync,
  onDisconnect,
  onReconnect,
  onManageAccounts,
  isSyncing = false,
}: BankConnectionStatusProps) {
  const daysUntilExpiry = getDaysUntilExpiry(connection.consent_expires)
  const isExpiring = isConsentExpiringSoon(connection.consent_expires)

  type StatusEntry = {
    icon: typeof CheckCircle
    color: string
    label: string
    variant: 'success' | 'warning' | 'destructive' | 'secondary'
  }

  const statusConfig: Record<string, StatusEntry> = {
    active: {
      icon: CheckCircle,
      color: 'text-success',
      label: 'Aktiv',
      variant: 'success',
    },
    pending: {
      icon: Loader2,
      color: 'text-warning',
      label: 'Väntar',
      variant: 'warning',
    },
    expired: {
      icon: AlertTriangle,
      color: 'text-warning',
      label: 'Utgånget samtycke',
      variant: 'warning',
    },
    error: {
      icon: XCircle,
      color: 'text-destructive',
      label: 'Fel',
      variant: 'destructive',
    },
    revoked: {
      icon: XCircle,
      color: 'text-gray-600',
      label: 'Bortkopplad',
      variant: 'secondary',
    },
  }

  const status = statusConfig[connection.status] || statusConfig.error
  const StatusIcon = status.icon

  // Parse accounts from connection
  const accounts = (connection.accounts_data as Array<{
    uid: string
    iban?: string
    name?: string
    currency: string
    balance?: number
    balance_updated_at?: string
    enabled?: boolean
  }>) || []

  const enabledCount = accounts.filter((a) => a.enabled !== false).length

  const [now] = useState(() => Date.now())

  function formatBalanceAge(updatedAt: string): string {
    const hoursAgo = Math.floor((now - new Date(updatedAt).getTime()) / (1000 * 60 * 60))
    if (hoursAgo < 1) return 'Nyss uppdaterat'
    if (hoursAgo < 24) return `${hoursAgo}h sedan`
    const daysAgo = Math.floor(hoursAgo / 24)
    return `${daysAgo}d sedan`
  }

  const isConnectionExpired = connection.status === 'expired'
  const isConnectionError = connection.status === 'error'
  const errorMessage = connection.error_message ?? ''

  return (
    <div className="border rounded-lg p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <CreditCard className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-medium">{connection.bank_name}</p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusIcon className={`h-3 w-3 ${status.color}`} />
              <span>{status.label}</span>
              {connection.last_synced_at && (
                <>
                  <span>-</span>
                  <span>Synkad {formatDate(connection.last_synced_at)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(isConnectionExpired || isConnectionError) && onReconnect && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Förnya anslutning
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Let the user pick the account type for the bank login. The
                    server reuses the last-used type by default, but some banks
                    (notably Handelsbanken) only sign with one of them: e.g. an
                    AB owner who signs with a personal Mobile BankID needs
                    "Privatkonto", not the company default "Företagskonto". */}
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Logga in på banken som
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => onReconnect(connection, 'business')}>
                  Företagskonto
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onReconnect(connection, 'personal')}>
                  Privatkonto
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {isConnectionError && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSync(connection.id)}
              disabled={isSyncing}
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Försök igen
                </>
              )}
            </Button>
          )}
          {connection.status === 'active' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSync(connection.id)}
              disabled={isSyncing}
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          )}
          {onManageAccounts && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onManageAccounts(connection.id)}
              title="Hantera konton"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDisconnect(connection.id)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Error message */}
      {isConnectionError && errorMessage && (
        <>
          <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg">
            <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />
            <span className="text-sm text-destructive">
              {errorMessage}
            </span>
          </div>
          <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border border-border">
            <Upload className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm text-muted-foreground">
              Du kan också <Link href="/import?mode=bank" className="underline hover:text-foreground">importera transaktioner via bankfil</Link>
            </span>
          </div>
        </>
      )}

      {/* Expired consent notice */}
      {isConnectionExpired && (
        <>
          <div className="flex items-center gap-2 p-3 bg-warning/10 rounded-lg">
            <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0" />
            <span className="text-sm">
              PSD2-samtycket har löpt ut. Förnya anslutningen för att återuppta synkroniseringen.
            </span>
          </div>
          <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border border-border">
            <Upload className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm text-muted-foreground">
              Medan du väntar kan du <Link href="/import?mode=bank" className="underline hover:text-foreground">importera transaktioner via bankfil</Link>
            </span>
          </div>
        </>
      )}

      {/* Consent expiry warning (for active connections) */}
      {!isConnectionExpired && isExpiring && daysUntilExpiry !== null && (
        <div className="flex items-center gap-2 p-3 bg-warning/10 rounded-lg">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span className="text-sm">
            Samtycket går ut om {daysUntilExpiry} {daysUntilExpiry === 1 ? 'dag' : 'dagar'}.
            Förnya genom att ansluta igen.
          </span>
        </div>
      )}

      {/* Initial backfill summary: shows what the bank actually returned vs what we asked for. */}
      {connection.initial_sync_completed_at && connection.initial_sync_requested_from && (() => {
        const requested = connection.initial_sync_requested_from
        const min = connection.initial_sync_returned_min_date
        const max = connection.initial_sync_returned_max_date
        // Truncation = bank returned less history than requested. 7-day grace
        // for off-by-one + weekend posting differences.
        let truncated = false
        if (min && requested) {
          const requestedTime = new Date(requested).getTime()
          const minTime = new Date(min).getTime()
          truncated = (minTime - requestedTime) > 7 * 24 * 60 * 60 * 1000
        }
        return (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              Initial historik:{' '}
              <span className="tabular-nums">
                {min ? formatDate(min) : '-'} → {max ? formatDate(max) : '-'}
              </span>
              {' '}(begärde <span className="tabular-nums">{formatDate(requested)}</span>)
            </span>
            {truncated && (
              <Badge variant="outline">
                Bankens API returnerade kortare period än begärt: använd SIE-import för äldre data
              </Badge>
            )}
          </div>
        )
      })()}

      {/* Accounts list */}
      {accounts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Konton</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {enabledCount} av {accounts.length} synkas
            </p>
          </div>
          <div className="space-y-2">
            {accounts.map((account) => {
              const isDisabled = account.enabled === false
              return (
                <div
                  key={account.uid}
                  className={`flex items-center justify-between p-3 rounded-lg ${isDisabled ? 'bg-muted/20 opacity-60' : 'bg-muted/50'}`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        {account.name || account.iban || 'Okänt konto'}
                      </p>
                      {isDisabled && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
                          Synkas ej
                        </span>
                      )}
                    </div>
                    {account.iban && (
                      <p className="text-xs text-muted-foreground">
                        {account.iban.replace(/(.{4})/g, '$1 ').trim()}
                      </p>
                    )}
                  </div>
                  {account.balance !== undefined && (
                    <div className="text-right">
                      <p className="text-sm font-medium tabular-nums">
                        {new Intl.NumberFormat('sv-SE', {
                          style: 'currency',
                          currency: account.currency,
                        }).format(account.balance)}
                      </p>
                      {account.balance_updated_at && (
                        <p className="text-[10px] text-muted-foreground">
                          {formatBalanceAge(account.balance_updated_at)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
