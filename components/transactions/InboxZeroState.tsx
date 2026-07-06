'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Check, Upload, Plus } from 'lucide-react'
import Link from 'next/link'

interface InboxZeroStateProps {
  hasTransactions: boolean
  onCreateTransaction: () => void
}

export default function InboxZeroState({ hasTransactions, onCreateTransaction }: InboxZeroStateProps) {
  const t = useTranslations('tx_inbox_zero')

  if (!hasTransactions) {
    // No transactions at all
    return (
      <EmptyState icon={Upload} title={t('empty_title')} description={t('empty_description')}>
        <Button asChild>
          <Link href="/import">
            <Upload className="mr-2 h-4 w-4" />
            {t('import_btn')}
          </Link>
        </Button>
        <Button variant="outline" onClick={onCreateTransaction}>
          <Plus className="mr-2 h-4 w-4" />
          {t('add_manual_btn')}
        </Button>
      </EmptyState>
    )
  }

  // All transactions categorized: inbox zero!
  return (
    <EmptyState icon={Check} title={t('done_title')} description={t('done_description')}>
      <Button asChild variant="outline">
        <Link href="/import">
          <Upload className="mr-2 h-4 w-4" />
          {t('import_more_btn')}
        </Link>
      </Button>
      <Button variant="outline" onClick={onCreateTransaction}>
        <Plus className="mr-2 h-4 w-4" />
        {t('new_btn')}
      </Button>
    </EmptyState>
  )
}
