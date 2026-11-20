import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_DELETION_HASH,
  ACCOUNT_DELETION_HREF,
  ACCOUNT_DELETION_PATH,
  NO_COMPANY_DASHBOARD_PATHS,
  isNoCompanyDashboardPath,
} from '@/lib/company/no-company-routes'

const SRC = path.resolve(__dirname, '../../..')

describe('isNoCompanyDashboardPath', () => {
  it('lets the delete-account page and Profil through', () => {
    expect(isNoCompanyDashboardPath(ACCOUNT_DELETION_PATH)).toBe(true)
    expect(isNoCompanyDashboardPath('/settings/account')).toBe(true)
  })

  it('keeps every company page closed', () => {
    for (const pathname of ['/', '/settings', '/settings/company', '/invoices', '/settings/securityx']) {
      expect(isNoCompanyDashboardPath(pathname)).toBe(false)
    }
  })

  it('links to the deletion page itself', () => {
    expect(ACCOUNT_DELETION_HREF).toBe(`${ACCOUNT_DELETION_PATH}#${ACCOUNT_DELETION_HASH}`)
    expect(NO_COMPANY_DASHBOARD_PATHS).toContain(ACCOUNT_DELETION_PATH)
  })
})

/**
 * The drift that caused crm#1042: the delete-account action moved from Profil
 * to Säkerhet (#3010) while every no-company door still named Profil. Pin the
 * path to the page that actually renders the action, so moving it again
 * fails here instead of stranding company-less users.
 */
describe('ACCOUNT_DELETION_PATH', () => {
  function importedSections(file: string): string[] {
    const source = fs.readFileSync(file, 'utf8')
    return [...source.matchAll(/from '@\/components\/settings\/sections\/([A-Za-z]+)'/g)].map(
      (match) => path.join(SRC, 'components/settings/sections', `${match[1]}.tsx`),
    )
  }

  it('is the settings page that renders AccountDangerZone', () => {
    const page = path.join(SRC, 'app/(dashboard)', ACCOUNT_DELETION_PATH, 'page.tsx')
    expect(fs.existsSync(page)).toBe(true)

    const rendersAction = [page, ...importedSections(page)].some((file) =>
      fs.readFileSync(file, 'utf8').includes('<AccountDangerZone'),
    )
    expect(rendersAction).toBe(true)
  })
})
