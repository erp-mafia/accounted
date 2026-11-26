import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import { BankPickStep } from '../steps/BankPickStep'
import { flowReducer, openFlow, type FlowAction, type FlowState } from '../connect-flow-reducer'
import type { OpenPaymentsBank, OpenPaymentsBankDetails } from '../open-payments-client'

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

describe('BankPickStep: the office or sparbank picker (for #158)', () => {
  const RESURS: OpenPaymentsBank = { bic: 'RESUSE2H', name: 'Resurs Bank', logo_url: null, decoupled: false, redirect: true, reached: true }
  const SWEDBANK: OpenPaymentsBank = { bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: false, reached: true }
  const OFFICE = { id: 'office-1', name: 'Kontor Ett' }
  const details = (bank: OpenPaymentsBank, affiliates: OpenPaymentsBankDetails['affiliates']): OpenPaymentsBankDetails => ({
    bic: bank.bic,
    name: bank.name,
    decoupled: bank.decoupled,
    redirect: bank.redirect,
    affiliates,
    transaction_history_max_days: null,
    extended_transaction_history_max_days: null,
  })
  const flow = (bank: OpenPaymentsBank, ...actions: FlowAction[]): FlowState =>
    [{ type: 'bank_picked', bank: { bic: bank.bic, name: bank.name, decoupled: bank.decoupled, redirect: bank.redirect } } as FlowAction, ...actions].reduce(flowReducer, openFlow('new'))
  // The rows of the picker's own listbox (the bank list above has options of its own).
  const options = (html: string) => {
    const picker = html.split('aria-labelledby="bank-connect-affiliate-label"')[1] ?? ''
    return [...picker.matchAll(/role="option"[^>]*>(?:<[^>]*>)*([^<]*)</g)].map((m) => m[1])
  }
  const selected = (html: string) => {
    const picker = html.split('aria-labelledby="bank-connect-affiliate-label"')[1] ?? ''
    return [...picker.matchAll(/role="option" aria-selected="(true|false)"/g)].map((m) => m[1] === 'true')
  }
  const continueDisabled = (html: string) => /<button[^>]*disabled=""[^>]*>(?:<[^>]*>)*Fortsätt</.test(html)

  it('lists only the offices of a bank that needs one, under "Vilket kontor?", and waits for a choice', () => {
    const loaded = flow(RESURS, { type: 'bank_details_loaded', details: details(RESURS, [OFFICE, { id: 'office-2', name: 'Kontor Två' }]) })
    const html = render({ state: loaded, banks: [RESURS], banksFailed: false })
    expect(html).toContain(sv.bank_connect.office_label)
    expect(html).not.toContain(sv.bank_connect.affiliate_label)
    expect(options(html)).toEqual(['Kontor Ett', 'Kontor Två'])
    expect(continueDisabled(html)).toBe(true)

    const chosen = flowReducer(loaded, { type: 'affiliate_picked', affiliate: OFFICE })
    expect(continueDisabled(render({ state: chosen, banks: [RESURS], banksFailed: false }))).toBe(false)
  })

  it('keeps Swedbank as the first row and the default under "Vilken sparbank?"', () => {
    // As the provider answers: Swedbank itself is among the banks behind its BIC (08999).
    const loaded = flow(SWEDBANK, { type: 'bank_details_loaded', details: details(SWEDBANK, [{ id: '08111', name: 'Sparbanken Nord' }, { id: '08999', name: 'Swedbank' }]) })
    const html = render({ state: loaded, banks: [SWEDBANK], banksFailed: false })
    expect(html).toContain(sv.bank_connect.affiliate_label)
    expect(html).not.toContain(sv.bank_connect.office_label)
    expect(options(html)).toEqual(['Swedbank', 'Sparbanken Nord', 'Swedbank'])
    expect(selected(html)).toEqual([true, false, false])
    expect(continueDisabled(html)).toBe(false)
  })
})
