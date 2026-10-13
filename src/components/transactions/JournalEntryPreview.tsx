'use client'

import { useMemo } from 'react'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
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
    chartVatTreatments,
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
      chartVatTreatments,
    }),
    [amount, amountSek, category, vatTreatment, accountOverride, entityType, templateDebitAccount, templateCreditAccount, templateVatRate, templateVatTreatment, templateSupplierType, counterpartyLegacy, linePattern, settlementAccount, vatAmountSek, chartVatTreatments]
  )

  if (lines.length === 0) return null

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5 overflow-hidden">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
      <VoucherLinesTable
        lines={lines.map((line, i) => ({
          key: i,
          account_number: line.account,
          debit_amount: line.side === 'debet' ? line.amount : 0,
          credit_amount: line.side === 'debet' ? 0 : line.amount,
          extra: changedAccounts?.includes(line.account) ? (
            <span className="rounded-sm bg-attn/15 px-1 text-[11px] font-medium uppercase tracking-wide text-attn">ny</span>
          ) : undefined,
        }))}
        withCurrency
      />
    </div>
  )
}
