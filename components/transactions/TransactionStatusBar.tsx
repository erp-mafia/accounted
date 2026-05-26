'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { Upload, Plus, CheckSquare, FileText, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { ViewMode } from './transaction-types'

interface TransactionStatusBarProps {
  uncategorizedCount: number
  invoiceMatchCount: number
  mode: ViewMode
  onOpenCreateDialog: () => void
  isBatchMode: boolean
  onToggleBatchMode: () => void
}

export default function TransactionStatusBar({
  uncategorizedCount,
  invoiceMatchCount,
  mode,
  onOpenCreateDialog,
  isBatchMode,
  onToggleBatchMode,
}: TransactionStatusBarProps) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('transactions')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">{t('page_title')}</h1>
        {uncategorizedCount > 0 && mode === 'inbox' && (
          <p className="text-muted-foreground mt-1">
            <span className="text-foreground font-semibold">{uncategorizedCount}</span> {t('subtitle_to_post')}
            {invoiceMatchCount > 0 && (
              <span className="ml-2">
                · <FileText className="inline h-3.5 w-3.5 text-primary" />{' '}
                <span className="text-foreground font-semibold">{t('subtitle_matches', { count: invoiceMatchCount })}</span>
              </span>
            )}
          </p>
        )}
        {mode === 'history' && (
          <p className="text-muted-foreground">{t('history_subtitle')}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href="/import">
            <Upload className="mr-2 h-4 w-4" />
            {t('action_import')}
          </Link>
        </Button>
        {mode === 'inbox' && uncategorizedCount > 0 && (
          <Button
            variant={isBatchMode ? 'default' : 'outline'}
            size="sm"
            onClick={onToggleBatchMode}
          >
            <CheckSquare className="mr-2 h-4 w-4" />
            {isBatchMode ? t('action_select_multi_end') : t('action_select_multi_start')}
          </Button>
        )}
        <Button
          size="sm"
          onClick={onOpenCreateDialog}
          disabled={!canWrite}
          title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
        >
          {canWrite ? (
            <Plus className="mr-2 h-4 w-4" />
          ) : (
            <Lock className="mr-2 h-4 w-4" />
          )}
          {t('action_new_transaction')}
        </Button>
      </div>
    </div>
  )
}
