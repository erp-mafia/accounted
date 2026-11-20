import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import OpeningBalanceResultStep from '../OpeningBalanceResultStep'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const result = {
  success: true,
  journal_entry_id: 'je-1',
  fiscal_period_id: 'fp-1',
  lines_created: 19,
  total_debit: 1029555.88,
  total_credit: 1029555.88,
}

function render(props: Partial<ComponentProps<typeof OpeningBalanceResultStep>>, locale: 'sv' | 'en' = 'sv'): string {
  const step = createElement(OpeningBalanceResultStep, { result, onNewImport: () => {}, ...props })
  return renderToString(createElement(IntlProvider, { locale, messages: locale === 'en' ? en : sv, timeZone: 'Europe/Stockholm' }, step))
}

// crm#1374: the IB detour from a SIE preview set the file aside and nothing
// led back, so the year kept its IB and never got the file's vouchers.
describe('OpeningBalanceResultStep: back to the SIE import', () => {
  it.each([['sv', sv], ['en', en]] as const)('offers to continue the SIE import when the user came from one (%s)', (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: 'import' })
    const html = render({ onResumeSieImport: () => {} }, locale)
    expect(html).toContain(t('ob_result_resume_sie'))
    expect(html).toContain(t('ob_result_resume_sie_hint'))
    expect(html).not.toContain('Nästa steg')
  })

  it('keeps the plain next steps when the IB was entered on its own', () => {
    const t = createTranslator({ locale: 'sv', messages: sv, namespace: 'import' })
    const html = render({})
    expect(html).toContain('Nästa steg')
    expect(html).not.toContain(t('ob_result_resume_sie'))
  })
})
