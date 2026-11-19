import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { PAID_PLAN_ONLY_CAPABILITIES, TRIAL_CAPABILITIES } from '@/lib/entitlements/keys'

/**
 * crm#1502: a trial user could not find anywhere that the trial does NOT turn
 * into a paid plan by itself. The trial is a set of capability grants seeded at
 * company creation, not a Stripe subscription, so nothing renews: only a
 * checkout the owner starts creates a subscription. The trial chip and the top
 * of Inställningar -> Abonnemang now say so.
 */

const navSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'nav' })
const navEn = createTranslator({ locale: 'en', messages: en, namespace: 'nav' })
const billSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'settings_billing' })
const billEn = createTranslator({ locale: 'en', messages: en, namespace: 'settings_billing' })

describe('trial end copy', () => {
  it('the trial chip says the trial ends in the free plan, in both locales', () => {
    expect(navSv('trial_then_free')).toBe('Sedan gratis, inget dras automatiskt')
    expect(navEn('trial_then_free')).toBe('Then free, nothing is charged automatically')
  })

  it('the billing page states that nothing is charged without an own subscription', () => {
    const text = billSv('trial_end_free_note')
    expect(text).toContain('När provperioden slutar fortsätter du gratis.')
    expect(text).toContain('Inget dras om du inte själv startar ett abonnemang.')
    expect(text).toContain('bokföring, fakturor och rapporter fortsätter som vanligt')
    const textEn = billEn('trial_end_free_note')
    expect(textEn).toContain('When the trial ends you continue for free.')
    expect(textEn).toContain('Nothing is charged unless you start a subscription yourself.')
  })

  it('the trial grants only paid capabilities that pause at its end, none plan-only', () => {
    // Every trial capability is a paid one that pauses at trial end; none is
    // plan-only, so the trial never implies a plan the user did not pick.
    expect(PAID_PLAN_ONLY_CAPABILITIES).toEqual([])
    expect(TRIAL_CAPABILITIES.length).toBeGreaterThan(0)
  })

  it('the billing page shows the note only while a trial runs and nothing covers the company', () => {
    const src = readFileSync(
      join(__dirname, '../../settings/sections/BillingSettingsContent.tsx'),
      'utf8',
    )
    expect(src).toMatch(
      /selling && daysLeft !== null && daysLeft > 0 && \(\s*<p[^>]*>\{t\('trial_end_free_note'\)\}<\/p>/,
    )
  })

  it('the chip shows the sub-line only on the running countdown, never on a lapsed pill', () => {
    const src = readFileSync(join(__dirname, '../SubscriptionTouchpoint.tsx'), 'utf8')
    expect(src).toContain("const sublabel = showCountdown && !lapsed ? tNav('trial_then_free') : null")
  })
})
