import type { Icon as AppIcon } from '@/components/icons'
import {
  NAV_V3_AREAS,
  areaItems,
  gateAreas,
  hrefPath,
  resolveNavPlace,
  type NavAreaId,
  type NavV3Area,
} from '@/components/dashboard/nav-v3'
import type { NavGateFlags } from '@/components/dashboard/nav-v2'
import { INKORG_HREF } from '@/lib/inkorg/flag'
import { isInvoicerPagePath, isInvoicerRole } from '@/lib/auth/invoicer-role'

/**
 * The command palette's pages, derived from the shell's tree (nav-v3.ts):
 * every row of every area the user's rail shows, under the area's name, with
 * the same gates as the sidebar. A page that moves in the menu moves here
 * with it, and a page the company does not have is not offered.
 *
 * The aliases (PAGE_ALIASES in CommandPalette.tsx) are what the tree cannot say: the words people type for a page
 * (its old menu name, "verifikat per konto"), and the few destinations that
 * are not a row of their own (single reports, Inställningar, Hjälp). An alias
 * whose href is a row of the tree lends that row its words; any other alias
 * is an entry of its own, filed under the area the shell lights for its URL.
 */

export type PalettePage = {
  id: string
  label: string
  hint?: string
  icon: AppIcon
  href: string
  keywords?: string
  /** The area the page belongs to, by its menu label: the group heading. */
  group: string
  /** The extension a page outside /e/ needs, for the palette's capability gate. */
  extension?: { sector: string; id: string }
}

export type PageAlias = {
  id: string
  label: string
  hint?: string
  icon: AppIcon
  href: string
  keywords?: string
}

/** The new Inkorg page is a page of the invoice-inbox extension, outside /e/. */
const PAGE_EXTENSION: Record<string, { sector: string; id: string }> = {
  [INKORG_HREF]: { sector: 'general', id: 'invoice-inbox' },
}

export interface PalettePagesInput {
  /** The sidebar's gate (passesNavGates with the company's context). */
  passes: (item: NavGateFlags) => boolean
  /** A company is open: without one only Inställningar and Hjälp lead anywhere. */
  hasCompany: boolean
  /** The user is a byrå team member: the Byrå area is on their rail. */
  isByraMember: boolean
  /** nav.* messages. */
  navLabel: (key: string) => string
  /** The words people type and the destinations without a row (PAGE_ALIASES in CommandPalette.tsx). */
  aliases: readonly PageAlias[]
  areas?: NavV3Area[]
}

/** The areas whose rows the palette lists, as the rail shows them. */
function listedAreas({ passes, hasCompany, isByraMember, areas = NAV_V3_AREAS }: Omit<PalettePagesInput, 'aliases' | 'navLabel'>): NavV3Area[] {
  return gateAreas(areas, passes).filter((area) =>
    area.id === 'settings' ? false : area.id === 'byra' ? isByraMember : hasCompany && areaItems(area).length > 0,
  )
}

/** Every page the palette offers, in menu order, each under its area. */
export function palettePages(input: PalettePagesInput): PalettePage[] {
  const { navLabel, aliases: PAGE_ALIASES } = input
  const areas = listedAreas(input)
  const areaLabel = (id: NavAreaId): string => navLabel((input.areas ?? NAV_V3_AREAS).find((a) => a.id === id)!.labelKey)

  const pages: PalettePage[] = []
  const rowHrefs = new Set<string>()
  for (const area of areas) {
    for (const item of areaItems(area)) {
      rowHrefs.add(item.href)
      // The aliases of the row: their labels are words people still type
      // ("Kundfakturor", "Granskning"), so they join the keywords.
      const aliases = PAGE_ALIASES.filter((alias) => alias.href === item.href)
      const words = aliases.flatMap((alias) => [alias.label, alias.hint ?? '', alias.keywords ?? ''])
      pages.push({
        id: `nav:${area.id}:${item.href}`,
        label: navLabel(item.labelKey),
        icon: item.icon,
        href: item.href,
        keywords: [navLabel(area.labelKey), ...words].filter(Boolean).join(' '),
        group: navLabel(area.labelKey),
        extension: PAGE_EXTENSION[item.href],
      })
    }
  }

  // The destinations with no row: filed under the area the shell lights for
  // them, and offered only while that area is on the rail (Inställningar
  // always is). An alias of a row that is gated away goes with its row.
  const allRowHrefs = new Set((input.areas ?? NAV_V3_AREAS).flatMap((area) => areaItems(area).map((item) => item.href)))
  const shown = new Set<NavAreaId>([...areas.map((area) => area.id), 'settings'])
  for (const alias of PAGE_ALIASES) {
    if (rowHrefs.has(alias.href) || allRowHrefs.has(alias.href)) continue
    const [path, search = ''] = alias.href.split('?')
    const place = resolveNavPlace(hrefPath(path), search)
    if (!place || !shown.has(place.area)) continue
    pages.push({ ...alias, group: areaLabel(place.area) })
  }
  return pages
}

/**
 * Whether the palette offers a destination to this role. The invoicing-only
 * role opens only its own pages (lib/auth/invoicer-role.ts): any other
 * entry, an action or a destination without a menu row, would send it back
 * to Fakturor instead of where the entry says.
 */
export function paletteOpensForRole(role: string | null | undefined, href: string): boolean {
  return !isInvoicerRole(role) || isInvoicerPagePath(hrefPath(href))
}

/** With nothing typed: one row per area (where its rail button lands), the area as the hint. */
export function paletteStartPages(pages: PalettePage[]): PalettePage[] {
  const seen = new Set<string>()
  const start: PalettePage[] = []
  for (const page of pages) {
    if (!page.id.startsWith('nav:') || seen.has(page.group)) continue
    seen.add(page.group)
    start.push({ ...page, hint: page.label === page.group ? undefined : page.group })
  }
  return start
}

/** Pages in their groups, in the order the groups first appear. */
export function groupPalettePages(pages: PalettePage[]): { group: string; pages: PalettePage[] }[] {
  const groups: { group: string; pages: PalettePage[] }[] = []
  for (const page of pages) {
    const existing = groups.find((g) => g.group === page.group)
    if (existing) existing.pages.push(page)
    else groups.push({ group: page.group, pages: [page] })
  }
  return groups
}
