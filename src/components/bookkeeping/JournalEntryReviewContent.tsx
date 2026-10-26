'use client'

import { Badge } from '@/components/ui/badge'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { CheckCircle2, Paperclip } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { fiscalYearShortName } from '@/lib/bookkeeping/suggest-fiscal-period'

interface ReviewLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
}

interface JournalEntryReviewContentProps {
  periodName: string
  entryDate: string
  description: string
  notes?: string
  voucherSeries?: string
  lines: ReviewLine[]
  attachmentCount?: number
  showBalanceBadge?: boolean
  hideDate?: boolean
}

export function JournalEntryReviewContent({
  periodName,
  entryDate,
  description,
  notes,
  voucherSeries,
  lines,
  attachmentCount,
  showBalanceBadge = true,
  hideDate = false,
}: JournalEntryReviewContentProps) {
  const activeLines = lines.filter(
    (l) => l.account_number && (l.debit_amount || l.credit_amount)
  )

  return (
    <div className="space-y-4">
      {/* Header info */}
      <div className="bg-muted rounded-lg p-4 space-y-2">
        <div className={`grid gap-4 text-sm ${hideDate && !voucherSeries ? 'grid-cols-1' : hideDate || !voucherSeries ? 'grid-cols-2' : 'grid-cols-3'}`}>
          <div>
            <span className="text-muted-foreground">Räkenskapsår</span>
            <p className="font-medium">{fiscalYearShortName(periodName)}</p>
          </div>
          {!hideDate && (
            <div>
              <span className="text-muted-foreground">Datum</span>
              <p className="font-medium">{formatDate(entryDate)}</p>
            </div>
          )}
          {voucherSeries && (
            <div>
              <span className="text-muted-foreground">Serie</span>
              <p className="font-medium font-mono">{voucherSeries}</p>
            </div>
          )}
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Beskrivning</span>
          <p className="font-medium">{description}</p>
        </div>
        {notes && (
          <div className="text-sm">
            <span className="text-muted-foreground">Intern anteckning</span>
            <p className="text-muted-foreground italic">{notes}</p>
          </div>
        )}
      </div>

      {/* Balance status */}
      {(showBalanceBadge || (attachmentCount != null && attachmentCount > 0)) && (
        <div className="flex items-center gap-2">
          {showBalanceBadge && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Debet = Kredit
            </span>
          )}
          {attachmentCount != null && attachmentCount > 0 && (
            <Badge variant="outline">
              <Paperclip className="h-3 w-3 mr-1" />
              {attachmentCount} underlag
            </Badge>
          )}
        </div>
      )}

      {/* The rows to be posted, with their Summa (the voucher lines table
          every booking surface uses). */}
      <VoucherLinesTable
        lines={voucherLineViews(activeLines)}
        redundantTexts={[description]}
        showTotals
      />
    </div>
  )
}
