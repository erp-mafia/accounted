/**
 * The archive dialog on Exportera says where a migration is started over:
 * Gör om migrering, in the Riskzon at the foot of the company settings page
 * (CompanyDangerZone). It sent people to "Inställningar > Företag > Allmänt",
 * names the settings menu no longer shows. The path is checked against the
 * real menu (the assistant's menu trail for /settings/company, built from
 * settings-sections.ts and the rail's labels) and the zone's own labels, so
 * a renamed or moved page fails here instead of reaching a user as a dead
 * direction.
 */
import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { loadUiLabels, menuTrail } from '@/lib/agent/ask/ui-map'
import { gateContext } from '@/lib/agent/ask/__tests__/ui-fixture'

describe('the archive dialog names the way to Gör om migrering as the app shows it', () => {
  it.each([
    ['sv', sv],
    ['en', en],
  ] as const)('%s', async (locale, messages) => {
    const trail = menuTrail('/settings/company', { ctx: gateContext(), labels: await loadUiLabels(locale) })
    expect(trail).not.toBeNull()
    const zone = messages.settings_company
    const description = messages.import.archive_dialog_description

    expect(description).toContain([...trail!, zone.danger_heading].join(' → '))
    expect(description).toContain(zone.reset_row_label)
  })
})
