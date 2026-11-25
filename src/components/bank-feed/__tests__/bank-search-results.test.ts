import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'
import { commonBanks } from '../bank-help'
import { actionsForAffiliateResult, flowBankFromList, foldForSearch, nameMatchesQuery, searchBankRows, sparbankParent, standsForSparbanker, type SparbankGroup } from '../bank-search-results'
import { flowReducer, openFlow, type FlowAction, type FlowState } from '../connect-flow-reducer'
import type { OpenPaymentsBank, OpenPaymentsBankDetails } from '../open-payments-client'

const bank = (bic: string, name: string, extra: Partial<OpenPaymentsBank> = {}): OpenPaymentsBank => ({ bic, name, logo_url: null, decoupled: true, redirect: false, reached: true, ...extra })

const SWEDBANK = bank('SWEDSESS', 'Swedbank')
const SEB = bank('ESSESESS', 'SEB')
const NORDEA = bank('NDEASESS', 'Nordea')
const BANKS = [NORDEA, SWEDBANK, SEB]
const BJURSAS = { id: '08201', name: 'Bjursås Sparbank' }
const DALSLAND = { id: '08202', name: 'Dalslands Sparbank' }
const SWEDBANK_AFFILIATE = { id: '08999', name: 'Swedbank' }
const GROUP: SparbankGroup = { parent: SWEDBANK, affiliates: [DALSLAND, SWEDBANK_AFFILIATE, BJURSAS] }

function run(state: FlowState, ...actions: FlowAction[]): FlowState {
  return actions.reduce(flowReducer, state)
}

describe('nameMatchesQuery', () => {
  it('matches any part of the name, ignoring case and diacritics', () => {
    expect(nameMatchesQuery('Bjursås Sparbank', 'bjur')).toBe(true)
    expect(nameMatchesQuery('Bjursås Sparbank', 'BJURSAS')).toBe(true)
    expect(nameMatchesQuery('Bjursås Sparbank', 'bank')).toBe(true)
    expect(nameMatchesQuery('Länsförsäkringar Bank', 'lansforsak')).toBe(true)
    expect(nameMatchesQuery('Bjursås Sparbank', 'dalsland')).toBe(false)
  })

  it('matches everything for an empty query', () => {
    expect(nameMatchesQuery('Nordea', '   ')).toBe(true)
    expect(foldForSearch('  Åre   Sparbank ')).toBe('are sparbank')
  })
})

describe('searchBankRows', () => {
  it('is the banks as before, popular first, without sparbanker, for an empty query', () => {
    const rows = searchBankRows(BANKS, GROUP, '')
    expect(rows.every((r) => r.kind === 'bank')).toBe(true)
    expect(rows.map((r) => (r.kind === 'bank' ? r.bank.name : ''))).toEqual(['Swedbank', 'SEB', 'Nordea'])
  })

  it('finds a savings bank by part of its name', () => {
    const rows = searchBankRows(BANKS, GROUP, 'bjur')
    expect(rows).toEqual([{ kind: 'affiliate', parent: SWEDBANK, affiliate: BJURSAS }])
  })

  it('lists banks first, then the matching sparbanker alphabetically, and not the parent a second time', () => {
    const rows = searchBankRows(BANKS, GROUP, 'bank')
    const names = rows.map((r) => (r.kind === 'bank' ? r.bank.name : r.affiliate.name))
    expect(names).toEqual(['Swedbank', 'Bjursås Sparbank', 'Dalslands Sparbank'])
  })

  it('finds the banks alone when the sparbanker are not known', () => {
    expect(searchBankRows(BANKS, null, 'bjur')).toEqual([])
    expect(searchBankRows(BANKS, null, 'sea')).toEqual([])
    expect(searchBankRows(BANKS, null, 'seb')).toEqual([{ kind: 'bank', bank: SEB }])
  })
})

describe('the Swedbank row', () => {
  it('is the entry behind the shared BIC, whatever the case or branch suffix', () => {
    expect(sparbankParent(BANKS)).toBe(SWEDBANK)
    expect(standsForSparbanker({ bic: 'swedsess' })).toBe(true)
    expect(standsForSparbanker({ bic: 'SWEDSESSXXX' })).toBe(true)
    expect(standsForSparbanker(SEB)).toBe(false)
  })

  it('has its label in both languages, and the bank keeps its own name for the provider', () => {
    expect(sv.bank_connect.bank_swedbank_and_sparbanker).toBe('Swedbank och sparbankerna')
    expect(en.bank_connect.bank_swedbank_and_sparbanker).toBe('Swedbank and the savings banks')
    expect(flowBankFromList(SWEDBANK).name).toBe('Swedbank')
  })
})

describe('choosing a sparbank result', () => {
  const DETAILS: OpenPaymentsBankDetails = { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: false, affiliates: [BJURSAS, DALSLAND, SWEDBANK_AFFILIATE], transaction_history_max_days: 88, extended_transaction_history_max_days: 760 }

  it('ends in the state of choosing Swedbank and then the savings bank in the dialog', () => {
    const viaResult = run(openFlow('new'), ...actionsForAffiliateResult(SWEDBANK, BJURSAS))
    const viaDialog = run(openFlow('new'), { type: 'bank_picked', bank: flowBankFromList(SWEDBANK) }, { type: 'affiliate_picked', affiliate: BJURSAS })
    expect(viaResult).toEqual(viaDialog)
    expect(viaResult.bank?.bic).toBe('SWEDSESS')
    expect(viaResult.affiliate).toEqual(BJURSAS)
  })

  it('keeps the savings bank when the bank details arrive afterwards', () => {
    const state = run(openFlow('new'), ...actionsForAffiliateResult(SWEDBANK, BJURSAS), { type: 'bank_details_loaded', details: DETAILS })
    expect(state.affiliate).toEqual(BJURSAS)
  })

  it('replaces an earlier choice of another bank', () => {
    const state = run(openFlow('new'), { type: 'bank_picked', bank: flowBankFromList(SEB) }, ...actionsForAffiliateResult(SWEDBANK, DALSLAND))
    expect(state.bank?.bic).toBe('SWEDSESS')
    expect(state.affiliate).toEqual(DALSLAND)
  })
})

describe('opening the dialog with a bank chosen', () => {
  it('ends in the state of picking that bank inside the dialog', () => {
    for (const b of [SWEDBANK, SEB]) {
      const opened = openFlow('new', { bank: flowBankFromList(b) })
      const picked = run(openFlow('new'), { type: 'bank_picked', bank: flowBankFromList(b) })
      expect(opened).toEqual(picked)
      expect(opened.step).toBe('bank')
      expect(opened.bankLocked).toBe(false)
    }
  })

  it('can still pick another bank, and a sparbank behind Swedbank', () => {
    const opened = openFlow('new', { bank: flowBankFromList(SWEDBANK) })
    expect(run(opened, { type: 'affiliate_picked', affiliate: BJURSAS }).affiliate).toEqual(BJURSAS)
    expect(run(opened, { type: 'bank_picked', bank: flowBankFromList(SEB) }).bank?.bic).toBe('ESSESESS')
  })
})

describe('commonBanks', () => {
  const list = [
    bank('LFBASESS', 'Länsförsäkringar Bank'),
    bank('DABASESX', 'Danske Bank'),
    bank('NDEASESS', 'Nordea'),
    bank('HANDSESS', 'Handelsbanken'),
    bank('ESSESESS', 'SEB'),
    bank('SEBKSESS', 'SEB Kort Bank'),
    bank('SWEDSESS', 'Swedbank'),
    bank('ICABSESS', 'ICA Banken'),
  ]

  it('lists them in the order Swedbank, SEB, Handelsbanken, Nordea, Danske Bank, Länsförsäkringar, one per name', () => {
    expect(commonBanks(list).map((b) => b.name)).toEqual(['Swedbank', 'SEB', 'Handelsbanken', 'Nordea', 'Danske Bank', 'Länsförsäkringar Bank'])
  })

  it('leaves out a bank the list does not carry, one we cannot sign at and one the provider does not reach', () => {
    const some = [bank('NDEASESS', 'Nordea'), bank('ESSESESS', 'SEB', { decoupled: false, redirect: false }), bank('HANDSESS', 'Handelsbanken', { reached: false }), bank('SWEDSESS', 'Swedbank')]
    expect(commonBanks(some).map((b) => b.name)).toEqual(['Swedbank', 'Nordea'])
  })

  it('is empty when the list has none of them', () => {
    expect(commonBanks([bank('ICABSESS', 'ICA Banken')])).toEqual([])
    expect(commonBanks([])).toEqual([])
  })
})
