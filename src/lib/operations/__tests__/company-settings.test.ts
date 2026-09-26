/**
 * How the settings surface is split across the settings operations
 * (src/lib/operations/company-settings.ts). The split is what keeps a plain
 * settings.update from regenerating tax deadlines and keeps the lock date
 * behind a high-risk door.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import { TAX_RELEVANT_FIELDS } from '@/lib/tax/deadline-generator'
import {
  BOOKKEEPING_LOCK_FIELDS,
  GENERAL_SETTINGS_FIELDS,
  TAX_PROFILE_FIELDS,
  settingsUpdate,
  settingsUpdateBookkeepingLock,
  settingsUpdateTaxProfile,
  toSettingsResource,
} from '../company-settings'

const keys = (schema: unknown) => Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape)

/** Dashboard fields no settings operation writes, and why. */
const NOT_ON_THE_API: Record<string, string> = {
  entity_type: 'legal identity, fixed at company creation',
  org_number: 'legal identity, fixed once onboarding is complete',
  default_our_reference: 'exposed as contact_person',
  ai_flow_enabled: 'column dropped in 20260504120000_remove_ai_subsystem',
  preferred_payment_format: 'payroll: PATCH /salary/settings',
  salary_pay_day: 'payroll: PATCH /salary/settings',
  salary_default_bank: 'payroll: PATCH /salary/settings',
  salary_net_rounding: 'payroll: PATCH /salary/settings',
  salary_calculation_policy: 'payroll: PATCH /salary/settings (merged, not replaced)',
  salary_deviation_period: 'payroll: PATCH /salary/settings',
}

describe('settings operations: field split', () => {
  it('puts every tax-relevant field the API writes in the tax profile, never in settings.update', () => {
    const general = keys(settingsUpdate.input)
    for (const field of TAX_RELEVANT_FIELDS) {
      expect(general, field).not.toContain(field)
      if (field !== 'entity_type') expect(TAX_PROFILE_FIELDS as readonly string[], field).toContain(field)
    }
  })

  it('keeps the lock fields out of every door but the lock', () => {
    for (const field of BOOKKEEPING_LOCK_FIELDS) {
      expect(keys(settingsUpdate.input), field).not.toContain(field)
      expect(keys(settingsUpdateTaxProfile.input), field).not.toContain(field)
      expect(keys(settingsUpdateBookkeepingLock.input), field).toContain(field)
    }
  })

  it('accounts for every dashboard field: one door each, or a stated reason for none', () => {
    const doors = [...GENERAL_SETTINGS_FIELDS, ...TAX_PROFILE_FIELDS, ...BOOKKEEPING_LOCK_FIELDS] as string[]
    expect(new Set(doors).size).toBe(doors.length)
    for (const field of Object.keys(UpdateSettingsSchema.shape)) {
      expect(doors.includes(field) || field in NOT_ON_THE_API, field).toBe(true)
    }
  })
})

describe('settings resource: the org number of an enskild firma', () => {
  it('masks the last four digits when the org number is a personnummer', () => {
    const resource = toSettingsResource('c1', { entity_type: 'enskild_firma', org_number: '198501011234' } as never)
    expect(resource.org_number).toBe('19850101XXXX')
  })

  it('treats an unknown legal form as a person', () => {
    const resource = toSettingsResource('c1', { entity_type: null, org_number: '8501011234' } as never)
    expect(resource.org_number).toBe('850101XXXX')
  })

  it("returns a legal person's org number as it is: it is public", () => {
    const resource = toSettingsResource('c1', { entity_type: 'aktiebolag', org_number: '5566778899' } as never)
    expect(resource.org_number).toBe('5566778899')
  })
})
