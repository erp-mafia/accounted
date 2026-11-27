'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
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
import { ChevronRightIcon, EllipsisHorizontalIcon, SpinnerIcon } from '@/components/icons'
import { BANK_FILE_IMPORT_PATH, switchDeepLink } from '@/lib/bank-feed/switch-link'
import { getConnectionUiState, offersAccountChoice, type SunsetPath, type SyncPauseReason } from '../lib/connection-state'
import { describeClaimedElsewhere, describeMirrorCards, partitionAccounts } from '../lib/claimed-accounts'
import type { BankConnection } from '@/types'

/** The way on from the old provider, as the row's button and its menu entry name it. */
const WAY_ON_LABEL: Record<SunsetPath, string> = {
  switch: 'Byt till ny koppling',
  import: 'Importera kontoutdrag',
}

interface BankConnectionStatusProps {
  connection: BankConnection
  onSync: (connectionId: string) => void
  onDisconnect: (connectionId: string) => void
  onReconnect?: (connection: BankConnection, psuType?: 'personal' | 'business') => void
  onManageAccounts?: (connectionId: string) => void
  /** Start the bank flow over for an attempt that never came back from the
   *  bank (abandoned 'pending' row). The connect route sweeps that row. */
  onRetry?: (connection: BankConnection) => void
  isSyncing?: boolean
  /** The Enable Banking feed has ended for this row (lib/connection-state.ts
   *  SunsetPath): 'switch' offers the switch to the new connection, 'import'
   *  the bank file import. Null while the feed runs. */
  sunset?: SunsetPath | null
  /** The company's syncs are paused (lib/connection-state.ts SyncPauseReason):
   *  no bank_sync capability, so the row offers the way back instead of a
   *  Synka the server would refuse. Null while syncs run. */
  paused?: SyncPauseReason | null
  /** Enable Banking takes no renewal while the switch campaign is on
   *  (lib/connection-state.ts renewal_closed): a consent that has run out or
   *  is about to offers this way on (SunsetPath) instead of a renewal the
   *  server would refuse. Null while renewals are open. */
  renewalClosed?: SunsetPath | null
}

/**
 * One bank connection as a flat hairline row (Fönster settings language):
 * identity + state on one line, exactly ONE primary action decided by the
 * derived UI state, every secondary action behind a "..." menu, and the
 * details (accounts, IBAN, balances, initial backfill) behind a collapsed
 * disclosure. When the disclosure line says an account does not sync, the
 * way to change that ("Välj konton", also in the menu) sits beside it. The
 * page-level attention sentence lives in the panel, not here (design
 * convention 6: one .attn per page).
 */
export function BankConnectionStatus({
  connection,
  onSync,
  onDisconnect,
  onReconnect,
  onManageAccounts,
  onRetry,
  isSyncing = false,
  sunset = null,
  paused = null,
  renewalClosed = null,
}: BankConnectionStatusProps) {
  // Sync stays live for a read-only member; connecting, renewing, account choice and removal do not.
  const { canWrite, lockedTitle } = useViewerLock()
  const [now] = useState(() => Date.now())
  const [detailsOpen, setDetailsOpen] = useState(false)

  const uiState = getConnectionUiState({ ...connection, sunset, paused }, now)

  // Parse accounts from connection
  const accounts = (connection.accounts_data as Array<{
    uid: string
    iban?: string
    bban?: string
    name?: string
    currency: string
    balance?: number
    balance_updated_at?: string
    enabled?: boolean
    claimed_by_company_id?: string
    claimed_by_company_name?: string
  }>) || []
  // The same split as the account picker (crm#1097). Accounts another of the
  // user's companies books (one SEB consent covers every company the signer
  // represents) and a card account that only mirrors the main account are
  // not this company's accounts: they are left out of the list and the
  // count, and each kind is summarised in one line.
  const { own: ownAccounts, claimedElsewhere, mirrorCards } = partitionAccounts(accounts)
  const enabledCount = ownAccounts.filter((a) => a.enabled !== false).length

  function formatBalanceAge(updatedAt: string): string {
    const hoursAgo = Math.floor((now - new Date(updatedAt).getTime()) / (1000 * 60 * 60))
    if (hoursAgo < 1) return 'Nyss uppdaterat'
    if (hoursAgo < 24) return `${hoursAgo}h sedan`
    const daysAgo = Math.floor(hoursAgo / 24)
    return `${daysAgo}d sedan`
  }

  // An attempt the bank never answered: the user timed out or closed the
  // bank's page, so no callback ran and the row stayed 'pending'. It is not
  // a connection and never was, so it gets no spinner and no "Åtgärd krävs"
  // badge: one sentence, start over or remove.
  if (uiState === 'abandoned') {
    return (
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b-hairline px-1 py-3">
        <span className="text-sm font-medium">{connection.bank_name}</span>
        <span className="text-xs text-muted-foreground">Anslutningen slutfördes inte hos banken</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {onRetry && (
            <Button disabled={!canWrite} title={lockedTitle} onClick={() => onRetry(connection)}>
              Försök igen
            </Button>
          )}
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!canWrite}
            title={lockedTitle}
            onClick={() => onDisconnect(connection.id)}
          >
            Ta bort
          </Button>
        </span>
      </div>
    )
  }

  // In-flight authorization: the row exists but the user is still at the
  // bank. Render it as a quiet spinner row instead of hiding it (the connect
  // button lock alone made this state invisible).
  if (uiState === 'pending') {
    return (
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b-hairline px-1 py-3">
        <span className="text-sm font-medium">{connection.bank_name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
          Väntar på banken…
        </span>
        <span className="ml-auto shrink-0">
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!canWrite}
            title={lockedTitle}
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
      case 'sunset':
        return { kind: 'badge', label: 'Upphört', variant: 'destructive' }
      case 'paused':
        return { kind: 'badge', label: 'Pausad', variant: 'warning' }
      case 'pending_selection':
        return { kind: 'badge', label: 'Välj konton', variant: 'warning' }
      case 'error':
        return { kind: 'badge', label: 'Fel', variant: 'destructive' }
      case 'needs_configuration':
        return { kind: 'badge', label: 'Synkningen har stannat', variant: 'warning' }
      case 'expired':
        return { kind: 'badge', label: 'Utgånget samtycke', variant: 'warning' }
      case 'expiring':
        return { kind: 'badge', label: 'Går ut snart', variant: 'warning' }
      default:
        return { kind: 'text', label: 'Aktiv' }
    }
  })()

  const isExpired = uiState === 'expired'
  const isSunset = uiState === 'sunset'
  const isPaused = uiState === 'paused'
  // The old provider is gone, or the company's syncs are paused: nothing to
  // sync and no consent worth renewing (the server refuses both while paused).
  // While the switch campaign is on the server refuses every renewal, so none
  // is offered.
  const canReconnect = !!onReconnect && !isSunset && !isPaused && !renewalClosed
  const canSync = (connection.status === 'active' || connection.status === 'error') && !isSunset && !isPaused

  // The way on from the old provider. The switch is done on Kopplingar (the
  // deep link opens Koppla banken in switch mode for exactly this row); where
  // the new provider does not reach the bank, bank statements come in as files.
  function renderWayOn(path: SunsetPath | null) {
    const way: SunsetPath = path === 'import' ? 'import' : 'switch'
    return (
      <Button asChild>
        <Link href={way === 'import' ? BANK_FILE_IMPORT_PATH : switchDeepLink(connection.id)}>{WAY_ON_LABEL[way]}</Link>
      </Button>
    )
  }

  // Exactly ONE primary action per state; everything else goes in the menu.
  function renderPrimaryAction() {
    switch (uiState) {
      case 'sunset':
        return renderWayOn(sunset)
      case 'paused':
        // Hosted, the subscription brings the feed back; self-hosted, the
        // connector key, which the page's sentence names.
        return paused === 'subscription' ? (
          <Button asChild>
            <Link href="/settings/billing">Uppgradera</Link>
          </Button>
        ) : null
      case 'pending_selection':
      case 'needs_configuration':
        return onManageAccounts ? (
          <Button disabled={!canWrite} title={lockedTitle} onClick={() => onManageAccounts(connection.id)}>
            Välj konton
          </Button>
        ) : null
      case 'error':
        return (
          <Button onClick={() => onSync(connection.id)} loading={isSyncing}>
            Försök igen
          </Button>
        )
      case 'expired':
      case 'expiring':
        // Renewals closed: the consent cannot be renewed here, so the row
        // offers the way on the server's refusal names.
        if (renewalClosed) return renderWayOn(renewalClosed)
        // No psu override: the server reuses the stored psu_type, so renewal
        // is one click. Switching account type lives in the menu.
        return canReconnect ? (
          <Button disabled={!canWrite} title={lockedTitle} onClick={() => onReconnect!(connection)}>
            Förnya samtycke
          </Button>
        ) : null
      case 'stale':
      case 'never_synced':
        return (
          <Button onClick={() => onSync(connection.id)} loading={isSyncing}>
            Synka nu
          </Button>
        )
      default:
        // Healthy active row: no primary needed; sync stays reachable as a
        // quiet ghost button.
        return (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onSync(connection.id)}
            loading={isSyncing}
          >
            Synka
          </Button>
        )
    }
  }

  const primaryIsSync = uiState === 'stale' || uiState === 'never_synced' || uiState === 'active' || uiState === 'error'
  const primaryIsReconnect = uiState === 'expired' || uiState === 'expiring'
  // While renewals are closed the switch takes the renewal's place: the
  // primary action where the consent has run out or is about to, a menu
  // entry on every other row (an import row already has the file import there).
  const menuOffersSwitch = renewalClosed === 'switch' && !isSunset && !primaryIsReconnect

  return (
    <div className="border-b-hairline px-1 py-3">
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
            {ownAccounts.length > 0
              ? `${ownAccounts.length} ${ownAccounts.length === 1 ? 'konto tillgängligt' : 'konton tillgängliga'}: inga transaktioner synkas ännu`
              : claimedElsewhere.length > 0
                ? 'Alla konton i kopplingen synkas redan i andra bolag'
                : 'Inga konton i kopplingen: inga transaktioner synkas ännu'}
          </span>
        ) : (
          <>
            {connection.last_synced_at && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Synkad {formatDate(connection.last_synced_at)}
              </span>
            )}
            {connection.consent_expires && !isExpired && !isSunset && (
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
                <EllipsisHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {uiState === 'pending_selection' ? (
                // Named for what it does. "Avbryt" read as "close this menu"
                // to a person looking for a way to remove a connection they
                // could not finish, so the way out went unfound.
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={!canWrite}
                  onSelect={() => onDisconnect(connection.id)}
                >
                  Ta bort anslutningen
                </DropdownMenuItem>
              ) : (
                <>
                  {onManageAccounts && uiState !== 'needs_configuration' && !isSunset && (
                    <DropdownMenuItem disabled={!canWrite} onSelect={() => onManageAccounts(connection.id)}>
                      Välj konton
                    </DropdownMenuItem>
                  )}
                  {canSync && !primaryIsSync && (
                    <DropdownMenuItem onSelect={() => onSync(connection.id)}>
                      Synka
                    </DropdownMenuItem>
                  )}
                  {canReconnect && !primaryIsReconnect && (
                    <DropdownMenuItem disabled={!canWrite} onSelect={() => onReconnect!(connection)}>
                      Förnya samtycke
                    </DropdownMenuItem>
                  )}
                  {menuOffersSwitch && (
                    <DropdownMenuItem asChild>
                      <Link href={switchDeepLink(connection.id)}>{WAY_ON_LABEL.switch}</Link>
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
                      <DropdownMenuItem disabled={!canWrite} onSelect={() => onReconnect!(connection, 'business')}>
                        Företagskonto
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={!canWrite} onSelect={() => onReconnect!(connection, 'personal')}>
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
                    disabled={!canWrite}
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

      {/* The feed has ended: one quiet line on what the row offers now. The
          page-level .attn owns the ochre sentence (the worst row only), so
          every other sunset row still says where to go. */}
      {isSunset && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {sunset === 'import'
            ? 'Den gamla leverantören har stängts och banken nås inte än genom den nya. Importera kontoutdrag som fil (SIE eller CSV) tills vidare; historiken behålls.'
            : 'Den gamla leverantören har stängts. Bytet signeras med BankID och tar cirka två minuter; historiken behålls.'}
        </p>
      )}

      {/* Error detail: the page-level .attn owns the ochre sentence; the
          row's own message stays quiet. */}
      {(uiState === 'error' || uiState === 'needs_configuration') && connection.error_message && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {connection.error_message}
        </p>
      )}

      {/* Details behind a collapsed disclosure: accounts, IBAN, balances,
          initial backfill. Expired rows never show balances (stale numbers
          would read as current). */}
      {accounts.length > 0 && uiState !== 'pending_selection' && (
        <div className="mt-1">
          <div className="flex flex-wrap items-center gap-x-3">
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              className="flex min-h-9 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ChevronRightIcon
                className={cn('h-3.5 w-3.5 transition-transform duration-150', detailsOpen && 'rotate-90')}
              />
              <span className="tabular-nums">
                {enabledCount} av {ownAccounts.length} {ownAccounts.length === 1 ? 'konto' : 'konton'} synkas
              </span>
            </button>
            {/* Where the row says an account of this company does not sync,
                the way to switch it on sits beside it, under the name the
                menu entry and the picker use (crm#1097: the picker was only
                in the "..." menu, and was not found there). Never for a card
                account or another company's account: neither is a choice
                here (offersAccountChoice). */}
            {onManageAccounts && offersAccountChoice(connection, accounts, now) && (
              <Button
                variant="outline"
                aria-label={`Välj konton för ${connection.bank_name}`}
                disabled={!canWrite}
                title={lockedTitle}
                onClick={() => onManageAccounts(connection.id)}
              >
                Välj konton
              </Button>
            )}
          </div>

          {detailsOpen && (
            <div className="ml-3 border-l-hairline pl-4">
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
                          Bankens API returnerade kortare period än begärt: importera äldre bankhistorik som bankfil (Importera, Bankfil)
                        </Badge>
                      )}
                    </div>
                  )
                })()}

              {ownAccounts.map((account) => {
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
                      <Badge variant="outline" className="text-xs text-muted-foreground">
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
                          <span className="text-xs text-muted-foreground">
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
              {/* A card account that only mirrors the main account is never
                  an account of its own (lib/bank-sync/mirror-card-account.ts)
                  and can never be switched on. A "Synkas ej" row with a
                  balance read as something to switch on or remove, and the
                  way to do that could not be found because there is none
                  (crm#1097). One muted line says what it is, in the picker's
                  words, and offers nothing. */}
              {mirrorCards.length > 0 && (
                <div className="py-2 text-xs text-muted-foreground">
                  {describeMirrorCards(mirrorCards)}
                </div>
              )}
              {/* Sibling companies' accounts carried by this consent: one
                  muted line, never rows, no action. Moving one here is done
                  in the account picker ("Välj konton"), where it is a
                  deliberate tick inside a disclosure. */}
              {claimedElsewhere.length > 0 && (
                <div className="py-2 text-xs text-muted-foreground tabular-nums" data-ph-mask="">
                  {describeClaimedElsewhere(claimedElsewhere)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
