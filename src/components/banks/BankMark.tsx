import { cn } from '@/lib/utils'
import { bankLogoUrl } from '@/lib/reconciliation/bank-logos'

/**
 * The bank's mark wherever an account or a connection is named: the account
 * to pay from, the connection row, the signing step. A small square (20px by
 * default) with the bank's logo, or nothing when the bank has none: the text
 * beside it names the bank either way.
 */
export function BankMark({ bankName, size = 20, className }: { bankName: string | null | undefined; size?: number; className?: string }) {
  const src = bankLogoUrl(bankName)
  if (!src) return null
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-white align-middle', className)}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" aria-hidden="true" className="h-full w-full object-contain p-[2px]" />
    </span>
  )
}
