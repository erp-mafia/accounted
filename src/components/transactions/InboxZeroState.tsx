'use client'

import { useTranslations } from 'next-intl'
import { EmptyState } from '@/components/ui/empty-state'
import { StartCard } from '@/components/dashboard/StartCard'
import { CheckIcon } from '@/components/icons'

interface InboxZeroStateProps {
  hasTransactions: boolean
}

export default function InboxZeroState({ hasTransactions }: InboxZeroStateProps) {
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

  // All transactions categorized: inbox zero. Importing more and creating
  // one by hand are the header split button's options, so the empty state
  // does not repeat them.
  return <EmptyState icon={CheckIcon} title={t('done_title')} description={t('done_description')} />
}
