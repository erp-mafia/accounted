'use client'

import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import { CheckCircle2, Paperclip } from 'lucide-react'
import { formatDate } from '@/lib/utils'

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
  totalDebit: number
  totalCredit: number
  attachmentCount?: number
  showBalanceBadge?: boolean
  hideDate?: boolean
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function JournalEntryReviewContent({
  periodName,
  entryDate,
  description,
  notes,
  voucherSeries,
  lines,
  totalDebit,
  totalCredit,
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
            <p className="font-medium">{periodName}</p>
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
            <Badge variant="success">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Debet = Kredit
            </Badge>
          )}
          {attachmentCount != null && attachmentCount > 0 && (
            <Badge variant="outline">
              <Paperclip className="h-3 w-3 mr-1" />
              {attachmentCount} underlag
            </Badge>
          )}
        </div>
      )}

      {/* Debit/Credit: table on desktop, cards on mobile */}
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-2 w-24">Konto</th>
              <th className="py-2">Beskrivning</th>
              <th className="py-2 w-28 text-right">Debet</th>
              <th className="py-2 w-28 text-right">Kredit</th>
            </tr>
          </thead>
          <tbody>
            {activeLines.map((line, index) => (
              <tr key={index} className="border-b last:border-0">
                <td className="py-2">
                  <AccountNumber number={line.account_number} />
                </td>
                <td className="py-2 text-muted-foreground">
                  {line.line_description || ''}
                </td>
                <td className="py-2 text-right">
                  {parseFloat(line.debit_amount) > 0
                    ? formatAmount(parseFloat(line.debit_amount))
                    : ''}
                </td>
                <td className="py-2 text-right">
                  {parseFloat(line.credit_amount) > 0
                    ? formatAmount(parseFloat(line.credit_amount))
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold border-t-2">
              <td colSpan={2} className="py-2">Summa</td>
              <td className="py-2 text-right text-success">{formatAmount(totalDebit)}</td>
              <td className="py-2 text-right text-success">{formatAmount(totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="sm:hidden space-y-1.5">
        {activeLines.map((line, index) => (
          <div key={index} className="flex items-center justify-between py-2 border-b last:border-0 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <AccountNumber number={line.account_number} />
                {line.line_description && (
                  <span className="text-muted-foreground text-xs truncate">{line.line_description}</span>
                )}
              </div>
            </div>
            <span className="font-mono text-sm shrink-0 ml-2">
              {parseFloat(line.debit_amount) > 0
                ? `D ${formatAmount(parseFloat(line.debit_amount))}`
                : `K ${formatAmount(parseFloat(line.credit_amount))}`}
            </span>
          </div>
        ))}
        <div className="flex justify-between pt-2 border-t-2 font-semibold text-sm">
          <span>Summa</span>
          <span className="text-success">D {formatAmount(totalDebit)} / K {formatAmount(totalCredit)}</span>
        </div>
      </div>
    </div>
  )
}
