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
      'attest',
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

  it('in byrå scope: personal sections only, the brand section for owners and admins', () => {
    const member = { hasCompany: true, byraScope: true, byraRole: 'member' as const, hasMcpExtension: true }
    expect(ids(member)).toEqual(['account', 'security', 'team', 'api'])
    expect(ids({ ...member, byraRole: 'owner' })).toEqual(['account', 'security', 'team', 'brand', 'api'])
  })

  it('in byrå scope: API och MCP shows (a connection is the person\'s, not the open company\'s), still filed under tools', () => {
    const member = { hasCompany: true, byraScope: true, byraRole: 'member' as const, hasMcpExtension: true }
    expect(visibleSettingsSections(member).find((s) => s.id === 'api')).toEqual({
      id: 'api',
      href: '/settings/api',
      group: 'tools',
    })
    // Same gates as inside a company: the MCP extension, and a company to connect.
    expect(ids({ ...member, hasMcpExtension: false })).not.toContain('api')
    expect(ids({ ...member, hasCompany: false })).not.toContain('api')
    // Every other tools section stays company-scoped.
    expect(ids(member)).not.toContain('connections')
  })

  it('maps a section id to its settings_nav key', () => {
    expect(settingsMessageKey('fiscal-years')).toBe('fiscal_years')
    expect(settingsMessageKey('bookkeeping')).toBe('bookkeeping')
  })
})
