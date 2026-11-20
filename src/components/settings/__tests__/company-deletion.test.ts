import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADD_COMPANY_HREF,
  addCompanyHref,
  afterCompanyDeleteHref,
} from '@/components/settings/company-deletion'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
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
 * ADD_COMPANY_HREF is the picker door behind "Lägg till företag". Every place
 * that renders the link takes this user's href from the company context
 * (addCompanyHref, set by the dashboard layout) and falls back to the
 * constant, so moving that door fails here instead of sending an owner who
 * just deleted the wrong company to a dead page.
 */
describe('ADD_COMPANY_HREF', () => {
  it('is the door "Lägg till företag" opens', () => {
    for (const file of [
      'components/dashboard/CompanySwitcher.tsx',
      'components/dashboard/UserMenu.tsx',
      'components/settings/sections/CompanySettingsContent.tsx',
    ]) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8')
      expect(source, file).toMatch(/import \{[^}]*\bADD_COMPANY_HREF\b[^}]*\} from '@\/components\/settings\/company-deletion'/)
      expect(source, file).toMatch(/addCompanyHref = ADD_COMPANY_HREF \} = useCompany\(\)/)
      expect(source, file).toMatch(/href=\{addCompanyHref\}/)
      expect(source, file).not.toContain('/select-company?choose=1')
    }
    // ⌘K hands the context's href to actionEntries, which falls back to the constant.
    const palette = fs.readFileSync(path.join(SRC, 'components/common/CommandPalette.tsx'), 'utf8')
    expect(palette).toMatch(/href: addCompany\.href \?\? ADD_COMPANY_HREF/)
    expect(palette).toMatch(/href: addCompanyHref \}/)
    // The layout sets the context value on every provider it renders.
    const layout = fs.readFileSync(path.join(SRC, 'app/(dashboard)/layout.tsx'), 'utf8')
    expect(layout.match(/addCompanyHref: companyAddHref/g)).toHaveLength(3)
    expect(layout.match(/<CompanyProvider/g)).toHaveLength(3)
  })

  it('is a page the middleware keeps open for a user with no company', () => {
    const middleware = fs.readFileSync(path.join(SRC, 'lib/supabase/middleware.ts'), 'utf8')
    const pathname = ADD_COMPANY_HREF.split('?')[0]
    expect(middleware).toContain(`pathname.startsWith('${pathname}')`)
    expect(fs.existsSync(path.join(SRC, 'app/(onboarding)', pathname, 'page.tsx'))).toBe(true)
  })
})

// I30: the picker door redirects to the journey when it has nothing to show,
// a visible extra hop. The layout links the journey directly in that case.
describe('addCompanyHref', () => {
  const role = (overrides: Partial<EnrichmentCompanyRole> = {}): EnrichmentCompanyRole => ({
    companyId: 1,
    companyRegistrationNumber: '5569999990',
    legalName: 'Exempel AB',
    legalEntityType: 'Aktiebolag',
    positionTypes: ['boardMember'],
    positionDescriptions: ['Styrelseledamot'],
    positionStart: '2015-01-01',
    positionEnd: null,
    ...overrides,
  })

  it('opens the journey directly for an account with no BankID engagements', () => {
    expect(addCompanyHref(null, [])).toBe('/onboarding')
    expect(addCompanyHref(null, ['5560125790'])).toBe('/onboarding')
    expect(addCompanyHref([], ['5560125790'])).toBe('/onboarding')
  })

  it('keeps the picker when it has a company to offer', () => {
    expect(addCompanyHref([role()], [])).toBe(ADD_COMPANY_HREF)
    expect(addCompanyHref([role(), role({ companyId: 2, companyRegistrationNumber: '5569999991' })], ['5569999990'])).toBe(ADD_COMPANY_HREF)
  })

  it('opens the journey when every engagement is already added, ended or ceased', () => {
    expect(addCompanyHref([role()], ['556999-9990'])).toBe('/onboarding')
    expect(addCompanyHref([role({ positionEnd: '2020-01-01' })], [])).toBe('/onboarding')
    expect(addCompanyHref([role({ companyStatus: 'CompanyStruckOff' })], [])).toBe('/onboarding')
  })

  it('keeps the picker, which decides for itself, when the read failed', () => {
    expect(addCompanyHref(undefined, [])).toBe(ADD_COMPANY_HREF)
  })
})
