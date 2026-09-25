import { describe, it, expect, vi } from 'vitest'
import sv from '@/messages/sv.json'

vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  findCompanyTokenUser: vi.fn(),
  hasVerifiedGrant: vi.fn(),
}))
vi.mock('@/extensions/general/skatteverket/lib/system-auth/config', () => ({
  getSystemAuthMode: vi.fn(),
  isSystemAuthConfigured: vi.fn(),
}))

import { SKV_NEEDS_RECONSENT_MESSAGE } from '../skv-connection-health'

describe('SKV_NEEDS_RECONSENT_MESSAGE', () => {
  it('sends the user to the real settings path: Skatteverket lives under Kopplingar', () => {
    // Agents relay this to the user verbatim. "Inställningar → Skatteverket"
    // named a rail entry that no longer exists (the connection moved under
    // Kopplingar, lib/navigation/settings-sections.ts SETTINGS_SECTION_PARENT).
    const nav = sv.nav as Record<string, string>
    const settingsNav = sv.settings_nav as Record<string, string>
    expect(SKV_NEEDS_RECONSENT_MESSAGE).toContain(
      `${nav.settings} → ${settingsNav.connections} → ${settingsNav.skatteverket}`,
    )
  })
})
