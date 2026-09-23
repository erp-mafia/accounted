'use client'

import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { VatSettlementExistingEntry } from '@/lib/reports/vat-settlement'

/**
 * Top-of-page signal that this momsperiod already has a posted settlement.
 * Detection is the same as steg 3 (tagged vat_settlement or shape-detected
 * momsomföring). Read-only: does not claim Skatteverket submission.
 */
export function VatAlreadyBookedBanner({
  entry,
  deadlineCompleted,
}: {
  entry: VatSettlementExistingEntry
  /** Calendar deadline marked klar — not the same as SKV kvittens. */
  deadlineCompleted?: boolean
}) {
  const voucher = formatVoucher(entry)

  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-[13px] leading-6"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <div className="space-y-1">
        <p>
          Momsen för perioden är redan bokförd:{' '}
          <Link
            href={`/bookkeeping/${entry.id}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            verifikat {voucher}
          </Link>
          {entry.entry_date ? ` (${formatDate(entry.entry_date)})` : ''}.
        </p>
        <p className="text-muted-foreground">
          Att öppna sidan räknar bara om rutorna. Du behöver inte skapa ett nytt
          verifikat.
        </p>
        {deadlineCompleted && (
          <p className="text-muted-foreground">
            Deadline för perioden är markerad som klar i kalendern.
          </p>
        )}
      </div>
    </div>
  )
}
