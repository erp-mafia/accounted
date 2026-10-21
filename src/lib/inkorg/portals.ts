/**
 * Portaler in the Inkorg rail: the suppliers among the company's purchases
 * without underlag whose invoices wait behind a login, one row each.
 *
 * Read off the purchases GET /api/extensions/ext/invoice-inbox/purchases
 * already answers: each row carries `portal` when the company added a portal
 * for that supplier, or the portal directory
 * (lib/receipt-hunt/portal-directory.ts) knows where it keeps its invoices.
 * Nothing else is read, so a supplier added to the directory shows up here
 * for every company at once, and one a company added shows up for every one
 * of its purchases from that supplier.
 *
 * Pure: no client, no I/O, no React.
 */
import type { MissingPurchase } from './missing'

/**
 * How a portal row stands:
 *   - missing: at least one of its purchases needs a person now;
 *   - on_the_way: every one of them is on its way (GET
 *     /api/inkorg/expectations), so nothing waits on anyone yet.
 */
export type PortalStatus = 'missing' | 'on_the_way'

/** One row under Portaler. */
export interface PortalRow {
  /** The supplier as the directory names it: the row's label and the view's filter. */
  vendor: string
  /** The page a person lands on to fetch the invoice. */
  url: string
  /** The supplier's stored icon (lib/vendor-logos), off the first of its purchases that has one. */
  logoUrl: string | null
  /** Its purchases without underlag. */
  missing: number
  /** Of those, the ones that need a person now. */
  needsYou: number
  status: PortalStatus
}

/**
 * The rail's Portaler: one row per supplier with a known portal, most
 * purchases without underlag first, then by name, so a refetch never
 * reorders rows that did not change.
 */
export function portalRows(
  purchases: readonly Pick<MissingPurchase, 'id' | 'portal' | 'logo_url'>[],
  onTheWay: { has: (id: string) => boolean },
): PortalRow[] {
  const rows = new Map<string, PortalRow>()
  for (const purchase of purchases) {
    const portal = purchase.portal
    const vendor = portal?.vendor.trim()
    if (!portal || !vendor) continue
    const row = rows.get(vendor) ?? {
      vendor,
      url: portal.url,
      logoUrl: null,
      missing: 0,
      needsYou: 0,
      status: 'on_the_way' as PortalStatus,
    }
    row.logoUrl ??= purchase.logo_url ?? null
    row.missing += 1
    if (!onTheWay.has(purchase.id)) {
      row.needsYou += 1
      row.status = 'missing'
    }
    rows.set(vendor, row)
  }
  return [...rows.values()].sort((a, b) => {
    if (a.missing !== b.missing) return b.missing - a.missing
    return a.vendor.localeCompare(b.vendor, 'sv')
  })
}

/** The purchases a portal row opens: Saknar underlag, filtered to that supplier. */
export function purchasesAtPortal<T extends Pick<MissingPurchase, 'portal'>>(purchases: readonly T[], vendor: string): T[] {
  return purchases.filter((purchase) => purchase.portal?.vendor.trim() === vendor)
}
