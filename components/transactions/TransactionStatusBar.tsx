'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Upload, Plus, RefreshCw } from 'lucide-react'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import { useBankSync } from '@/components/transactions/BankSyncNowButton'
import { useAgeFormatter } from '@/components/transactions/BankSyncStatusChip'

interface TransactionStatusBarProps {
  onOpenCreateDialog: () => void
}

/**
 * Page header (concept scene 10): title + one Importera split button
 * holding the ways transactions arrive (bank sync, import guide for CSV/SIE,
 * manual entry for cash/outlays).
 */
export default function TransactionStatusBar({
  onOpenCreateDialog,
}: TransactionStatusBarProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('transactions')
  const router = useRouter()
  const { uiState, loaded } = useUiState()
  const { connections, hasBankSync, syncAll, lastSyncedAt, isBusy } = useBankSync()
  const formatAge = useAgeFormatter()

  // "Synka bank nu" (concept: first menu row) only renders once a bank is
  // actually connected and the plan includes PSD2 sync; the footer
  // BankSyncNowButton stays the gated conversion surface for free users.
  const showSync = hasBankSync && (connections?.length ?? 0) > 0

  const options: SplitButtonOption[] = [
    ...(showSync
      ? [
          {
            key: 'synka',
            label: t('create_synka'),
            icon: RefreshCw,
            busy: isBusy,
            busyLabel: t('bank_sync_button_syncing'),
            description: lastSyncedAt
              ? t('create_synka_desc_last', { age: formatAge(lastSyncedAt) })
              : t('create_synka_desc'),
            onSelect: () => {
              void syncAll()
            },
          } satisfies SplitButtonOption,
        ]
      : []),
    {
      key: 'importera',
      label: t('action_import'),
      icon: Upload,
      description: t('create_import_desc'),
      onSelect: () => router.push('/import'),
    },
    {
      key: 'manuell',
      label: t('action_new_transaction'),
      icon: Plus,
      description: t('create_manual_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => onOpenCreateDialog(),
    },
  ]

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="font-display text-2xl leading-8 tracking-tight">{t('page_title')}</h1>
      <SplitButton
        key={`${loaded ? 'loaded' : 'initial'}-${showSync ? 'sync' : 'nosync'}`}
        persistKey="transactions"
        initialModeKey={resolveInitialMode(
          uiState,
          'transactions',
          options.map((o) => o.key),
          'importera',
        )}
        options={options}
      />
    </div>
  )
}
