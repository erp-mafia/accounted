'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { Check, Upload, Plus } from 'lucide-react'
import Link from 'next/link'

interface InboxZeroStateProps {
  hasTransactions: boolean
  onCreateTransaction: () => void
}

export default function InboxZeroState({ hasTransactions, onCreateTransaction }: InboxZeroStateProps) {
  const t = useTranslations('tx_inbox_zero')
  const tStart = useTranslations('start_cards')

  if (!hasTransactions) {
    // No transactions at all: the start card leads with the bank connection
    // (the import page's own "Rekommenderat" path) and keeps the bank-file
    // import as the alternative. Manual creation stays reachable from the
    // header split button.
    return (
      <div className="animate-fade-in">
        <StartCard
          card="sthlm"
          layout="bleed-left"
          title={tStart('transactions_title')}
          body={tStart('transactions_body')}
          primary={{ label: tStart('transactions_primary'), href: '/import?mode=psd2' }}
          secondary={{ label: tStart('transactions_secondary'), href: '/import?mode=bank' }}
        />
      </div>
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
