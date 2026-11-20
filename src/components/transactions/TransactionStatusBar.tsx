'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowPathIcon, ArrowUpTrayIcon, ChevronDownIcon, PlusIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBankSync } from '@/components/transactions/BankSyncNowButton'
import { useAgeFormatter } from '@/components/transactions/BankSyncStatusChip'

interface TransactionStatusBarProps {
  children?: ReactNode
  onOpenCreateDialog: () => void
}

/**
 * Page header (V7 Pengar, Bankrader): the title, a quiet "Banken" menu with
 * the ways rows arrive from the bank (sync now, import a bank file) and one
 * filled primary, "Ny transaktion". The rare utilities never hold the filled
 * slot (product decision 2026-11-14).
 */
export default function TransactionStatusBar({
  onOpenCreateDialog,
  children,
}: TransactionStatusBarProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('transactions')
  const router = useRouter()
  const { connections, hasBankSync, syncAll, lastSyncedAt, isBusy } = useBankSync()
  const formatAge = useAgeFormatter()

  // "Synka bank nu" only renders once a bank is actually connected and the
  // plan includes PSD2 sync; for a connected company without the plan the
  // footer status chip ('paused') carries the upgrade link.
  const showSync = hasBankSync && (connections?.length ?? 0) > 0

  return (
    <PageHeader title={t('page_title')} action={<>
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="toolbar" variant="outline" aria-busy={isBusy || undefined}>
              {isBusy ? t('bank_sync_button_syncing') : t('bank_menu')}
              <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            {showSync && (
              <DropdownMenuItem
                disabled={!canWrite || isBusy}
                onSelect={() => {
                  void syncAll()
                }}
                className="h-auto items-start py-1.5"
              >
                <ArrowPathIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex flex-col">
                  <span>{t('create_synka')}</span>
                  <span className="text-xs text-muted-foreground">
                    {lastSyncedAt
                      ? t('create_synka_desc_last', { age: formatAge(lastSyncedAt) })
                      : t('create_synka_desc')}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              // Straight to the bank-file step: the row's own description says
              // "CSV- eller SIE-fil från banken", so the chooser in between is
              // a stop that asks what the user already answered.
              onSelect={() => router.push('/import?mode=bank')}
              className="h-auto items-start py-1.5"
            >
              <ArrowUpTrayIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex flex-col">
                <span>{t('action_import_bank_file')}</span>
                <span className="text-xs text-muted-foreground">{t('create_import_desc')}</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="toolbar"
          disabled={!canWrite}
          title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          onClick={onOpenCreateDialog}
        >
          <PlusIcon className="h-4 w-4" />
          {t('action_new_transaction')}
        </Button>
    </>} />
  )
}
