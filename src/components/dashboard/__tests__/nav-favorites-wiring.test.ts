/**
 * Favoriter in the area sidebar, as the source wires it: the star is a
 * button of its own beside the row's link, the group is drawn from the menu
 * rows and only when there is a favourite, and every shell hands the sidebar
 * the stored list. A shell that left it out would start from an empty list,
 * and the first press on a star would store that list over the real one.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const count = (source: string, snippet: string) => source.split(snippet).length - 1

describe('the star on a menu row', () => {
  const sidebar = read('src/components/dashboard/AreaSidebar.tsx')

  it('is a button after the link, not inside it', () => {
    const link = sidebar.indexOf('<NavLink\n            href={item.href}')
    const linkEnd = sidebar.indexOf('</NavLink>', link)
    const star = sidebar.indexOf('{star && (\n          <Button\n            type="button"')
    expect(link).toBeGreaterThan(-1)
    expect(linkEnd).toBeGreaterThan(link)
    expect(star).toBeGreaterThan(linkEnd)
  })

  it('is named for what a press does, and toggles the row it sits on', () => {
    expect(sidebar).toContain('const starLabel = isFavorite ? star?.removeLabel : star?.addLabel')
    expect(sidebar).toContain('aria-label={starLabel}')
    expect(sidebar).toContain('onClick={() => star.onToggle(item.href)}')
  })

  it('is filled on a favourite and an outline otherwise', () => {
    expect(sidebar).toContain("<StarIcon className=\"h-3.5 w-3.5\" fill={isFavorite ? 'currentColor' : undefined} />")
  })

  it('lies over the row end, shown on hover, on keyboard focus and where there is no hover', () => {
    for (const token of [
      'absolute',
      'opacity-0',
      'group-hover/fav:opacity-100',
      'group-has-[:focus-visible]/fav:opacity-100',
      '[@media(hover:none)]:opacity-100',
    ]) {
      expect(sidebar).toContain(token)
    }
    expect(sidebar).toContain("<li key={item.href} className={star ? 'group/fav relative' : undefined}>")
  })

  it('is left off a row that cannot be opened, and off the settings row and the create button', () => {
    expect(sidebar).toContain('const star = favorites && item.enabled ? favorites : undefined')
    // The one place a star is drawn is the menu row.
    expect(count(sidebar, '<StarIcon')).toBe(1)
  })
})

describe('the Favoriter group', () => {
  const sidebar = read('src/components/dashboard/AreaSidebar.tsx')
  const nav = read('src/components/dashboard/DashboardNav.tsx')

  it('is drawn only with a favourite, above the area rows and the settings sections', () => {
    const group = sidebar.indexOf('{favorites && favorites.rows.length > 0 && (')
    const areaRows = sidebar.indexOf('{children ?? (')
    expect(group).toBeGreaterThan(-1)
    expect(areaRows).toBeGreaterThan(group)
  })

  it('is labelled like the other groups and draws its rows with the menu row', () => {
    expect(sidebar).toContain('<p className={NAV_GROUP_LABEL_CLASS}>{favorites.label}</p>')
    expect(sidebar).toContain('<ul>{favorites.rows.map(row)}</ul>')
  })

  it('takes its rows from the gated menu, never from a list of its own', () => {
    expect(nav).toContain("const menuRows = visibleAreas.filter((area) => area.id !== 'byra' || cockpitMode).flatMap(areaItems)")
    expect(nav).toContain('const favoriteRows = resolveFavorites(favorites.stored, menuRows)\n    .map(toRow)\n    .filter((row) => row.enabled)')
  })
})

describe('the stored favourites reach every shell', () => {
  it('each sidebar the dashboard layout renders is handed the stored list', () => {
    const layout = read('src/app/(dashboard)/layout.tsx')
    const shells = count(layout, '<DashboardNav\n')
    expect(shells).toBeGreaterThan(0)
    expect(count(layout, 'navFavorites={navFavorites}')).toBe(shells)
  })
})
