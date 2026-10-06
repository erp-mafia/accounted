import { describe, it, expect } from 'vitest'
import { settingsMessageKey, visibleSettingsSections } from '../settings-sections'

const ids = (scope: Parameters<typeof visibleSettingsSections>[0]) => visibleSettingsSections(scope).map((s) => s.id)

describe('visibleSettingsSections', () => {
  it('inside a company: every company section, API only with the MCP extension, no byrå sections', () => {
    const scope = { hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: false }
    expect(ids(scope)).toEqual([
      'account',
      'security',
      'company',
      'members',
      'billing',
      'bookkeeping',
      'fiscal-years',
      'tax',
      'salary',
      'templates',
      'invoicing',
      'sending',
      'connections',
    ])
    expect(ids({ ...scope, hasMcpExtension: true })).toContain('api')
  })

  it('in byrå scope: account-level sections only, the brand section for owners and admins', () => {
    const member = { hasCompany: true, byraScope: true, byraRole: 'member' as const, hasMcpExtension: true }
    expect(ids(member)).toEqual(['account', 'security', 'team'])
    expect(ids({ ...member, byraRole: 'owner' })).toEqual(['account', 'security', 'team', 'brand'])
  })

  it('maps a section id to its settings_nav key', () => {
    expect(settingsMessageKey('fiscal-years')).toBe('fiscal_years')
    expect(settingsMessageKey('bookkeeping')).toBe('bookkeeping')
  })
})
