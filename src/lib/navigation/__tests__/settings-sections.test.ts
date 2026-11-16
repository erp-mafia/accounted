import { describe, it, expect } from 'vitest'
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTION_PARENT,
  SETTINGS_SECTIONS_IN_AGENTS,
  settingsMessageKey,
  visibleSettingsSections,
} from '../settings-sections'

const ids = (scope: Parameters<typeof visibleSettingsSections>[0]) => visibleSettingsSections(scope).map((s) => s.id)

describe('visibleSettingsSections', () => {
  it('inside a company: every company section, API only with the MCP extension, no byrå sections', () => {
    const scope = { hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: false }
    expect(ids(scope)).toEqual([
      'account',
      'security',
      'company',
      'anpassa',
      'members',
      'billing',
      'bookkeeping',
      'fiscal-years',
      'tax',
      'salary',
      'attest',
      'templates',
      'invoicing',
      'sending',
      'collections',
      'connections',
      'data-sharing',
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
    expect(ids(member)).not.toContain('data-sharing')
  })

  it('maps a section id to its settings_nav key', () => {
    expect(settingsMessageKey('fiscal-years')).toBe('fiscal_years')
    expect(settingsMessageKey('bookkeeping')).toBe('bookkeeping')
  })

  it('groups the sidebar as the V7 shell does: the company first, then Du, then Byrå', () => {
    expect(SETTINGS_GROUP_ORDER).toEqual(['company', 'accounting', 'sales', 'tools', 'account', 'byra'])
    const owner = { hasCompany: true, byraScope: true, byraRole: 'owner' as const, hasMcpExtension: true }
    const group = (id: string) => visibleSettingsSections(owner).find((s) => s.id === id)?.group
    expect(group('team')).toBe('byra')
    expect(group('brand')).toBe('byra')
    expect(group('account')).toBe('account')
    const company = { hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: true }
    expect(visibleSettingsSections(company).find((s) => s.id === 'collections')).toEqual({
      id: 'collections',
      href: '/settings/collections',
      group: 'sales',
    })
  })

  it('keeps every hub child pointing at a section that exists', () => {
    const company = { hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: true }
    const sections = new Set(ids(company))
    for (const [child, hub] of Object.entries(SETTINGS_SECTION_PARENT)) {
      expect(sections.has(hub), `${child} -> ${hub}`).toBe(true)
      expect(sections.has(child), `${child} has a row of its own and a hub`).toBe(false)
    }
    // Koppla en agent (Agenter) opens the API section; the Inställningar sidebar leaves it to that area.
    expect([...SETTINGS_SECTIONS_IN_AGENTS].every((id) => sections.has(id))).toBe(true)
  })
})

describe('the invoicing-only role', () => {
  it('is listed its own account and no section that would send it back to Fakturor', () => {
    expect(ids({ hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: true, role: 'invoicer' })).toEqual(['account'])
  })

  it('changes nothing for the other roles, or when the role is not known', () => {
    const scope = { hasCompany: true, byraScope: false, byraRole: null, hasMcpExtension: true }
    for (const role of ['owner', 'admin', 'member', 'viewer', null, undefined]) {
      expect(ids({ ...scope, role })).toEqual(ids(scope))
    }
  })
})
