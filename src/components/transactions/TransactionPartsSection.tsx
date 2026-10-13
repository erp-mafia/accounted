'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatOrgNumber } from '@/lib/utils'
import type { BatchAllocationPrefill, TransactionPartView, TransactionPartsResponse } from '@/lib/transactions/parts-read'

async function fetchParts(url: string): Promise<TransactionPartsResponse> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  return ((await res.json()) as { data: TransactionPartsResponse }).data
}

/** The allocation one suggested part asks for: its invoice and its own amount. */
function prefillOf(part: TransactionPartView): BatchAllocationPrefill | null {
  const suggested = part.suggested_invoice
  if (!suggested) return null
  const amount = Math.abs(part.amount)
  return suggested.kind === 'customer_invoice'
    ? { kind: 'customer_invoice', invoice_id: suggested.invoice_id, amount }
    : { kind: 'supplier_invoice', supplier_invoice_id: suggested.invoice_id, amount }
}

interface TransactionPartsSectionProps {
  transactionId: string
  /** Open the batch allocation with the suggested invoices filled in; absent when the row cannot be split-matched. */
  onMatch?: (allocations: BatchAllocationPrefill[]) => void
  processing: boolean
}

/**
 * The Bankgirot split of a bank row in the transaction drawer: one line per
 * payer or payee with organisationsnummer, OCR and amount, and the invoice
 * ingest suggests for it. One button opens the batch allocation
 * (MatchAllocationDialog) with every suggested invoice and amount filled in;
 * parts without a suggestion are left for the person to fill. Renders
 * nothing for a row without a split.
 */
export function TransactionPartsSection({ transactionId, onMatch, processing }: TransactionPartsSectionProps) {
  const t = useTranslations('tx_parts')
  const { data } = useSWR<TransactionPartsResponse>(`/api/transactions/${transactionId}/parts`, fetchParts)
  const parts = data?.parts ?? []
  if (parts.length === 0) return null

  const prefills = parts.map(prefillOf).filter((p): p is BatchAllocationPrefill => p !== null)
  const kinds = new Set(prefills.map((p) => p.kind))

  return (
    <div className="border-b border-border px-5 py-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {t('heading', { count: parts.length })}
      </p>
      <ul className="divide-y divide-border text-[12.5px]">
        {parts.map((part) => {
          const orgNumber = part.counterparty_org_number ? formatOrgNumber(part.counterparty_org_number) : null
          const suggested = part.suggested_invoice
          return (
            <li key={part.part_id} className="flex items-start justify-between gap-3 py-1.5">
              <div className="min-w-0" data-ph-mask>
                <p className="truncate">{part.counterparty_name ?? t('unknown_counterparty')}</p>
                <p className="truncate text-muted-foreground">
                  {[orgNumber, part.reference ? t('ocr', { reference: part.reference }) : null].filter(Boolean).join(' · ')}
                </p>
                <p className={suggested ? 'truncate' : 'text-muted-foreground'}>
                  {suggested
                    ? t('suggested_invoice', { number: suggested.invoice_number ?? '', name: suggested.counterparty_name ?? '' })
                    : t('no_invoice')}
                </p>
              </div>
              <span className="shrink-0 tabular-nums" data-ph-mask>
                {formatCurrency(part.amount, part.currency)}
              </span>
            </li>
          )
        })}
      </ul>
      {/* One kind per batch (the allocation RPC refuses a mix): a split that
          names both is left to the person. */}
      {onMatch && prefills.length > 0 && kinds.size === 1 && (
        <Button size="sm" className="mt-2" onClick={() => onMatch(prefills)} disabled={processing}>
          {t('match_button', { count: prefills.length })}
        </Button>
      )}
    </div>
  )
}
