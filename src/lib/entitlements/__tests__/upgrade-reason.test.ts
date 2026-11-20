import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { CAPABILITY } from '../keys'
import {
  UPGRADE_REASON_PARAM,
  UPGRADE_REASONS,
  billingHref,
  parseUpgradeReason,
} from '../upgrade-reason'

describe('parseUpgradeReason', () => {
  it('accepts a reason on the list', () => {
    expect(parseUpgradeReason('assistant')).toBe('assistant')
  })

  it('shows nothing on a normal visit', () => {
    expect(parseUpgradeReason(undefined)).toBeNull()
    expect(parseUpgradeReason(null)).toBeNull()
    expect(parseUpgradeReason('')).toBeNull()
  })

  it('treats an unknown value as no reason', () => {
    for (const raw of ['bank', 'Assistant', ' assistant', 'assistant ', 'assistant,assistant', '<b>assistant</b>']) {
      expect(parseUpgradeReason(raw)).toBeNull()
    }
  })

  it('does not match names inherited from Object', () => {
    for (const raw of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(parseUpgradeReason(raw)).toBeNull()
    }
  })

  it('ignores a repeated parameter and non-string values', () => {
    expect(parseUpgradeReason(['assistant', 'assistant'])).toBeNull()
    expect(parseUpgradeReason(['assistant'])).toBeNull()
    expect(parseUpgradeReason(1)).toBeNull()
    expect(parseUpgradeReason({ assistant: true })).toBeNull()
  })
})

describe('billingHref', () => {
  it('builds an address the billing page reads back as the same reason', () => {
    for (const reason of Object.keys(UPGRADE_REASONS) as (keyof typeof UPGRADE_REASONS)[]) {
      const url = new URL(billingHref(reason), 'https://app.example')
      expect(url.pathname).toBe('/settings/billing')
      expect(parseUpgradeReason(url.searchParams.get(UPGRADE_REASON_PARAM))).toBe(reason)
    }
  })
})

describe('UPGRADE_REASONS', () => {
  it('ties the assistant to the ai capability', () => {
    expect(UPGRADE_REASONS.assistant.capability).toBe(CAPABILITY.ai)
  })

  it('has its line in both languages', () => {
    const svBilling = sv.settings_billing as Record<string, string>
    const enBilling = en.settings_billing as Record<string, string>
    for (const { messageKey } of Object.values(UPGRADE_REASONS)) {
      expect(svBilling[messageKey]?.length ?? 0).toBeGreaterThan(0)
      expect(enBilling[messageKey]?.length ?? 0).toBeGreaterThan(0)
    }
  })
})
