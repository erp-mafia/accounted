'use client'

import { useMemo } from 'react'
import { formatCurrency } from '@/lib/utils'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { computeProposalLines } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLinesInput } from '@/lib/bookkeeping/proposal-lines'

export type JournalEntryPreviewProps = ProposalLinesInput & {
  /** Accounts that were not in the previous proposal: their lines are marked so a change is seen, not inferred. */
  changedAccounts?: string[]
}

export default function JournalEntryPreview({ changedAccounts, ...props }: JournalEntryPreviewProps) {
  const {
    amount,
    amountSek,
    category,
    vatTreatment,
    accountOverride,
    entityType,
    templateDebitAccount,
    templateCreditAccount,
    templateVatRate,
    templateVatTreatment,
    templateSupplierType,
    counterpartyLegacy,
    linePattern,
    settlementAccount,
    vatAmountSek,
  } = props

  // Line computation lives in lib/bookkeeping/proposal-lines.ts, shared with
  // the "Andra rader" prefill so preview and editable lines never drift.
  const lines = useMemo(
    () => computeProposalLines({
      amount,
      amountSek,
      category,
      vatTreatment,
      accountOverride,
      entityType,
      templateDebitAccount,
      templateCreditAccount,
      templateVatRate,
      templateVatTreatment,
      templateSupplierType,
      counterpartyLegacy,
      linePattern,
      settlementAccount,
      vatAmountSek,
    }),
    [amount, amountSek, category, vatTreatment, accountOverride, entityType, templateDebitAccount, templateCreditAccount, templateVatRate, templateVatTreatment, templateSupplierType, counterpartyLegacy, linePattern, settlementAccount, vatAmountSek]
  )

  if (lines.length === 0) return null

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5 overflow-hidden">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
      <div className="space-y-0.5 font-mono text-xs min-w-0">
        {lines.map((line, i) => (
          <div key={i} className="flex items-baseline gap-2 min-w-0">
            <span className={`w-12 text-right flex-shrink-0 ${line.side === 'debet' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {line.side === 'debet' ? 'Debet' : 'Kredit'}
            </span>
            <span className={`flex-1 truncate ${changedAccounts?.includes(line.account) ? 'font-semibold text-foreground' : ''}`}>
              {formatAccountWithName(line.account)}
              {changedAccounts?.includes(line.account) && (
                <span className="ml-1.5 rounded-sm bg-attn/15 px-1 font-sans text-[10px] font-medium uppercase tracking-wide text-attn">ny</span>
              )}
            </span>
            <span className="flex-shrink-0 tabular-nums">{formatCurrency(line.amount, 'SEK')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
