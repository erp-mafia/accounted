import { describe, expect, it } from 'vitest'
import { BANK_CONNECT_RETURN_QUERY_PARAMS, parseBankConnectReturn, stripBankConnectReturn } from '../return-link'

const params = (query: string) => new URLSearchParams(query)

describe('parseBankConnectReturn', () => {
  it('reads the reminder link as a plain resume, and nothing when no connection is named', () => {
    expect(parseBankConnectReturn(params('bank_connect=c-1'))).toEqual({ connectionId: 'c-1', returned: null, renew: false })
    expect(parseBankConnectReturn(params('other=1'))).toBeNull()
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

describe('stripBankConnectReturn', () => {
  it('removes every return parameter and keeps the rest of the URL', () => {
    expect(BANK_CONNECT_RETURN_QUERY_PARAMS).toEqual(['bank_connect', 'state', 'result', 'code', 'renew'])
    expect(stripBankConnectReturn('https://app.accounted.se/onboarding/books?station=bank&bank_connect=c-1&state=c-1&result=ok&code=#top')).toBe('/onboarding/books?station=bank#top')
    expect(stripBankConnectReturn('https://app.accounted.se/settings/connections?bank_connect=c-1')).toBe('/settings/connections')
    expect(stripBankConnectReturn('https://app.accounted.se/settings/connections?bank_connect=c-1&renew=1')).toBe('/settings/connections')
  })
})
