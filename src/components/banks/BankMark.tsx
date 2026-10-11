import { cn } from '@/lib/utils'

/**
 * The bank's mark wherever an account or a connection is named: the account
 * to pay from, the connection row, the signing step. One lookup from the
 * bank name the connection reports (Enable Banking and Open Payments spell
 * them differently) to the file under public/logos/banks.
 */
const BANK_LOGOS: Array<[match: string, file: string]> = [
  ['seb', 'seb'],
  ['swedbank', 'swedbank'],
  ['sparbank', 'swedbank'],
  ['handelsbanken', 'handelsbanken'],
  ['nordea', 'nordea'],
  ['danske', 'danske'],
  ['länsförsäkringar', 'lansforsakringar'],
  ['lansforsakringar', 'lansforsakringar'],
  ['lunar', 'lunar'],
  ['revolut', 'revolut'],
  ['wise', 'wise'],
  ['svea', 'svea'],
  ['northmill', 'northmill'],
  ['klarna', 'klarna'],
  ['paypal', 'paypal'],
  ['stripe', 'stripe'],
]

/** The logo file stem for a bank name, or null when no mark exists for it. */
export function bankLogoFile(bankName: string | null | undefined): string | null {
  if (!bankName) return null
  const key = bankName.toLowerCase().replace(/\s+/g, '')
  return BANK_LOGOS.find(([match]) => key.includes(match))?.[1] ?? null
}

export function bankLogoSrc(bankName: string | null | undefined): string | null {
  const file = bankLogoFile(bankName)
  return file ? `/logos/banks/${file}.png` : null
}

/**
 * A small square mark (20px by default) with the bank's logo, or nothing when
 * the bank has none: the text beside it names the bank either way.
 */
export function BankMark({ bankName, size = 20, className }: { bankName: string | null | undefined; size?: number; className?: string }) {
  const src = bankLogoSrc(bankName)
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
