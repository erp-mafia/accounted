import { describe, expect, it } from 'vitest'
import { flowReducer, openFlow, pollingActive, stepAfterActivation, type FlowState } from '../connect-flow-reducer'
import type { BankIdChallenge, ConnectionAttempt, ConnectionPoll, ConnectionView, PolledAccount } from '../open-payments-client'

const SWEDBANK = { bic: 'SWEDSESS', name: 'Swedbank' }

const QR: BankIdChallenge = { approach: 'decoupled', autostartToken: 'tok', qrData: 'bankid.frame-1', qrImage: null, redirectUrl: null }

function attempt(overrides: Partial<ConnectionAttempt> = {}): ConnectionAttempt {
  return { authorisation_id: 'auth-1', method: 'qr', state: 'pending', challenge: QR, sca_status: 'started', step: 'identify', failure_code: null, failure_text: null, ...overrides }
}

function poll(overrides: Partial<ConnectionPoll> = {}): ConnectionPoll {
  return { connection_id: 'c-1', state: 'pending', method: 'qr', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null, status: 'pending', ...overrides }
}

function view(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    connection_id: 'c-1',
    bank_name: 'Swedbank',
    bic: 'SWEDSESS',
    provider: 'open_payments',
    status: 'active',
    consent_expires: '2027-01-10',
    last_synced_at: null,
    initial_sync_completed_at: null,
    error_message: null,
    accounts: [],
    ...overrides,
  }
}

function account(overrides: Partial<PolledAccount> = {}): PolledAccount {
  return {
    uid: 'a1',
    iban: 'SE45',
    bban: null,
    name: 'Företagskonto',
    currency: 'SEK',
    usage: 'ORGA',
    preselected: true,
    enabled: true,
    suggested_ledger_account: '1930',
    matches_existing: null,
    ...overrides,
  }
}

function run(state: FlowState, ...actions: Parameters<typeof flowReducer>[1][]): FlowState {
  return actions.reduce(flowReducer, state)
}

describe('openFlow', () => {
  it('a switch starts on the intro with the old bank locked; a new connection starts at the bank list', () => {
    const switching = openFlow('switch', { bank: SWEDBANK, replaceConnectionId: 'old' })
    expect(switching.step).toBe('intro')
    expect(switching.bankLocked).toBe(true)
    expect(switching.replaceConnectionId).toBe('old')
    expect(flowReducer(switching, { type: 'bank_picked', bank: { bic: 'ESSESESS', name: 'SEB' } }).bank).toEqual(SWEDBANK)

    const fresh = openFlow('new')
    expect(fresh.step).toBe('bank')
    expect(fresh.bankLocked).toBe(false)
  })

  it('a bank known by name only gets its BIC from the list, or unlocks the list when unknown', () => {
    const renewing = openFlow('renew', { bank: { bic: '', name: 'Swedbank' }, replaceConnectionId: 'old' })
    expect(flowReducer(renewing, { type: 'to_bankid' }).step).toBe('bank')
    const resolved = flowReducer(renewing, { type: 'bank_resolved', bic: 'SWEDSESS' })
    expect(resolved.bank).toEqual(SWEDBANK)
    expect(resolved.bankLocked).toBe(true)
    expect(flowReducer(resolved, { type: 'to_bankid' }).step).toBe('bankid')
    const unknown = flowReducer(renewing, { type: 'bank_resolved', bic: null })
    expect(unknown.bank).toBeNull()
    expect(unknown.bankLocked).toBe(false)
    // A bank that already has its BIC is left alone.
    expect(flowReducer(resolved, { type: 'bank_resolved', bic: 'OTHER' }).bank).toEqual(SWEDBANK)
  })

  it('a resume opens at the BankID step of the named connection and polls at once', () => {
    const resumed = openFlow('resume', { connectionId: 'c-9' })
    expect(resumed.step).toBe('bankid')
    expect(pollingActive(resumed)).toBe(true)
  })
})

describe('the bank step', () => {
  it('picks a bank, an affiliate and a context, and moves on only with a bank', () => {
    const noBank = flowReducer(openFlow('new'), { type: 'to_bankid' })
    expect(noBank.step).toBe('bank')
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'affiliate_picked', id: 'sparbanken-skane' }, { type: 'context_set', context: 'private' })
    expect(picked.bank).toEqual(SWEDBANK)
    expect(picked.affiliateId).toBe('sparbanken-skane')
    expect(picked.context).toBe('private')
    expect(flowReducer(picked, { type: 'to_bankid' }).step).toBe('bankid')
  })

  it('picking another bank drops the affiliate chosen for the first', () => {
    const state = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'affiliate_picked', id: 'x' }, { type: 'bank_picked', bank: { bic: 'ESSESESS', name: 'SEB' } })
    expect(state.affiliateId).toBeNull()
  })
})

describe('the BankID step', () => {
  const atBankId = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'to_bankid' })

  it('a started attempt puts the challenge on screen and begins polling', () => {
    const started = run(atBankId, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })
    expect(started.starting).toBe(false)
    expect(started.connectionId).toBe('c-1')
    expect(started.attempt?.challenge).toEqual(QR)
    expect(started.stepsSeen).toEqual(['identify'])
    expect(pollingActive(started)).toBe(true)
  })

  it('a start the bank refused at once shows the bank\'s text and offers a restart', () => {
    const refused = run(atBankId, { type: 'start' }, {
      type: 'started',
      result: { connection_id: 'c-1', attempt: attempt({ state: 'failed', challenge: null, failure_code: 'PSU_RIGHTS_MISSING', failure_text: 'Behörighet saknas.' }) },
    })
    expect(refused.connectionId).toBe('c-1')
    expect(refused.pollState).toBe('failed')
    expect(refused.failure).toEqual({ code: 'PSU_RIGHTS_MISSING', text: 'Behörighet saknas.' })
    expect(pollingActive(refused)).toBe(false)
  })

  it('a failed start keeps the person on the step with the message', () => {
    const failed = run(atBankId, { type: 'start' }, { type: 'start_failed', message: 'Banken svarade inte' })
    expect(failed.starting).toBe(false)
    expect(failed.startError).toBe('Banken svarade inte')
    expect(pollingActive(failed)).toBe(false)
  })

  const started = run(atBankId, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })

  it('a pending poll without a challenge keeps the QR on screen; a new frame replaces it', () => {
    const kept = flowReducer(started, { type: 'polled', poll: poll({ state: 'pending', step: 'identify' }) })
    expect(kept.attempt?.challenge).toEqual(QR)
    const next = flowReducer(kept, { type: 'polled', poll: poll({ state: 'pending', challenge: { ...QR, qrData: 'bankid.frame-2' }, step: 'identify' }) })
    expect(next.attempt?.challenge?.qrData).toBe('bankid.frame-2')
    expect(next.stepsSeen).toEqual(['identify'])
  })

  it('the consent step after identify counts as a new QR to scan', () => {
    const consent = flowReducer(started, { type: 'polled', poll: poll({ state: 'pending', challenge: { ...QR, qrData: 'consent-1' }, step: 'consent' }) })
    expect(consent.consentStep).toBe('consent')
    expect(consent.stepsSeen).toEqual(['identify', 'consent'])
  })

  it('a valid consent lands on the accounts with the server’s preselection', () => {
    const accounts = [account({ uid: 'orga' }), account({ uid: 'priv', usage: 'PRIV', preselected: false, suggested_ledger_account: null })]
    const valid = flowReducer(started, { type: 'polled', poll: poll({ state: 'valid', accounts, consent_expires: '2027-01-10' }) })
    expect(valid.step).toBe('accounts')
    expect(valid.accounts).toEqual(accounts)
    expect(valid.selection.orga).toEqual({ enabled: true, ledger: '1930' })
    expect(valid.selection.priv).toEqual({ enabled: false, ledger: null })
    expect(valid.consentExpires).toBe('2027-01-10')
    expect(pollingActive(valid)).toBe(false)
  })

  it('a failed consent stops polling and shows the bank’s text; a restart clears it', () => {
    const failed = flowReducer(started, { type: 'polled', poll: poll({ state: 'failed', failure_code: 'USER_CANCEL', failure_text: 'Avbrutet i BankID-appen' }) })
    expect(failed.failure).toEqual({ code: 'USER_CANCEL', text: 'Avbrutet i BankID-appen' })
    expect(pollingActive(failed)).toBe(false)
    const restarted = run(failed, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt({ authorisation_id: 'auth-2' }) } })
    expect(restarted.failure).toBeNull()
    expect(restarted.stepsSeen).toEqual(['identify'])
    expect(pollingActive(restarted)).toBe(true)
  })

  it('a partially authorised consent keeps polling for the second signatory', () => {
    const partial = flowReducer(started, { type: 'polled', poll: poll({ state: 'partially_authorised' }) })
    expect(partial.pollState).toBe('partially_authorised')
    expect(pollingActive(partial)).toBe(true)
    expect(partial.attempt?.challenge).toEqual(QR)
  })
})

describe('the accounts step', () => {
  const accounts = [account({ uid: 'orga' }), account({ uid: 'kept', matches_existing: '1932' })]
  const atAccounts = run(
    openFlow('new'),
    { type: 'bank_picked', bank: SWEDBANK },
    { type: 'to_bankid' },
    { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } },
    { type: 'polled', poll: poll({ state: 'valid', accounts }) },
  )

  it('toggles and ledger picks edit the selection', () => {
    const edited = run(atAccounts, { type: 'account_toggled', uid: 'orga' }, { type: 'ledger_set', uid: 'kept', ledger: '1940' })
    expect(edited.selection.orga.enabled).toBe(false)
    expect(edited.selection.kept.ledger).toBe('1940')
  })

  it('an activation with payments on offer goes to the payments step, otherwise to Klart', () => {
    const connection = view()
    const sync = { imported: 42 }
    const offered = run(atAccounts, { type: 'payments_offer', offered: true, verification: 'invalid', validUntil: null }, { type: 'activate' }, { type: 'activated', connection, sync, syncPending: false })
    expect(offered.step).toBe('payments')
    expect(offered.firstSync).toEqual(sync)
    expect(offered.syncPending).toBe(false)
    expect(offered.connection).toEqual(connection)
    expect(offered.activating).toBe(false)

    const verified = run(atAccounts, { type: 'payments_offer', offered: true, verification: 'valid', validUntil: '2027-05-01' }, { type: 'activated', connection, sync, syncPending: false })
    expect(verified.step).toBe('done')
    const notOffered = run(atAccounts, { type: 'payments_offer', offered: false, verification: null, validUntil: null }, { type: 'activated', connection, sync, syncPending: false })
    expect(notOffered.step).toBe('done')
  })

  it('a first import that runs on in the background is remembered as pending, without a count', () => {
    const pending = run(atAccounts, { type: 'payments_offer', offered: false, verification: null, validUntil: null }, { type: 'activated', connection: view(), sync: null, syncPending: true })
    expect(pending.step).toBe('done')
    expect(pending.firstSync).toBeNull()
    expect(pending.syncPending).toBe(true)
  })

  it('a failed activation stays on the accounts with the message', () => {
    const failed = run(atAccounts, { type: 'activate' }, { type: 'activate_failed', message: 'Kontot 1930 används redan' })
    expect(failed.step).toBe('accounts')
    expect(failed.activating).toBe(false)
    expect(failed.activateError).toBe('Kontot 1930 används redan')
    expect(flowReducer(failed, { type: 'ledger_set', uid: 'orga', ledger: '1940' }).activateError).toBeNull()
  })

  it('Svea: a second consent returns to the BankID step and, once valid, marks the accounts confirmed', () => {
    const second = run(atAccounts, { type: 'activate' }, { type: 'second_consent', attempt: attempt({ authorisation_id: 'auth-2', step: 'consent' }) })
    expect(second.step).toBe('bankid')
    expect(second.secondConsent).toBe(true)
    expect(pollingActive(second)).toBe(true)
    const confirmed = flowReducer(second, { type: 'polled', poll: poll({ state: 'valid' }) })
    expect(confirmed.step).toBe('bankid')
    expect(confirmed.confirmed).toBe(true)
    expect(pollingActive(confirmed)).toBe(false)
    const connection = view({ bank_name: 'Svea Bank', bic: 'SVEASESS', consent_expires: null })
    const live = flowReducer(confirmed, { type: 'activated', connection, sync: { imported: 3 }, syncPending: false })
    expect(live.step).toBe('done')
    expect(live.secondConsent).toBe(false)
    expect(live.confirmed).toBe(false)
  })
})

describe('the payments step', () => {
  it('records the opened form and the polled status, and ends on Klart', () => {
    const base = { ...openFlow('new'), step: 'payments' as const, paymentsOffered: true, verification: 'invalid' as const }
    const opened = flowReducer(base, { type: 'verification_opened', url: 'https://verify.example.se/x' })
    expect(opened.verificationUrl).toBe('https://verify.example.se/x')
    const polled = flowReducer(opened, { type: 'verification_polled', status: 'valid', validUntil: '2027-10-12' })
    expect(polled.verification).toBe('valid')
    expect(polled.verificationUntil).toBe('2027-10-12')
    expect(flowReducer(polled, { type: 'payments_done' }).step).toBe('done')
  })

  it('stepAfterActivation offers payments only when available and unverified', () => {
    expect(stepAfterActivation({ paymentsOffered: true, verification: 'invalid' })).toBe('payments')
    expect(stepAfterActivation({ paymentsOffered: true, verification: 'unknown' })).toBe('payments')
    expect(stepAfterActivation({ paymentsOffered: true, verification: 'valid' })).toBe('done')
    expect(stepAfterActivation({ paymentsOffered: false, verification: null })).toBe('done')
    expect(stepAfterActivation({ paymentsOffered: null, verification: null })).toBe('done')
  })
})
