'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Upload, Plus } from 'lucide-react'
import { SplitButton } from '@/components/ui/split-button'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'

interface TransactionStatusBarProps {
  onOpenCreateDialog: () => void
}

const CREATE_MODES = ['importera', 'manuell'] as const

/**
 * Page header (concept scene 10): title + one Importera split button
 * holding the ways transactions arrive (import guide for CSV/SIE, manual
 * entry for cash/outlays). Bank sync lives on the footer status line.
 */
export default function TransactionStatusBar({
  onOpenCreateDialog,
}: TransactionStatusBarProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('transactions')
  const router = useRouter()
  const { uiState, loaded } = useUiState()

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="font-display text-2xl leading-8 tracking-tight">{t('page_title')}</h1>
      <SplitButton
        key={loaded ? 'loaded' : 'initial'}
        persistKey="transactions"
        initialModeKey={resolveInitialMode(uiState, 'transactions', CREATE_MODES, 'importera')}
        options={[
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
            onSelect: () => {
              if (canWrite) onOpenCreateDialog()
            },
          },
        ]}
      />
    </div>
  )
}
