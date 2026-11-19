'use client'

import { useCompanyOptional } from '@/contexts/CompanyContext'
import { isInvoicerRole } from '@/lib/auth/invoicer-role'

/**
 * Whether the signed-in member holds the invoicing-only role in the active
 * company (lib/auth/invoicer-role.ts). The role reaches only the routes on
 * its allowlist, so a component on one of its pages reads this to leave out
 * a request the server always refuses for it: a panel that would only show
 * a failed read, a poll or a retry that can never succeed (for #206).
 *
 * UI only: the allowlist in withRouteContext is the enforcement. False
 * outside a CompanyProvider.
 */
export function useIsInvoicer(): boolean {
  return isInvoicerRole(useCompanyOptional()?.role)
}
