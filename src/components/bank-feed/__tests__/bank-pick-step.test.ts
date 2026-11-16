import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import { BankPickStep } from '../steps/BankPickStep'
import { openFlow } from '../connect-flow-reducer'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const noop = () => {}

function render(props: Partial<ComponentProps<typeof BankPickStep>>) {
  return renderToString(
    createElement(
      IntlProvider,
      { locale: 'sv', messages: sv, timeZone: 'Europe/Stockholm' },
      createElement(BankPickStep, {
        state: openFlow('new'),
        dispatch: noop,
        banks: null,
        banksFailed: true,
        soleTrader: false,
        onContinue: noop,
        closeButton: null,
        ...props,
      }),
    ),
  )
}

describe('BankPickStep: a bank list that could not load', () => {
  it('says so in place of the list with Försök igen when it can ask again', () => {
    const html = render({ onRetryBanks: noop })
    expect(html).toContain(sv.bank_connect.bank_load_failed_title)
    expect(html).toContain(sv.common.retry)
    expect(html).not.toContain(sv.bank_connect.bank_load_failed)
  })

  it('keeps the close-and-retry line where no retry is wired', () => {
    const html = render({})
    expect(html).toContain(sv.bank_connect.bank_load_failed)
    expect(html).not.toContain(sv.common.retry)
  })
})
