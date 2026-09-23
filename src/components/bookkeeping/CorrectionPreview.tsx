'use client'

import { AccountNumber } from '@/components/ui/account-number'
import {
  buildCorrectionRows,
  formatSignedAmount,
  type AccountRow,
  type CorrectionLineInput,
} from '@/components/bookkeeping/correction-preview-rows'
import type { JournalEntryLine } from '@/types'

interface Props {
  originalLines: JournalEntryLine[]
  correctedLines: CorrectionLineInput[]
}

function signClass(n: number): string {
  if (n > 0) return 'text-success'
  if (n < 0) return 'text-destructive'
  return 'text-muted-foreground'
}

export default function CorrectionPreview({ originalLines, correctedLines }: Props) {
  const rows = buildCorrectionRows(originalLines, correctedLines)
  const hasAnyCorrection = correctedLines.some((l) => {
    if (l.account_number.length !== 4) return false
    const d = typeof l.debit_amount === 'string' ? parseFloat(l.debit_amount) : l.debit_amount
    const c = typeof l.credit_amount === 'string' ? parseFloat(l.credit_amount) : l.credit_amount
    return (Number.isFinite(d) && d > 0) || (Number.isFinite(c) && c > 0)
  })

  // An account that was on the original but the user dropped from the rättelse:
  // the storno still drains it to zero (delta = −original). Flag it so the cell
  // reads "tas bort" instead of a bare "-", which would imply "unchanged".
  const isRemoved = (row: AccountRow) =>
    hasAnyCorrection && !row.correctionPresent && Math.abs(row.original) >= 0.005

  // The per-account deltas sum to the corrected lines' debit − credit. A non-zero
  // sum means the proposed rättelse is not yet balanced: surface that here so the
  // förändring column is read as a work-in-progress, not a miscalculation.
  const netDelta = rows.reduce((sum, r) => sum + r.delta, 0)
  const unbalanced = hasAnyCorrection && Math.abs(netDelta) >= 0.005

  if (rows.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Effekt per konto</p>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Debet − Kredit
        </p>
      </div>

      <div className="hidden sm:block rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground bg-muted/30">
            <tr>
              <th className="px-3 py-2 text-left w-56">Konto</th>
              <th className="px-3 py-2 text-right">Original</th>
              <th className="px-3 py-2 text-right">Storno</th>
              <th className="px-3 py-2 text-right">Rättelse</th>
              <th className="px-3 py-2 text-right border-l">Förändring</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.account_number} className="border-t">
                <td className="px-3 py-1.5">
                  <AccountNumber number={row.account_number} showName size="sm" />
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${signClass(row.original)}`}>
                  {formatSignedAmount(row.original)}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${signClass(row.storno)}`}>
                  {formatSignedAmount(row.storno)}
                </td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${isRemoved(row) ? 'text-muted-foreground' : signClass(row.correction)}`}>
                  {!hasAnyCorrection ? '-' : isRemoved(row) ? 'tas bort' : formatSignedAmount(row.correction)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums border-l font-medium ${signClass(row.delta)}`}
                >
                  {hasAnyCorrection ? formatSignedAmount(row.delta) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="sm:hidden space-y-2">
        {rows.map((row) => (
          <div key={row.account_number} className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <AccountNumber number={row.account_number} showName size="sm" />
              <span className={`text-sm font-medium tabular-nums ${signClass(row.delta)}`}>
                {hasAnyCorrection ? formatSignedAmount(row.delta) : '-'}
              </span>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Original</dt>
                <dd className={`tabular-nums ${signClass(row.original)}`}>{formatSignedAmount(row.original)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Storno</dt>
                <dd className={`tabular-nums ${signClass(row.storno)}`}>{formatSignedAmount(row.storno)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Rättelse</dt>
                <dd className={`tabular-nums ${isRemoved(row) ? 'text-muted-foreground' : signClass(row.correction)}`}>
                  {!hasAnyCorrection ? '-' : isRemoved(row) ? 'tas bort' : formatSignedAmount(row.correction)}
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Förändring = storno + rättelse. Det är det netto som tillkommer ovanpå originalet när du
        bokför. Ett konto du tar bort nollställs av stornon.
      </p>
      {unbalanced && (
        <p className="text-xs text-destructive">
          Förslaget balanserar inte ännu: debet och kredit i rättelsen måste vara lika.
        </p>
      )}
    </div>
  )
}
