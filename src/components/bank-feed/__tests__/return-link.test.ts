import { describe, expect, it } from 'vitest'
import {
  BANK_CONNECT_RETURN_QUERY_PARAMS,
  parseBankConnectNew,
  parseBankConnectReturn,
  preselectedBank,
  stripBankConnectReturn,
} from '../return-link'

const params = (query: string) => new URLSearchParams(query)

describe('parseBankConnectReturn', () => {
  it('reads the reminder link as a plain resume, and nothing when no connection is named', () => {
    expect(parseBankConnectReturn(params('bank_connect=c-1'))).toEqual({ connectionId: 'c-1', returned: null, renew: false })
    expect(parseBankConnectReturn(params('other=1'))).toBeNull()
  })

  it('never resumes "new": that link belongs to parseBankConnectNew', () => {
    expect(parseBankConnectReturn(params('bank_connect=new'))).toBeNull()
    expect(parseBankConnectReturn(params('bank_connect=new&bic=SWEDSESS'))).toBeNull()
  })

  it('reads the renewal mail\'s link as a renewal, never as a return from the bank', () => {
    expect(parseBankConnectReturn(params('bank_connect=c-1&renew=1'))).toEqual({ connectionId: 'c-1', returned: null, renew: true })
    expect(parseBankConnectReturn(params('bank_connect=c-1&renew=1&result=error&code=X'))).toEqual({ connectionId: 'c-1', returned: null, renew: true })
    expect(parseBankConnectReturn(params('bank_connect=c-1&renew=yes'))).toEqual({ connectionId: 'c-1', returned: null, renew: false })
    expect(parseBankConnectReturn(params('renew=1'))).toBeNull()
  })

  it('reads the bank\'s return with its result and code, and takes state only together with a result', () => {
    expect(parseBankConnectReturn(params('bank_connect=c-1&state=c-1&result=ok'))).toEqual({ connectionId: 'c-1', returned: { result: 'ok', code: null }, renew: false })
    expect(parseBankConnectReturn(params('state=c-1&result=error&code=signing_session_psu_cancelled'))).toEqual({
      connectionId: 'c-1',
      returned: { result: 'error', code: 'SIGNING_SESSION_PSU_CANCELLED' },
      renew: false,
    })
    // Another flow's OAuth state names no connection.
    expect(parseBankConnectReturn(params('state=abc'))).toBeNull()
    // An unknown result is a plain resume; a code without an error is dropped.
    expect(parseBankConnectReturn(params('bank_connect=c-1&result=maybe&code=X'))).toEqual({ connectionId: 'c-1', returned: null, renew: false })
    expect(parseBankConnectReturn(params('bank_connect=c-1&result=ok&code=X'))).toEqual({ connectionId: 'c-1', returned: { result: 'ok', code: null }, renew: false })
    expect(parseBankConnectReturn(params('bank_connect=c-1&result=error'))).toEqual({ connectionId: 'c-1', returned: { result: 'error', code: null }, renew: false })
  })
})

describe('parseBankConnectNew', () => {
  it('reads the agent\'s connect link with its bank, upper-cased, and nothing for any other link', () => {
    expect(parseBankConnectNew(params('bank_connect=new&bic=SWEDSESS'))).toEqual({ bic: 'SWEDSESS' })
    expect(parseBankConnectNew(params('bank_connect=new&bic=essesess'))).toEqual({ bic: 'ESSESESS' })
    expect(parseBankConnectNew(params('bank_connect=new&bic=HANDSESS123'))).toEqual({ bic: 'HANDSESS123' })
    expect(parseBankConnectNew(params('bank_connect=c-1&bic=SWEDSESS'))).toBeNull()
    expect(parseBankConnectNew(params('bic=SWEDSESS'))).toBeNull()
    expect(parseBankConnectNew(params('other=1'))).toBeNull()
  })

  it('opens the picker, not nothing, when the bic is missing or malformed', () => {
    expect(parseBankConnectNew(params('bank_connect=new'))).toEqual({ bic: null })
    expect(parseBankConnectNew(params('bank_connect=new&bic='))).toEqual({ bic: null })
    expect(parseBankConnectNew(params('bank_connect=new&bic=Handelsbanken'))).toEqual({ bic: null })
    expect(parseBankConnectNew(params('bank_connect=new&bic=SWED'))).toEqual({ bic: null })
    expect(parseBankConnectNew(params('bank_connect=new&bic=SWED-SESS'))).toEqual({ bic: null })
  })
})

describe('preselectedBank', () => {
  const banks = [
    { bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: false },
    { bic: 'ESSESESS', name: 'SEB', logo_url: null, decoupled: null, redirect: true },
  ]

  it('hands the flow the picker\'s bank option for a known BIC', () => {
    expect(preselectedBank('ESSESESS', banks)).toEqual({ bic: 'ESSESESS', name: 'SEB', decoupled: null, redirect: true })
  })

  it('leaves the picker open for an unknown BIC, no BIC, or a list not loaded yet', () => {
    expect(preselectedBank('NDEASESS', banks)).toBeNull()
    expect(preselectedBank(null, banks)).toBeNull()
    expect(preselectedBank('SWEDSESS', null)).toBeNull()
  })
})

describe('stripBankConnectReturn', () => {
  it('removes every return parameter and keeps the rest of the URL', () => {
    expect(BANK_CONNECT_RETURN_QUERY_PARAMS).toEqual(['bank_connect', 'state', 'result', 'code', 'renew', 'bic'])
    expect(stripBankConnectReturn('https://app.accounted.se/onboarding/books?station=bank&bank_connect=c-1&state=c-1&result=ok&code=#top')).toBe('/onboarding/books?station=bank#top')
    expect(stripBankConnectReturn('https://app.accounted.se/settings/connections?bank_connect=c-1')).toBe('/settings/connections')
    expect(stripBankConnectReturn('https://app.accounted.se/settings/connections?bank_connect=c-1&renew=1')).toBe('/settings/connections')
    expect(stripBankConnectReturn('https://app.accounted.se/settings/connections?bank_connect=new&bic=SWEDSESS')).toBe('/settings/connections')
  })
})
