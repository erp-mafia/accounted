'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="p-5 rounded-full bg-muted mb-6">
            <Upload className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-2">{t('empty_title')}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
            {t('empty_description')}
          </p>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto px-4 sm:px-0">
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
          </div>
        </CardContent>
      </Card>
    )
  }

  // All transactions categorized - inbox zero!
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12">
        <div className="h-16 w-16 rounded-full bg-success/10 flex items-center justify-center mb-4">
          <Check className="h-8 w-8 text-success" />
        </div>
        <h3 className="text-lg font-medium">{t('done_title')}</h3>
        <p className="text-muted-foreground text-center mt-1 max-w-sm">
          {t('done_description')}
        </p>
        <div className="flex gap-2 mt-6">
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
        </div>
      </CardContent>
    </Card>
  )
}
