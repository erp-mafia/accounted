'use client'

import Link from 'next/link'
import { Check } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { VatSettlementExistingEntry } from '@/lib/reports/vat-settlement'

/**
 * Status banner for Momsdeklaration: the period already has a posted
 * momsomföring. Statutory surface, Swedish in both locales like the rest of
 * the declaration. Read-only — does not claim the return was sent to SKV.
 */
export function VatAlreadyBookedBanner({
  entry,
}: {
  entry: VatSettlementExistingEntry
}) {
  const voucher = formatVoucher(entry)
  const voucherLabel = voucher === '-' ? 'verifikat' : `verifikat ${voucher}`

  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-[13px] leading-6"
    >
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <div className="min-w-0">
        <p>
          Momsen för perioden är redan bokförd:{' '}
          <Link
            href={`/bookkeeping/${entry.id}`}
            className="font-medium underline underline-offset-2 hover:text-foreground"
          >
            {voucherLabel}
          </Link>
          {entry.entry_date ? ` (${formatDate(entry.entry_date)})` : ''}.
        </p>
        <p className="mt-1 text-muted-foreground">
          Att öppna sidan räknar bara om rutorna från bokföringen. Du behöver
          inte skapa ett nytt verifikat.
        </p>
      </div>
    </div>
  )
}
