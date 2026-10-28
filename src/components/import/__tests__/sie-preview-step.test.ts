import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import type { ImportPreview } from '@/lib/import/types'
import SIEPreviewStep from '../SIEPreviewStep'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const preview: ImportPreview = {
  companyName: 'Exempel AB',
  orgNumber: null,
  fiscalYearStart: '2026-01-01',
  fiscalYearEnd: '2026-12-31',
  accountCount: 480,
  voucherCount: 12,
  transactionLineCount: 40,
  openingBalanceTotal: 0,
  trialBalance: { totalDebit: 0, totalCredit: 0, isBalanced: true },
  mappingStatus: { total: 480, mapped: 480, unmapped: 0, lowConfidence: 0 },
  excludedSystemAccounts: [],
  issues: [],
}

function render(props: Partial<ComponentProps<typeof SIEPreviewStep>>, locale: 'sv' | 'en' = 'sv'): string {
  const step = createElement(SIEPreviewStep, {
    preview,
    issues: [],
    missingAccounts: [],
    onCreateAccounts: async () => {},
    isCreatingAccounts: false,
    onContinue: () => {},
    onBack: () => {},
    ...props,
  })
  return renderToString(createElement(IntlProvider, { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' }, step))
}

// #63: a provider's export carries its whole chart in #KONTO.
describe('SIEPreviewStep: only the accounts the file uses', () => {
  it.each([['sv', sv], ['en', en]] as const)('offers the switch with how many accounts the file uses (%s)', (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: 'import' })
    const html = render({ onlyUsedAccounts: { on: false, onChange: () => {}, unused: 430, own: 5, total: 480 } }, locale)
    expect(html).toContain(t('only_used_accounts_label'))
    // The company's own unused accounts are kept, so they are not counted as left out.
    expect(html).toContain(t('only_used_accounts_hint', { used: 45, total: 480 }))
    expect(html).toContain('id="sie-only-used-accounts"')
  })

  // Users flipped the switch up to 20 times in 30 s: its only effect was a
  // count in the Kontoplan row above. The line under the label now changes.
  it.each([['sv', sv], ['en', en]] as const)('says what the switch does in its current position (%s)', (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: 'import' })
    const off = render({ onlyUsedAccounts: { on: false, onChange: () => {}, unused: 430, own: 5, total: 480 } }, locale)
    const on = render({ onlyUsedAccounts: { on: true, onChange: () => {}, unused: 430, own: 5, total: 480 } }, locale)
    const offLine = t('only_used_accounts_state_off', { unused: 430 })
    const onLine = t('only_used_accounts_state_on', { unused: 430 })
    expect(offLine).not.toBe(onLine)
    expect(off).toContain(offLine)
    expect(off).not.toContain(onLine)
    expect(on).toContain(onLine)
    expect(on).not.toContain(offLine)
    // The switch names the line, and a screen reader hears it change.
    expect(on).toContain('aria-describedby="sie-only-used-accounts-state"')
    expect(on).toMatch(/id="sie-only-used-accounts-state" aria-live="polite"/)
  })

  it('reads the one-account case in the singular', () => {
    const t = createTranslator({ locale: 'sv', messages: sv, namespace: 'import' })
    expect(t('only_used_accounts_state_on', { unused: 1 })).toContain('1 oanvänt BAS-konto läggs')
    expect(t('only_used_accounts_state_off', { unused: 1 })).toContain('Det oanvända BAS-kontot')
  })

  it('shows no switch when the file uses every account it defines', () => {
    const html = render({})
    expect(html).not.toContain('sie-only-used-accounts')
  })
})
