import { flagEnabled } from '@/lib/env/public-flags'

/**
 * NEXT_PUBLIC_FINANCE_LEASE_ENABLED: the register of finansiella leasingavtal
 * under K3 kapitel 20 (the page under bokslut, its routes and the company's
 * opt-in). Unset = off until the founder flips it. With the switch on, a
 * company still keeps the 20.29 relief until it chooses capitalisation.
 */
export function financeLeaseEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_FINANCE_LEASE_ENABLED)
}
