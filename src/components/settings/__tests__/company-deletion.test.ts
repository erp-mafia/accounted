import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADD_COMPANY_HREF,
  afterCompanyDeleteHref,
} from '@/components/settings/company-deletion'
import { ACCOUNT_DELETION_HREF } from '@/lib/company/no-company-routes'

const SRC = path.resolve(__dirname, '../../..')

// Where the owner lands after deleting a company. The same dialog has two
// doors, and the door decides what the delete was for.
describe('afterCompanyDeleteHref', () => {
  it('leads on to adding the right company from the wrong-company door', () => {
    // Whatever is left: the owner came to replace this company, not to leave.
    expect(afterCompanyDeleteHref('wrong_company', null)).toBe(ADD_COMPANY_HREF)
    expect(afterCompanyDeleteHref('wrong_company', 'company-2')).toBe(ADD_COMPANY_HREF)
    expect(afterCompanyDeleteHref('wrong_company', undefined)).toBe(ADD_COMPANY_HREF)
  })

  it('lands on the delete-account action after the last company, from the danger zone (crm#1042)', () => {
    expect(afterCompanyDeleteHref('danger_zone', null)).toBe(ACCOUNT_DELETION_HREF)
  })

  it('stays in settings from the danger zone when another company is left', () => {
    expect(afterCompanyDeleteHref('danger_zone', 'company-2')).toBe('/settings/account')
  })

  it('never reads a failed resolution as "no companies left"', () => {
    expect(afterCompanyDeleteHref('danger_zone', undefined)).toBe('/settings/account')
  })
})

/**
 * ADD_COMPANY_HREF is a copy of the link behind "Lägg till företag". Pin it to
 * the switcher and the user menu, so moving that door fails here instead of
 * sending an owner who just deleted the wrong company to a dead page.
 */
describe('ADD_COMPANY_HREF', () => {
  it('is the door "Lägg till företag" opens', () => {
    expect(fs.readFileSync(path.join(SRC, 'components/dashboard/CompanySwitcher.tsx'), 'utf8')).toContain(`href="${ADD_COMPANY_HREF}"`)
    // The user menu, the Företag settings page and ⌘K link the constant itself.
    for (const file of [
      'components/dashboard/UserMenu.tsx',
      'components/settings/sections/CompanySettingsContent.tsx',
      'components/common/CommandPalette.tsx',
    ]) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8')
      expect(source, file).toMatch(/import \{[^}]*\bADD_COMPANY_HREF\b[^}]*\} from '@\/components\/settings\/company-deletion'/)
      expect(source, file).toMatch(/href(=\{|: )ADD_COMPANY_HREF/)
    }
  })

  it('is a page the middleware keeps open for a user with no company', () => {
    const middleware = fs.readFileSync(path.join(SRC, 'lib/supabase/middleware.ts'), 'utf8')
    const pathname = ADD_COMPANY_HREF.split('?')[0]
    expect(middleware).toContain(`pathname.startsWith('${pathname}')`)
    expect(fs.existsSync(path.join(SRC, 'app/(onboarding)', pathname, 'page.tsx'))).toBe(true)
  })
})
