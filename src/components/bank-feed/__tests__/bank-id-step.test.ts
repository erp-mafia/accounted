import { describe, expect, it } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { BankIdStep } from '../steps/BankIdStep'
import { BANK_GUIDE_URLS } from '../bank-help'
import { flowReducer, openFlow, type FlowAction, type FlowBank, type FlowState } from '../connect-flow-reducer'
import type { ConnectionAttempt } from '../open-payments-client'

const IntlProvider = NextIntlClientProvider as (
  props: Omit<ComponentProps<typeof NextIntlClientProvider>, 'children'>,
) => ReturnType<typeof NextIntlClientProvider>

const noop = () => {}

const HANDELSBANKEN: FlowBank = { bic: 'HANDSESS', name: 'Handelsbanken' }
/** A bank we hold no prerequisite and no guide for. */
const OTHER_BANK: FlowBank = { bic: 'ELLFSESS', name: 'Länsförsäkringar Bank' }

function attempt(overrides: Partial<ConnectionAttempt> = {}): ConnectionAttempt {
  return { authorisation_id: 'auth-1', method: 'qr', state: 'pending', challenge: null, sca_status: 'started', step: 'identify', failure_code: null, failure_text: null, ...overrides }
}

/** The flow at its BankID step, as the bank answered the start. */
function started(bank: FlowBank, answer: Partial<ConnectionAttempt> = {}): FlowState {
  const actions: FlowAction[] = [
    { type: 'bank_picked', bank },
    { type: 'to_bankid' },
    { type: 'started', result: { connection_id: 'c-1', attempt: attempt(answer) } },
  ]
  return actions.reduce(flowReducer, openFlow('new'))
}

function refused(bank: FlowBank, code: string): FlowState {
  return started(bank, { state: 'failed', failure_code: code })
}

function render(state: FlowState, props: Partial<ComponentProps<typeof BankIdStep>> = {}, messages: typeof sv = sv) {
  return renderToString(
    createElement(
      IntlProvider,
      { locale: messages === sv ? 'sv' : 'en', messages, timeZone: 'Europe/Stockholm' },
      createElement(BankIdStep, {
        state,
        dispatch: noop,
        signerKnown: true,
        personalNumberInvalid: false,
        asksPsuAuthoriserId: false,
        psuAuthoriserIdInvalid: false,
        secondsLeft: null,
        approach: 'decoupled',
        mobile: false,
        bankName: state.bank?.name ?? '',
        onStart: noop,
        onRestart: noop,
        onSignAsSignatory: noop,
        onContinueToBank: noop,
        onImportFile: noop,
        closeButton: null,
        ...props,
      }),
    ),
  )
}

const IMPORT_LINK_SV = 'importera kontoutdrag som fil'

describe('BankIdStep: a refused BankID says what to do next', () => {
  it('shows the reason, the bank\'s prerequisite, its guide and the way to bank file import', () => {
    const html = render(refused(HANDELSBANKEN, 'PSU_OPEN_BANKING_RIGHTS_MISSING'))
    expect(html).toContain(sv.bankFeed.failure.PSU_OPEN_BANKING_RIGHTS_MISSING)
    expect(html).toContain(sv.bank_connect.help_handelsbanken)
    expect(html).toContain(`href="${BANK_GUIDE_URLS.HANDSESS}"`)
    expect(html).toContain('Guide: så förbereder du Handelsbanken')
    expect(html).toContain(IMPORT_LINK_SV)
    // The bank's code is one the person fixes in the online bank: no Försök igen.
    expect(html).not.toContain(sv.bank_connect.try_again)
  })

  it('says it in English to an English reader', () => {
    const html = render(refused(HANDELSBANKEN, 'PSU_OPEN_BANKING_RIGHTS_MISSING'), {}, en)
    expect(html).toContain(en.bank_connect.help_handelsbanken)
    expect(html).toContain('import statements as a file')
    expect(html).not.toContain(IMPORT_LINK_SV)
  })

  it('keeps Försök igen for a refusal that trying again can pass, with the same lines under it', () => {
    const html = render(refused(HANDELSBANKEN, 'AUTHENTICATION_SESSION_EXPIRED'))
    expect(html).toContain(sv.bankFeed.failure.AUTHENTICATION_SESSION_EXPIRED)
    expect(html).toContain(sv.bank_connect.try_again)
    expect(html).toContain(sv.bank_connect.help_handelsbanken)
    expect(html).toContain(IMPORT_LINK_SV)
  })

  it('shows only the file import for a bank with no prerequisite and no guide', () => {
    const html = render(refused(OTHER_BANK, 'KYC_INVALID'))
    expect(html).toContain(sv.bankFeed.failure.KYC_INVALID)
    expect(html).toContain(IMPORT_LINK_SV)
    expect(html).not.toContain('openpayments.io/integrera')
    for (const key of ['help_handelsbanken', 'help_nordea', 'help_swedbank'] as const) expect(html).not.toContain(sv.bank_connect[key])
  })

  it('gives SCA_FAILED no sentence of its own: the generic line, then the way on', () => {
    expect(sv.bankFeed.failure).not.toHaveProperty('SCA_FAILED')
    const html = render(refused(OTHER_BANK, 'SCA_FAILED'))
    expect(html).toContain(sv.bankFeed.failure_generic)
    expect(html).toContain(IMPORT_LINK_SV)
  })

  it('offers no file import where the entry point has none (the signatory page), and keeps what concerns the bank', () => {
    const html = render(refused(HANDELSBANKEN, 'PSU_OPEN_BANKING_RIGHTS_MISSING'), { onImportFile: undefined })
    expect(html).not.toContain(IMPORT_LINK_SV)
    expect(html).toContain(sv.bank_connect.help_handelsbanken)
    expect(html).toContain(`href="${BANK_GUIDE_URLS.HANDSESS}"`)
  })

  it('shows none of it while the BankID is running', () => {
    const html = render(started(HANDELSBANKEN))
    expect(html).not.toContain(sv.bank_connect.help_handelsbanken)
    expect(html).not.toContain('openpayments.io/integrera')
    expect(html).not.toContain(IMPORT_LINK_SV)
  })
})

/** The flow at its BankID step before the start: the ways in are offered. */
function beforeStart(bank: FlowBank): FlowState {
  const actions: FlowAction[] = [{ type: 'bank_picked', bank }, { type: 'to_bankid' }]
  return actions.reduce(flowReducer, openFlow('new'))
}

/** The rendered buttons as their text, and which one is the filled primary. */
function waysIn(html: string): { filled: string[]; outline: string[] } {
  const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map(([, cls, inner]) => ({
    cls,
    // The text between the tags (and React's <!-- --> separators): the parts
    // outside every tag, joined. Rendered test markup, not untrusted input.
    text: inner.split(/<!-- -->|<[^>]*>/).join('').trim(),
  }))
  return {
    filled: buttons.filter((b) => b.cls.includes('bg-primary/88')).map((b) => b.text),
    outline: buttons.filter((b) => b.cls.includes('shadow-raised')).map((b) => b.text),
  }
}

describe('BankIdStep: the way in this device can use leads', () => {
  it('on a computer: the QR is the filled button and BankID on this device the other, as before', () => {
    const { filled, outline } = waysIn(render(beforeStart(HANDELSBANKEN), { mobile: false }))
    expect(filled).toEqual([sv.bank_connect.method_qr])
    expect(outline).toEqual([sv.bank_connect.method_same_device])
  })

  it('on a phone: BankID on this device is the filled button, and the QR is offered for another device', () => {
    const { filled, outline } = waysIn(render(beforeStart(HANDELSBANKEN), { mobile: true }))
    expect(filled).toEqual([sv.bank_connect.method_same_device])
    expect(outline).toEqual([sv.bank_connect.method_qr_other_device])
  })

  it('says it in English on an English phone', () => {
    const { filled, outline } = waysIn(render(beforeStart(HANDELSBANKEN), { mobile: true }, en))
    expect(filled).toEqual([en.bank_connect.method_same_device])
    expect(outline).toEqual([en.bank_connect.method_qr_other_device])
  })
})
