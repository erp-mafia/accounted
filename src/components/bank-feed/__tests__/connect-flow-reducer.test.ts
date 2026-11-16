import { describe, expect, it } from 'vitest'
import { bankDetailsSettled, closeOutcome, consentRefused, displayBankName, flowReducer, openFlow, pollingActive, redirectInFlight, removesConnectionOnClose, signingApproach, stepAfterActivation, type FlowState } from '../connect-flow-reducer'
import type { BankIdChallenge, ConnectionAttempt, ConnectionPoll, ConnectionView, OpenPaymentsBankDetails, PolledAccount } from '../open-payments-client'
import { selectionBlocker } from '../account-selection'

const SWEDBANK = { bic: 'SWEDSESS', name: 'Swedbank' }
const SPARBANK = { id: '08999', name: 'Sparbanken Nord' }
const DETAILS: OpenPaymentsBankDetails = { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: false, affiliates: [SPARBANK], transaction_history_max_days: 88, extended_transaction_history_max_days: 760 }
const REDIRECT_BANK = { bic: 'REDIRSES', name: 'Redirect Bank', decoupled: false, redirect: true }
const REDIRECT_CHALLENGE: BankIdChallenge = { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example/sign' }

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
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'affiliate_picked', affiliate: SPARBANK }, { type: 'context_set', context: 'private' })
    expect(picked.bank).toEqual(SWEDBANK)
    expect(picked.affiliate).toEqual(SPARBANK)
    expect(picked.context).toBe('private')
    expect(flowReducer(picked, { type: 'to_bankid' }).step).toBe('bankid')
  })

  it('picking another bank drops the affiliate chosen for the first', () => {
    const state = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'affiliate_picked', affiliate: SPARBANK }, { type: 'bank_picked', bank: { bic: 'ESSESESS', name: 'SEB' } })
    expect(state.affiliate).toBeNull()
  })
})

describe('the sparbank picker', () => {
  it('names the connection after the chosen sparbank, and the bank itself when none is chosen', () => {
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'bank_details_loaded', details: DETAILS })
    expect(picked.bankDetails).toEqual(DETAILS)
    expect(picked.affiliate).toBeNull()
    expect(displayBankName(picked)).toBe('Swedbank')
    const sparbank = flowReducer(picked, { type: 'affiliate_picked', affiliate: SPARBANK })
    expect(displayBankName(sparbank)).toBe('Sparbanken Nord')
    expect(flowReducer(sparbank, { type: 'affiliate_picked', affiliate: null }).affiliate).toBeNull()
    // Picking the same bank again keeps its details; another bank's details are ignored.
    expect(flowReducer(sparbank, { type: 'bank_picked', bank: SWEDBANK }).bankDetails).toEqual(DETAILS)
    expect(flowReducer(openFlow('new'), { type: 'bank_details_loaded', details: DETAILS }).bankDetails).toBeNull()
  })

  it('a renewal of a sparbank connection resolves to Swedbank and finds its sparbank among the affiliates', () => {
    const renewing = run(
      openFlow('renew', { bank: { bic: '', name: 'Sparbanken Nord' }, replaceConnectionId: 'old' }),
      { type: 'bank_resolved', bic: 'SWEDSESS' },
      { type: 'bank_details_loaded', details: DETAILS },
    )
    expect(renewing.affiliate).toEqual(SPARBANK)
    expect(displayBankName(renewing)).toBe('Sparbanken Nord')
  })
})

describe('Continue waits for the bank\'s details (for #208)', () => {
  it('is not settled before a bank is chosen, nor while the chosen bank\'s details are on their way', () => {
    expect(bankDetailsSettled(openFlow('new'))).toBe(false)
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK })
    expect(bankDetailsSettled(picked)).toBe(false)
    // A locked bank named by its row has no BIC yet: nothing to read, nothing settled.
    expect(bankDetailsSettled(openFlow('renew', { bank: { bic: '', name: 'Sparbanken Nord' }, replaceConnectionId: 'old' }))).toBe(false)
  })

  it('is settled once the details of the chosen bank arrived, so its offices are on screen before anything starts', () => {
    const loaded = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'bank_details_loaded', details: DETAILS })
    expect(bankDetailsSettled(loaded)).toBe(true)
    // Another bank is picked: its details are awaited anew.
    expect(bankDetailsSettled(flowReducer(loaded, { type: 'bank_picked', bank: REDIRECT_BANK }))).toBe(false)
  })

  it('a read that failed stops the wait for that bank only: the flow goes on with what the list said', () => {
    const failed = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'bank_details_failed', bic: SWEDBANK.bic })
    expect(bankDetailsSettled(failed)).toBe(true)
    expect(failed.bankDetails).toBeNull()
    expect(bankDetailsSettled(flowReducer(failed, { type: 'bank_picked', bank: REDIRECT_BANK }))).toBe(false)
    // A late failure for a bank no longer chosen settles nothing.
    const late = run(openFlow('new'), { type: 'bank_picked', bank: REDIRECT_BANK }, { type: 'bank_details_failed', bic: SWEDBANK.bic })
    expect(bankDetailsSettled(late)).toBe(false)
  })
})

describe('a bank that signs on its own page', () => {
  it('is known from the list, refined by the details, and starts with the bank\'s page', () => {
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: REDIRECT_BANK }, { type: 'to_bankid' })
    expect(signingApproach(picked)).toBe('redirect')
    expect(signingApproach(run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }))).toBe('decoupled')
    const both = flowReducer(picked, { type: 'bank_details_loaded', details: { ...DETAILS, bic: 'REDIRSES', name: 'Redirect Bank', decoupled: true, redirect: true, affiliates: [] } })
    expect(signingApproach(both)).toBe('both')
    const started = run(picked, { type: 'method_set', method: 'redirect' }, { type: 'start' }, {
      type: 'started',
      result: { connection_id: 'c-1', attempt: attempt({ method: 'redirect', challenge: REDIRECT_CHALLENGE, step: null, sca_status: null }) },
    })
    expect(redirectInFlight(started)).toBe(true)
    expect(started.attempt?.challenge?.redirectUrl).toBe('https://bank.example/sign')
    expect(pollingActive(started)).toBe(true)
    expect(redirectInFlight(run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }))).toBe(false)
  })

  it('an ok return resumes at the BankID step, waiting for the bank, and polls at once', () => {
    const back = openFlow('resume', { connectionId: 'c-1', returned: { result: 'ok', code: null } })
    expect(back.step).toBe('bankid')
    expect(back.method).toBe('redirect')
    expect(back.returned).toEqual({ result: 'ok', code: null })
    expect(back.failure).toBeNull()
    expect(pollingActive(back)).toBe(true)
    const known = flowReducer(back, { type: 'connection_known', bank: { bic: 'REDIRSES', name: 'Redirect Bank' } })
    expect(displayBankName(known)).toBe('Redirect Bank')
    // The row's bank never overrides one already known.
    expect(flowReducer(known, { type: 'connection_known', bank: SWEDBANK }).bank?.name).toBe('Redirect Bank')
    const pending = flowReducer(known, { type: 'polled', poll: poll({ state: 'pending', method: 'redirect', challenge: REDIRECT_CHALLENGE }) })
    expect(redirectInFlight(pending)).toBe(true)
    expect(pollingActive(pending)).toBe(true)
    const valid = flowReducer(pending, { type: 'polled', poll: poll({ state: 'valid', method: 'redirect', accounts: [account()] }) })
    expect(valid.step).toBe('accounts')
  })

  it('a redirect return whose consent lists no account still ends the wait at the accounts step, which says so (crm#1445)', () => {
    const back = openFlow('resume', { connectionId: 'c-1', returned: { result: 'ok', code: null } })
    const valid = flowReducer(back, { type: 'polled', poll: poll({ state: 'valid', method: 'redirect', accounts: [] }) })
    expect(valid.step).toBe('accounts')
    expect(valid.accounts).toEqual([])
    expect(valid.selection).toEqual({})
    expect(selectionBlocker(valid.accounts, valid.selection)).toBe('no_accounts')
    expect(pollingActive(valid)).toBe(false)
  })

  it('an error return shows the bank\'s code with a restart that leaves for the bank again', () => {
    const back = openFlow('resume', { connectionId: 'c-1', returned: { result: 'error', code: 'SIGNING_SESSION_PSU_CANCELLED' } })
    expect(back.pollState).toBe('failed')
    expect(back.failure).toEqual({ code: 'SIGNING_SESSION_PSU_CANCELLED', text: null })
    expect(pollingActive(back)).toBe(false)
    const restarted = run(back, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt({ method: 'redirect', challenge: REDIRECT_CHALLENGE }) } })
    expect(restarted.failure).toBeNull()
    expect(restarted.returned).toBeNull()
    expect(restarted.method).toBe('redirect')
    expect(pollingActive(restarted)).toBe(true)
  })

  it('a redirect start the bank answers with a QR falls into the ordinary BankID step', () => {
    const picked = run(openFlow('new'), { type: 'bank_picked', bank: REDIRECT_BANK }, { type: 'to_bankid' }, { type: 'method_set', method: 'redirect' }, { type: 'start' })
    const started = flowReducer(picked, { type: 'started', result: { connection_id: 'c-1', attempt: attempt({ method: 'qr' }) } })
    expect(started.method).toBe('qr')
    expect(redirectInFlight(started)).toBe(false)
    expect(started.attempt?.challenge).toEqual(QR)
    expect(pollingActive(started)).toBe(true)
  })

  it('a return is only read in resume mode', () => {
    const fresh = openFlow('new', { returned: { result: 'ok', code: null } })
    expect(fresh.returned).toBeNull()
    expect(fresh.method).toBe('qr')
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

  it('the second signatory, resumed from the reminder link, starts their own BankID on the same consent and the QR takes over', () => {
    const waiting = run(openFlow('resume', { connectionId: 'c-1' }), { type: 'polled', poll: poll({ state: 'partially_authorised', method: 'qr' }) })
    expect(waiting.pollState).toBe('partially_authorised')
    expect(waiting.attempt).toBeNull()
    expect(pollingActive(waiting)).toBe(true)
    // Typing the personnummer and pressing Signera som firmatecknare: the poll keeps going while the restart is out.
    const starting = run(waiting, { type: 'personal_number_set', value: '199002092386' }, { type: 'method_set', method: 'qr' }, { type: 'start' })
    expect(starting.starting).toBe(true)
    expect(starting.pollState).toBe('partially_authorised')
    expect(pollingActive(starting)).toBe(true)
    const signing = flowReducer(starting, { type: 'started', result: { connection_id: 'c-1', attempt: attempt({ authorisation_id: 'auth-2', step: 'identify' }) } })
    expect(signing.pollState).toBe('pending')
    expect(signing.attempt?.authorisation_id).toBe('auth-2')
    expect(signing.attempt?.challenge).toEqual(QR)
    expect(signing.personalNumber).toBe('199002092386')
    expect(pollingActive(signing)).toBe(true)
    // Both signatures in: the consent is valid and the accounts step opens as for a first signer.
    const valid = flowReducer(signing, { type: 'polled', poll: poll({ state: 'valid', accounts: [account()] }) })
    expect(valid.step).toBe('accounts')
  })

  it('keeps the Nordea Corporate Netbank logon id the person types, empty at open, and through a start', () => {
    const open = openFlow('resume', { connectionId: 'c-1' })
    expect(open.psuAuthoriserId).toBe('')
    const typed = run(open, { type: 'psu_authoriser_id_set', value: 'second-signer' }, { type: 'start' })
    expect(typed.psuAuthoriserId).toBe('second-signer')
    const started = flowReducer(typed, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })
    expect(started.psuAuthoriserId).toBe('second-signer')
  })
})

// crm#1355: the poll used to retry a refusal forever, so the step kept its
// waiting view over a connection that was gone. The loop now gives up and
// the step says so, with a way on.
describe('a consent poll that gave up', () => {
  const atBankId = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'context_set', context: 'corporate' }, { type: 'to_bankid' }, { type: 'personal_number_set', value: '199001011234' })
  const started = run(atBankId, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })
  const gone = flowReducer(started, { type: 'poll_gave_up', reason: 'refused', text: 'Kopplingen finns inte längre.' })

  it('stops polling and keeps the sentence for the step', () => {
    expect(pollingActive(started)).toBe(true)
    expect(gone.pollError).toEqual({ reason: 'refused', text: 'Kopplingen finns inte längre.' })
    expect(pollingActive(gone)).toBe(false)
  })

  it('Börja om goes back to the BankID start with the bank and the number kept, and the next start makes a new connection', () => {
    const over = flowReducer(gone, { type: 'start_over' })
    expect(over.step).toBe('bankid')
    expect(over.mode).toBe('new')
    expect(over.bank).toEqual(SWEDBANK)
    expect(over.context).toBe('corporate')
    expect(over.personalNumber).toBe('199001011234')
    expect(over.connectionId).toBeNull()
    expect(over.attempt).toBeNull()
    expect(over.pollState).toBeNull()
    expect(over.pollError).toBeNull()
    expect(pollingActive(over)).toBe(false)
    const again = run(over, { type: 'start' }, { type: 'started', result: { connection_id: 'c-2', attempt: attempt() } })
    expect(again.connectionId).toBe('c-2')
    expect(pollingActive(again)).toBe(true)
  })

  it('a renewal keeps the connection it replaces through Börja om', () => {
    const renewing = run(openFlow('renew', { bank: SWEDBANK, replaceConnectionId: 'old' }), { type: 'to_bankid' }, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })
    const over = run(renewing, { type: 'poll_gave_up', reason: 'refused', text: 'x' }, { type: 'start_over' })
    expect(over.mode).toBe('renew')
    expect(over.replaceConnectionId).toBe('old')
    expect(over.bankLocked).toBe(true)
    expect(over.connectionId).toBeNull()
  })

  it('a resumed connection that is gone starts over as a new connection at the bank step', () => {
    const resumed = openFlow('resume', { connectionId: 'gone-1' })
    expect(pollingActive(resumed)).toBe(true)
    const refused = run(resumed, { type: 'payments_offer', offered: true, verification: null }, { type: 'poll_gave_up', reason: 'refused', text: 'x' })
    expect(pollingActive(refused)).toBe(false)
    const over = flowReducer(refused, { type: 'start_over' })
    expect(over.mode).toBe('new')
    expect(over.step).toBe('bank')
    expect(over.connectionId).toBeNull()
    expect(over.bank).toBeNull()
    expect(over.paymentsOffered).toBe(true)
  })

  it('Försök igen after nothing answered polls the same consent again; it does nothing after a refusal', () => {
    const silent = flowReducer(started, { type: 'poll_gave_up', reason: 'unreachable', text: 'Inget svar.' })
    expect(pollingActive(silent)).toBe(false)
    const retried = flowReducer(silent, { type: 'poll_retry' })
    expect(retried.pollError).toBeNull()
    expect(retried.connectionId).toBe('c-1')
    expect(pollingActive(retried)).toBe(true)
    expect(flowReducer(gone, { type: 'poll_retry' })).toBe(gone)
  })

  it('a new start clears the give-up', () => {
    const restarted = run(gone, { type: 'start' })
    expect(restarted.pollError).toBeNull()
  })
})

describe('closing the flow over a running BankID', () => {
  const started = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'context_set', context: 'corporate' }, { type: 'to_bankid' }, { type: 'start' }, {
    type: 'started',
    result: { connection_id: 'c-1', attempt: attempt() },
  })
  const closing = flowReducer(started, { type: 'closing' })

  it('stops the consent poll at once', () => {
    expect(pollingActive(started)).toBe(true)
    expect(closing.closing).toBe(true)
    expect(pollingActive(closing)).toBe(false)
  })

  it('drops an answer that was already on its way', () => {
    expect(flowReducer(closing, { type: 'polled', poll: poll({ state: 'valid', accounts: [account()] }) })).toBe(closing)
    expect(flowReducer(closing, { type: 'polled', poll: poll({ state: 'failed', failure_code: 'x', failure_text: 'y' }) })).toBe(closing)
  })

  it('shows nothing about a refused poll for the connection the close removed', () => {
    const late = flowReducer(closing, { type: 'poll_gave_up', reason: 'refused', text: 'Kopplingen finns inte längre.' })
    expect(late).toBe(closing)
    expect(late.pollError).toBeNull()
  })

  it('a start that answers after the close does not begin a new poll', () => {
    const lateStart = run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'context_set', context: 'corporate' }, { type: 'to_bankid' }, { type: 'start' }, { type: 'closing' }, {
      type: 'started',
      result: { connection_id: 'c-1', attempt: attempt() },
    })
    expect(pollingActive(lateStart)).toBe(false)
  })

  it('a resumed second-signatory flow also stops polling when closed', () => {
    const resumed = openFlow('resume', { connectionId: 'c-1' })
    expect(pollingActive(resumed)).toBe(true)
    expect(pollingActive(flowReducer(resumed, { type: 'closing' }))).toBe(false)
  })

  it('is the same state when closed twice', () => {
    expect(flowReducer(closing, { type: 'closing' })).toBe(closing)
  })
})

describe('removesConnectionOnClose', () => {
  it('a half-made connection goes, a flow with none has nothing to remove', () => {
    expect(removesConnectionOnClose(openFlow('new'))).toBe(false)
    expect(removesConnectionOnClose({ ...openFlow('new'), connectionId: 'c-1' })).toBe(true)
  })

  it('a live connection stays', () => {
    expect(removesConnectionOnClose({ ...openFlow('new'), connectionId: 'c-1', connection: view() })).toBe(false)
  })

  it('a connection resumed for the second signatory stays; one the person came back to from the bank goes', () => {
    expect(removesConnectionOnClose(openFlow('resume', { connectionId: 'c-1' }))).toBe(false)
    expect(removesConnectionOnClose(openFlow('resume', { connectionId: 'c-1', returned: { result: 'ok', code: null } }))).toBe(true)
  })
})

/**
 * A bank's refusal left only Avbryt, which asked "Avbryt kopplingen?
 * BankID-signeringen avbryts" although nothing was running.
 */
describe('closing the flow: what a request to close does', () => {
  const running = run(
    openFlow('new'),
    { type: 'bank_picked', bank: SWEDBANK },
    { type: 'to_bankid' },
    { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } },
  )
  const refused = flowReducer(running, { type: 'polled', poll: poll({ state: 'failed', failure_code: 'PSU_OPEN_BANKING_RIGHTS_MISSING' }) })

  it('asks before closing over a running BankID, a BankID not yet started and an unsaved selection', () => {
    expect(consentRefused(running)).toBe(false)
    expect(closeOutcome(running)).toBe('confirm')
    expect(closeOutcome(run(openFlow('new'), { type: 'bank_picked', bank: SWEDBANK }, { type: 'to_bankid' }))).toBe('confirm')
    const atAccounts = flowReducer(running, { type: 'polled', poll: poll({ state: 'valid', accounts: [account()] }) })
    expect(closeOutcome(atAccounts)).toBe('confirm')
  })

  it('closes at once when the bank has refused, and still removes the half-made connection', () => {
    expect(consentRefused(refused)).toBe(true)
    expect(closeOutcome(refused)).toBe('remove')
    // Refused at the start itself (the attempt came back failed).
    const refusedAtStart = run(
      openFlow('new'),
      { type: 'bank_picked', bank: SWEDBANK },
      { type: 'to_bankid' },
      { type: 'started', result: { connection_id: 'c-1', attempt: attempt({ state: 'failed', failure_code: 'KYC_INVALID' }) } },
    )
    expect(closeOutcome(refusedAtStart)).toBe('remove')
    // Back from the bank's own page with an error: the connection is the person's own and goes.
    expect(closeOutcome(openFlow('resume', { connectionId: 'c-1', returned: { result: 'error', code: 'SCA_FAILED' } }))).toBe('remove')
  })

  it('asks again once Försök igen has a new BankID running', () => {
    const restarted = run(refused, { type: 'start' }, { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } })
    expect(consentRefused(restarted)).toBe(false)
    expect(closeOutcome(restarted)).toBe('confirm')
  })

  it('leaves the first signatory\'s connection alone when the second signatory closes over a refusal', () => {
    const second = flowReducer(openFlow('resume', { connectionId: 'c-1' }), { type: 'polled', poll: poll({ state: 'failed' }) })
    expect(closeOutcome(second)).toBe('close')
  })

  it('just closes where nothing is in flight or the connection is live', () => {
    expect(closeOutcome(openFlow('switch', { bank: SWEDBANK, replaceConnectionId: 'old' }))).toBe('close')
    expect(closeOutcome(openFlow('new'))).toBe('close')
    expect(closeOutcome({ ...running, step: 'payments', connection: view() })).toBe('close')
    expect(closeOutcome({ ...running, step: 'done', connection: view() })).toBe('close')
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

  it('a ticked account takes 1930 from an unticked one the server dealt it to (crm#1701)', () => {
    const soleTrader = [
      account({ uid: 'private', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1930' }),
      account({ uid: 'business', usage: 'PRIV', preselected: false, enabled: false, ledger_kept: false, suggested_ledger_account: '1935' }),
    ]
    const listed = run(
      openFlow('new'),
      { type: 'bank_picked', bank: SWEDBANK },
      { type: 'to_bankid' },
      { type: 'started', result: { connection_id: 'c-1', attempt: attempt() } },
      { type: 'polled', poll: poll({ state: 'valid', accounts: soleTrader }) },
    )
    const ticked = run(listed, { type: 'account_toggled', uid: 'business' })
    expect(ticked.selection.business).toEqual({ enabled: true, ledger: '1930' })
    expect(ticked.selection.private).toEqual({ enabled: false, ledger: '1935' })
  })

  it('an activation with payments on offer goes to the payments step, otherwise to Klart', () => {
    const connection = view()
    const sync = { imported: 42 }
    const offered = run(atAccounts, { type: 'payments_offer', offered: true, verification: { status: 'invalid', valid_until: null, state: 'not_started', link_expires_at: null } }, { type: 'activate' }, { type: 'activated', connection, sync, syncPending: false })
    expect(offered.step).toBe('payments')
    expect(offered.firstSync).toEqual(sync)
    expect(offered.syncPending).toBe(false)
    expect(offered.connection).toEqual(connection)
    expect(offered.activating).toBe(false)

    const verified = run(atAccounts, { type: 'payments_offer', offered: true, verification: { status: 'valid', valid_until: '2027-05-01', state: 'valid', link_expires_at: null } }, { type: 'activated', connection, sync, syncPending: false })
    expect(verified.step).toBe('done')
    const notOffered = run(atAccounts, { type: 'payments_offer', offered: false, verification: null }, { type: 'activated', connection, sync, syncPending: false })
    expect(notOffered.step).toBe('done')
  })

  it('a first import that runs on in the background is remembered as pending, without a count', () => {
    const pending = run(atAccounts, { type: 'payments_offer', offered: false, verification: null }, { type: 'activated', connection: view(), sync: null, syncPending: true })
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
    const opened = flowReducer(base, { type: 'verification_opened', url: 'https://verify.example.se/x', expiresAt: '2026-10-14T09:00:00.000Z', state: 'form_open' })
    expect(opened.verificationUrl).toBe('https://verify.example.se/x')
    expect(opened.verificationState).toBe('form_open')
    expect(opened.verificationLinkExpiresAt).toBe('2026-10-14T09:00:00.000Z')
    const handed = flowReducer(base, { type: 'verification_opened', url: 'https://verify.example.se/y', expiresAt: '2026-10-14T09:00:00.000Z', state: 'awaiting_signatory' })
    expect(handed.verificationState).toBe('awaiting_signatory')
    const polled = flowReducer(opened, { type: 'verification_polled', verification: { status: 'valid', valid_until: '2027-10-12', state: 'valid', link_expires_at: '2026-10-14T09:00:00.000Z' } })
    expect(polled.verificationState).toBe('valid')
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
