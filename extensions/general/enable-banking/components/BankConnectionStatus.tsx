'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, formatDate } from '@/lib/utils'
import { ChevronRight, Loader2, MoreHorizontal } from 'lucide-react'
import { getConnectionUiState } from '../lib/connection-state'
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
 * identity + state on one line, exactly ONE primary action decided by the
 * derived UI state, every secondary action behind a "..." menu, and the
 * details (accounts, IBAN, balances, initial backfill) behind a collapsed
 * disclosure. The page-level attention sentence lives in the panel, not
 * here (design convention 6: one .attn per page).
 */
export function BankConnectionStatus({
  connection,
  onSync,
  onDisconnect,
  onReconnect,
  onManageAccounts,
  isSyncing = false,
}: BankConnectionStatusProps) {
  const [now] = useState(() => Date.now())
  const [detailsOpen, setDetailsOpen] = useState(false)

  const uiState = getConnectionUiState(connection, now)

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

  function formatBalanceAge(updatedAt: string): string {
    const hoursAgo = Math.floor((now - new Date(updatedAt).getTime()) / (1000 * 60 * 60))
    if (hoursAgo < 1) return 'Nyss uppdaterat'
    if (hoursAgo < 24) return `${hoursAgo}h sedan`
    const daysAgo = Math.floor(hoursAgo / 24)
    return `${daysAgo}d sedan`
  }

  // In-flight authorization: the row exists but the user is still at the
  // bank. Render it as a quiet spinner row instead of hiding it (the connect
  // button lock alone made this state invisible).
  if (uiState === 'pending') {
    return (
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-1 py-3">
        <span className="text-sm font-medium">{connection.bank_name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Väntar på banken…
        </span>
        <span className="ml-auto shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onDisconnect(connection.id)}
          >
            Avbryt
          </Button>
        </span>
      </div>
    )
  }

  // Status display: muted text for the normal state, Badge only when the row
  // deviates (design convention 5).
  type StatusEntry =
    | { kind: 'text'; label: string }
    | { kind: 'badge'; label: string; variant: 'warning' | 'destructive' | 'secondary' }
  const statusDisplay: StatusEntry = (() => {
    switch (uiState) {
      case 'pending_selection':
        return { kind: 'badge', label: 'Välj konton', variant: 'warning' }
      case 'error':
        return { kind: 'badge', label: 'Fel', variant: 'destructive' }
      case 'expired':
        return { kind: 'badge', label: 'Utgånget samtycke', variant: 'warning' }
      case 'expiring':
        return { kind: 'badge', label: 'Går ut snart', variant: 'warning' }
      default:
        return { kind: 'text', label: 'Aktiv' }
    }
  })()

  const isExpired = uiState === 'expired'
  const canReconnect = !!onReconnect
  const canSync = connection.status === 'active' || connection.status === 'error'

  // Exactly ONE primary action per state; everything else goes in the menu.
  function renderPrimaryAction() {
    switch (uiState) {
      case 'pending_selection':
        return onManageAccounts ? (
          <Button size="sm" onClick={() => onManageAccounts(connection.id)}>
            Välj konton
          </Button>
        ) : null
      case 'error':
        return (
          <Button size="sm" onClick={() => onSync(connection.id)} disabled={isSyncing}>
            {isSyncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Försök igen
          </Button>
        )
      case 'expired':
      case 'expiring':
        // No psu override: the server reuses the stored psu_type, so renewal
        // is one click. Switching account type lives in the menu.
        return canReconnect ? (
          <Button size="sm" onClick={() => onReconnect!(connection)}>
            Förnya samtycke
          </Button>
        ) : null
      case 'stale':
      case 'never_synced':
        return (
          <Button size="sm" onClick={() => onSync(connection.id)} disabled={isSyncing}>
            {isSyncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Synka nu
          </Button>
        )
      default:
        // Healthy active row: no primary needed; sync stays reachable as a
        // quiet ghost button.
        return (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onSync(connection.id)}
            disabled={isSyncing}
          >
            {isSyncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Synka
          </Button>
        )
    }
  }

  const primaryIsSync = uiState === 'stale' || uiState === 'never_synced' || uiState === 'active' || uiState === 'error'
  const primaryIsReconnect = uiState === 'expired' || uiState === 'expiring'

  return (
    <div className="border-b border-border px-1 py-3">
      {/* Main line: identity + state left, one primary action + menu right */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{connection.bank_name}</span>
        {statusDisplay.kind === 'badge' ? (
          <Badge variant={statusDisplay.variant}>{statusDisplay.label}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">{statusDisplay.label}</span>
        )}
        {uiState === 'pending_selection' ? (
          <span className="text-xs text-muted-foreground">
            {accounts.length} konton tillgängliga: inga transaktioner synkas ännu
          </span>
        ) : (
          <>
            {connection.last_synced_at && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Synkad {formatDate(connection.last_synced_at)}
              </span>
            )}
            {connection.consent_expires && !isExpired && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Samtycke till {formatDate(connection.consent_expires)}
              </span>
            )}
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {renderPrimaryAction()}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Fler åtgärder för ${connection.bank_name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {uiState === 'pending_selection' ? (
                <DropdownMenuItem onSelect={() => onDisconnect(connection.id)}>
                  Avbryt
                </DropdownMenuItem>
              ) : (
                <>
                  {onManageAccounts && (
                    <DropdownMenuItem onSelect={() => onManageAccounts(connection.id)}>
                      Välj konton
                    </DropdownMenuItem>
                  )}
                  {canSync && !primaryIsSync && (
                    <DropdownMenuItem onSelect={() => onSync(connection.id)}>
                      Synka
                    </DropdownMenuItem>
                  )}
                  {canReconnect && !primaryIsReconnect && (
                    <DropdownMenuItem onSelect={() => onReconnect!(connection)}>
                      Förnya samtycke
                    </DropdownMenuItem>
                  )}
                  {canReconnect && (
                    <>
                      <DropdownMenuSeparator />
                      {/* Some banks (notably Handelsbanken) only sign with one
                          account type: keep the explicit choice reachable even
                          though the primary renew reuses the stored type. */}
                      <DropdownMenuLabel className="text-xs font-normal normal-case tracking-normal">
                        Förnya och logga in som
                      </DropdownMenuLabel>
                      <DropdownMenuItem onSelect={() => onReconnect!(connection, 'business')}>
                        Företagskonto
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onReconnect!(connection, 'personal')}>
                        Privatkonto
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/import?mode=bank">Importera bankfil</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => onDisconnect(connection.id)}
                  >
                    Koppla från
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {/* Error detail: the page-level .attn owns the ochre sentence; the
          row's own message stays quiet. */}
      {uiState === 'error' && connection.error_message && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          {connection.error_message}
        </p>
      )}

      {/* Details behind a collapsed disclosure: accounts, IBAN, balances,
          initial backfill. Expired rows never show balances (stale numbers
          would read as current). */}
      {accounts.length > 0 && uiState !== 'pending_selection' && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="flex min-h-9 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform duration-150', detailsOpen && 'rotate-90')}
            />
            <span className="tabular-nums">
              {enabledCount} av {accounts.length} konton synkas
            </span>
          </button>

          {detailsOpen && (
            <div className="ml-3 border-l border-border pl-4">
              {/* Initial backfill summary: what the bank actually returned vs
                  what we asked for. Diagnostics, so it lives in the details. */}
              {!isExpired &&
                connection.initial_sync_completed_at &&
                connection.initial_sync_requested_from &&
                (() => {
                  const requested = connection.initial_sync_requested_from
                  const min = connection.initial_sync_returned_min_date
                  const max = connection.initial_sync_returned_max_date
                  // Truncation = bank returned less history than requested.
                  // 7-day grace for off-by-one + weekend posting differences.
                  let truncated = false
                  if (min && requested) {
                    const requestedTime = new Date(requested).getTime()
                    const minTime = new Date(min).getTime()
                    truncated = minTime - requestedTime > 7 * 24 * 60 * 60 * 1000
                  }
                  return (
                    <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
                      <span>
                        Initial historik:{' '}
                        <span className="tabular-nums">
                          {min ? formatDate(min) : '-'} → {max ? formatDate(max) : '-'}
                        </span>{' '}
                        (begärde <span className="tabular-nums">{formatDate(requested)}</span>)
                      </span>
                      {truncated && (
                        <Badge variant="outline">
                          Bankens API returnerade kortare period än begärt: använd SIE-import för äldre data
                        </Badge>
                      )}
                    </div>
                  )
                })()}

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
                    {!isExpired && account.balance !== undefined && (
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
      )}
    </div>
  )
}
