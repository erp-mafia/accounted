import { flagEnabled } from '@/lib/env/public-flags'

/**
 * NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED: pågående arbeten under K3 kapitel 23
 * (successiv vinstavräkning or the färdigställandemetod): the page under
 * bokslut, its routes, the uppdrag register and the year's booking. Unset =
 * off until the operator flips it.
 */
export function contractRevenueEnabled(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED)
}
