import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * Layout guards for settings, salary, skattekonto and bokslut (UI scan t1108
 * U4). Each one is a phone defect that rendered: a page that scrolled
 * sideways, a save bar under the bottom nav, a title under the actions.
 */
const root = path.resolve(__dirname, '../../../')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('settings, salary and year-end layout', () => {
  it('skattekonto table bleeds exactly the panel padding (16px phone, 24px desktop)', () => {
    const src = read('app/(dashboard)/skattekonto/page.tsx')
    expect(src).toContain('className="-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6"')
    expect(src).not.toMatch(/-mx-5|md:-mx-8|-left-5/)
  })

  it.each([
    'components/settings/SettingsFormWrapper.tsx',
    'components/settings/sections/AttestSettingsContent.tsx',
    'components/settings/sections/PosSalesSettingsContent.tsx',
  ])('%s save bar sticks above the mobile bottom nav', (rel) => {
    const src = read(rel)
    expect(src).toContain('sticky bottom-[var(--bottom-nav-h)]')
    expect(src).not.toContain('sticky bottom-0')
  })

  it.each([
    'app/(dashboard)/salary/page.tsx',
    'components/salary/run/RunHeader.tsx',
    'app/(dashboard)/salary/runs/[id]/employees/[employeeId]/page.tsx',
    'app/(dashboard)/salary/employees/[id]/page.tsx',
  ])('%s top bar wraps its actions on a phone', (rel) => {
    expect(read(rel)).toContain('className="page-header page-header-wrap ')
  })

  it('stock count booking, earlier counts and totals tables scroll inside their section', () => {
    const src = read('components/bokslut/StockCountRegister.tsx')
    expect(src.match(/<div className="space-y-2 overflow-x-auto">/g)?.length).toBe(3)
  })
})
