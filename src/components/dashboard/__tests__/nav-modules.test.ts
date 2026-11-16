/**
 * The guard for more features (Profiles and Suggestions design, 2026-10-16):
 * every main navigation item declares the module it belongs to, so a new
 * page is a module mapped to a package, switched by the package, never a
 * menu entry no capability can reach. TypeScript requires the field
 * (NavGateFlags.module); this test refuses an item that slips through
 * without a module the manifest knows, in every menu: the shell's areas
 * (nav-v3.ts: every row and create action, the byrå cockpit's area among
 * them; the phone menu is drawn from the same tree) and the v2 tree the
 * assistant's UI map still reads (nav-v2.ts).
 */
import { describe, expect, it } from 'vitest'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '../nav-v2'
import { NAV_V3_AREAS, areaItems } from '../nav-v3'

type Declared = { href: string; module?: unknown }

function flatten(items: NavV2Item[]): Declared[] {
  return items.flatMap((item) => [item, ...(item.sub ?? [])])
}

const MENUS: Array<[string, Declared[]]> = [
  ['areas', NAV_V3_AREAS.flatMap((area) => [...areaItems(area), ...(area.create ?? [])])],
  ['assistant map (v2 tree)', flatten([...NAV_V2_TOP, ...NAV_V2_COMPANY])],
]

const KNOWN = new Set<unknown>(MODULE_IDS)

/** The items whose module the manifest does not know, as `href (module)`. */
function undeclared(items: Declared[]): string[] {
  return items.filter((item) => !KNOWN.has(item.module)).map((item) => `${item.href} (${String(item.module)})`)
}

describe('every main navigation item declares its module', () => {
  it.each(MENUS)('%s', (_menu, items) => {
    expect(items.length).toBeGreaterThan(0)
    expect(undeclared(items), 'give the item the module (lib/modules/manifest.ts) its page belongs to').toEqual([])
  })

  it('declares the same module for a page wherever it appears', () => {
    const byHref = new Map<string, Set<unknown>>()
    for (const [, items] of MENUS) {
      for (const item of items) byHref.set(item.href, (byHref.get(item.href) ?? new Set()).add(item.module))
    }
    const conflicts = [...byHref].filter(([, modules]) => modules.size > 1).map(([href, modules]) => `${href}: ${[...modules].join(', ')}`)
    expect(conflicts).toEqual([])
  })

  it('refuses an item without a module, or with one the manifest does not know', () => {
    expect(undeclared([{ href: '/new-feature' }, { href: '/other', module: 'billing' }, { href: '/ok', module: 'payroll' }])).toEqual([
      '/new-feature (undefined)',
      '/other (billing)',
    ])
  })
})
