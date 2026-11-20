import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * The BankID mark as a trust signal beside a BankID step: above the QR, in
 * the same-device button, before the signing starts. Decorative (the text
 * beside it names BankID), about 20px tall, inverted in dark mode like the
 * login's mark.
 */
export function BankIdMark({ className, size = 20 }: { className?: string; size?: number }) {
  return <Image src="/logos/bankid-seeklogo.svg" alt="" aria-hidden="true" width={size} height={size} className={cn('shrink-0 dark:invert', className)} />
}
