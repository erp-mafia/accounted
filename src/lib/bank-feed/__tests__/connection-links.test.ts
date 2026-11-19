import { describe, expect, it } from 'vitest'
import { chooseAccountsHref, isOpenPaymentsRow, renewOpenPaymentsHref } from '../connection-links'

describe('connection links', () => {
  it('finishes an Open Payments row in Koppla banken and an Enable Banking row in its own picker', () => {
    expect(chooseAccountsHref({ id: 'op-1', aggregator: 'open_payments' })).toBe('/settings/banking?bank_connect=op-1')
    expect(chooseAccountsHref({ id: 'eb-1', aggregator: 'enable_banking' })).toBe('/settings/banking?select_accounts=eb-1')
    // A row read before the aggregator column was selected is an Enable Banking one.
    expect(chooseAccountsHref({ id: 'old' })).toBe('/settings/banking?select_accounts=old')
  })

  it('renews an Open Payments row through the flow\'s renew link', () => {
    expect(renewOpenPaymentsHref({ id: 'op 1' })).toBe('/settings/banking?bank_connect=op%201&renew=1')
    expect(isOpenPaymentsRow({ aggregator: 'open_payments' })).toBe(true)
    expect(isOpenPaymentsRow({ aggregator: null })).toBe(false)
  })
})
