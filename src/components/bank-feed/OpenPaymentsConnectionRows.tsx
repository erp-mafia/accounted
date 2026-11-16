'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BuildingLibraryIcon, EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { bankLogoUrl } from '@/lib/cash-accounts/bank-logos'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { cn } from '@/lib/utils'
import { BankAccountLedgerRows } from './BankAccountLedgerRows'
import { connectionRowState } from './connection-kind'
import { deleteOpenPaymentsConnection, OpenPaymentsClientError } from './open-payments-client'
import type { BankConnectFlow } from './use-bank-connect-flow'
import type { BankConnectionRow } from './use-open-payments-connections'

/** 28px tile holding a bank's mark, so every connection row starts the same way. */
export function BankTile({ bankName }: { bankName: string | null }) {
  const src = bankLogoUrl(bankName)
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden bg-white">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-5 w-5 object-contain" />
      ) : (
        <BuildingLibraryIcon className="h-4 w-4 text-foreground" aria-hidden="true" />
      )}
    </span>
  )
}

interface OpenPaymentsConnectionRowProps {
  connection: BankConnectionRow
  flow: BankConnectFlow
  /** Called after a disconnect went through. */
  onChanged: () => void
  /** Whether Förnya is offered: a new consent, which the company may not start everywhere. Default true. */
  canRenew?: boolean
}

/**
 * One Open Payments connection as a flat hairline row: the bank, where it
 * stands (muted when fine, the one ochre sentence when its last sync failed,
 * the bank no longer accepts it, or it needs a renewal inside 14 days;
 * connectionRowState, status before date), and its actions: Förnya as the
 * one button, Koppla bort behind the row's menu, so the state and the actions
 * share one line and every bank row ends on the same edge. A row signed at
 * the bank whose accounts were never chosen (the person left the account
 * step, often after the BankID app on a phone) reads nothing until they are:
 * it says so and offers Välj konton, which reopens the flow on that
 * connection at the account choice, instead of Förnya. Under an active
 * connection, each account it syncs has a row of its own with the 19xx
 * account it books on, which is where that account is changed (crm#1387).
 */
export function OpenPaymentsConnectionRow({ connection, flow, onChanged, canRenew = true }: OpenPaymentsConnectionRowProps) {
  const t = useTranslations('settings_connections')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { formatDateLong } = useFormat()
  const [now] = useState(() => Date.now())
  const [confirmOpen, setConfirmOpen] = useState(false)

  const state = connectionRowState(connection.status, connection.consent_expires, now)
  const awaitingAccounts = state.kind === 'choose_accounts'
  const stateText = awaitingAccounts
    ? t('op_choose_accounts')
    : state.kind === 'sync_failed'
    ? t('sync_failed')
    : state.kind === 'ended'
      ? t('op_ended')
      : state.kind === 'active'
        ? t('op_active_until', { date: formatDateLong(state.until) })
        : state.kind === 'renew_by'
          ? t('op_renew_by', { date: formatDateLong(state.until) })
          : state.kind === 'expired'
            ? t('op_expired')
            : t('op_active')
  const attention = state.kind !== 'active' && state.kind !== 'unknown'
  const bankName = connection.bank_name ?? ''

  async function disconnect() {
    try {
      await deleteOpenPaymentsConnection(connection.id)
      notifyBankSyncUpdated()
      toast({ title: t('disconnected_title') })
      onChanged()
    } catch (error) {
      const body = error instanceof OpenPaymentsClientError ? error.body : null
      toast({ title: t('disconnect_failed_title'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
      throw error
    }
  }

  return (
    <>
      <SettingsRow
        label={
          <span className="flex items-center gap-3">
            <BankTile bankName={connection.bank_name} />
            <span data-ph-mask="">{bankName}</span>
          </span>
        }
      >
        <SettingsRowNote fill className={cn(attention ? 'text-attn' : 'text-foreground')}>{stateText}</SettingsRowNote>
        {canWrite && (
          <SettingsRowEnd>
            {canRenew && awaitingAccounts && (
              <Button onClick={() => flow.open('resume', { connectionId: connection.id })}>
                {t('choose_accounts')}
              </Button>
            )}
            {canRenew && !awaitingAccounts && (
              <Button variant="outline" onClick={() => flow.open('renew', { bank: { bic: '', name: bankName }, replaceConnectionId: connection.id })}>
                {t('renew')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t('more_actions')}>
                  <EllipsisHorizontalIcon className="h-[15px] w-[15px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmOpen(true)}>
                  {t('disconnect')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRowEnd>
        )}
      </SettingsRow>
      {connection.status === 'active' && <BankAccountLedgerRows connectionId={connection.id} />}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('disconnect_title', { bank: bankName })}
        description={t('disconnect_description')}
        confirmLabel={t('disconnect_confirm')}
        destructive
        onConfirm={disconnect}
      />
    </>
  )
}
