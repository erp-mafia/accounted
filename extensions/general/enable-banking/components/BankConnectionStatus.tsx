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
import { cn, formatDate } from '@/lib/utils'
import { getDaysUntilExpiry, isConsentExpiringSoon } from '../lib/api-client'
import Link from 'next/link'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { BankConnection } from '@/types'

interface BankConnectionStatusProps {
  connection: BankConnection
  onSync: (connectionId: string) => void
  onDisconnect: (connectionId: string) => void
  onReconnect?: (connection: BankConnection, psuType?: 'personal' | 'business') => void
  onManageAccounts?: (connectionId: string) => void
  isSyncing?: boolean
}

/**
 * One bank connection as a flat hairline row (Fönster settings language):
 * bank name + state on one line with quiet actions on the right, live
 * warnings as compact warning-tone lines underneath, and the accounts as an
 * indented sub-list. Normal state (Aktiv) is muted text; a Badge appears
 * only when the row deviates (expired/error/pending).
 */
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

  type StatusEntry =
    | { kind: 'text'; label: string }
    | { kind: 'badge'; label: string; variant: 'warning' | 'destructive' | 'secondary' }

  const statusConfig: Record<string, StatusEntry> = {
    active: { kind: 'text', label: 'Aktiv' },
    pending: { kind: 'badge', label: 'Väntar', variant: 'warning' },
    expired: { kind: 'badge', label: 'Utgånget samtycke', variant: 'warning' },
    error: { kind: 'badge', label: 'Fel', variant: 'destructive' },
    revoked: { kind: 'badge', label: 'Bortkopplad', variant: 'secondary' },
  }

  const status = statusConfig[connection.status] || statusConfig.error

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
    <div className="border-b border-border px-1 py-3">
      {/* Main line: identity + state left, quiet actions right */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{connection.bank_name}</span>
        {status.kind === 'badge' ? (
          <Badge variant={status.variant}>{status.label}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{status.label}</span>
        )}
        {connection.last_synced_at && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Synkad {formatDate(connection.last_synced_at)}
          </span>
        )}
        {/* Consent renewal date as quiet metadata; the expired state already
            carries its own warning line below. */}
        {connection.consent_expires && !isConnectionExpired && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Samtycke till {formatDate(connection.consent_expires)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
          {(isConnectionExpired || isConnectionError) && onReconnect && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1 text-muted-foreground hover:text-foreground">
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
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onSync(connection.id)}
              disabled={isSyncing}
            >
              {isSyncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Försök igen
            </Button>
          )}
          {connection.status === 'active' && (
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onSync(connection.id)}
              disabled={isSyncing}
            >
              {isSyncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Synka
            </Button>
          )}
          {onManageAccounts && (
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onManageAccounts(connection.id)}
            >
              Välj konton
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDisconnect(connection.id)}
          >
            Koppla från
          </Button>
        </span>
      </div>

      {/* Error message: live warning, compact warning-tone lines */}
      {isConnectionError && errorMessage && (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-attn">{errorMessage}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Du kan också{' '}
            <Link href="/import?mode=bank" className="underline underline-offset-2 hover:text-foreground">
              importera transaktioner via bankfil
            </Link>
          </p>
        </>
      )}

      {/* Expired consent notice */}
      {isConnectionExpired && (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-attn">
            PSD2-samtycket har löpt ut. Förnya anslutningen för att återuppta synkroniseringen.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Medan du väntar kan du{' '}
            <Link href="/import?mode=bank" className="underline underline-offset-2 hover:text-foreground">
              importera transaktioner via bankfil
            </Link>
          </p>
        </>
      )}

      {/* Consent expiry warning (for active connections) */}
      {!isConnectionExpired && isExpiring && daysUntilExpiry !== null && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-attn">
          Samtycket går ut om {daysUntilExpiry} {daysUntilExpiry === 1 ? 'dag' : 'dagar'}.
          Förnya genom att ansluta igen.
        </p>
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
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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

      {/* Accounts: indented flat sub-list instead of boxed rows */}
      {accounts.length > 0 && (
        <div className="ml-3 mt-3 border-l border-border pl-4">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Konton
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {enabledCount} av {accounts.length} synkas
            </p>
          </div>
          {accounts.map((account) => {
            const isDisabled = account.enabled === false
            return (
              <div
                key={account.uid}
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-1 py-2',
                  isDisabled && 'opacity-60',
                )}
              >
                <span className="text-sm">
                  {account.name || account.iban || 'Okänt konto'}
                </span>
                {isDisabled && (
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Synkas ej
                  </Badge>
                )}
                {account.iban && (
                  <span className="text-xs text-muted-foreground">
                    {account.iban.replace(/(.{4})/g, '$1 ').trim()}
                  </span>
                )}
                {account.balance !== undefined && (
                  <span className="ml-auto inline-flex shrink-0 items-baseline gap-2">
                    {account.balance_updated_at && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatBalanceAge(account.balance_updated_at)}
                      </span>
                    )}
                    <span className="text-sm tabular-nums">
                      {new Intl.NumberFormat('sv-SE', {
                        style: 'currency',
                        currency: account.currency,
                      }).format(account.balance)}
                    </span>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
