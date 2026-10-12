'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Landmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { bankLogoUrl } from '@/lib/reconciliation/bank-logos'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { cn } from '@/lib/utils'
import { consentState } from './connection-kind'
import { deleteOpenPaymentsConnection, OpenPaymentsClientError } from './open-payments-client'
import type { BankConnectFlow } from './use-bank-connect-flow'
import type { BankConnectionRow } from './use-open-payments-connections'

/** 28px tile holding a bank's mark, so every connection row starts the same way. */
export function BankTile({ bankName }: { bankName: string | null }) {
  const src = bankLogoUrl(bankName)
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-white">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-5 w-5 object-contain" />
      ) : (
        <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />
      )}
    </span>
  )
}

interface OpenPaymentsConnectionRowProps {
  connection: BankConnectionRow
  flow: BankConnectFlow
  /** Called after a disconnect went through. */
  onChanged: () => void
}

/**
 * One Open Payments connection as a flat hairline row: the bank, where its
 * consent stands (muted when fine, the one ochre sentence when it needs a
 * renewal inside 14 days), and the two actions, Förnya and Koppla bort.
 */
export function OpenPaymentsConnectionRow({ connection, flow, onChanged }: OpenPaymentsConnectionRowProps) {
  const t = useTranslations('settings_connections')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { formatDateLong } = useFormat()
  const [now] = useState(() => Date.now())
  const [confirmOpen, setConfirmOpen] = useState(false)

  const consent = consentState(connection.consent_expires, now)
  const stateText =
    consent.kind === 'active'
      ? t('op_active_until', { date: formatDateLong(consent.until) })
      : consent.kind === 'renew_by'
        ? t('op_renew_by', { date: formatDateLong(consent.until) })
        : consent.kind === 'expired'
          ? t('op_expired')
          : t('op_active')
  const attention = consent.kind === 'renew_by' || consent.kind === 'expired'
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
        <SettingsRowNote className={cn(attention ? 'text-attn' : 'text-foreground')}>{stateText}</SettingsRowNote>
        {canWrite && (
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={() => flow.open('renew', { bank: { bic: '', name: bankName }, replaceConnectionId: connection.id })}>
              {t('renew')}
            </Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setConfirmOpen(true)}>
              {t('disconnect')}
            </Button>
          </SettingsRowEnd>
        )}
      </SettingsRow>
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
