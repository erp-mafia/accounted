import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BANK_FILE_IMPORT_PATH, switchDeepLink } from '@/lib/bank-feed/switch-link'
import type { BankSwitchProgressView } from '../open-payments-client'

const { fetchBankSwitchProgress } = vi.hoisted(() => ({ fetchBankSwitchProgress: vi.fn() }))
vi.mock('../open-payments-client', () => ({ fetchBankSwitchProgress }))

const { closedRenewalDestination, closedRenewalHref } = await import('../closed-renewal')

type Progress = Pick<BankSwitchProgressView, 'campaign' | 'company'>

const campaign = (on: boolean): Progress['campaign'] => ({ on, deadline: on ? '2026-12-31' : null, days_left: on ? 35 : null, passed: false })
// The company's own campaign state; only whether there is one matters here.
const applies = {} as NonNullable<Progress['company']>

const swedbank = { id: 'conn-1', bank_name: 'Swedbank' }
const wise = { id: 'conn-2', bank_name: 'Wise' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('closedRenewalHref (the transactions page renewal while the switch campaign is on)', () => {
  it('leaves the renewal alone while renewals are open, or when the campaign could not be read', () => {
    expect(closedRenewalHref({ campaign: campaign(false), company: null }, swedbank)).toBeNull()
    expect(closedRenewalHref(null, swedbank)).toBeNull()
  })

  it('sends a renewal to the switch where the campaign applies and the new provider reaches the bank', () => {
    expect(closedRenewalHref({ campaign: campaign(true), company: applies }, swedbank)).toBe(switchDeepLink('conn-1'))
  })

  it('sends a renewal to the bank file import where the switch cannot be made', () => {
    expect(closedRenewalHref({ campaign: campaign(true), company: applies }, wise)).toBe(BANK_FILE_IMPORT_PATH)
    expect(closedRenewalHref({ campaign: campaign(true), company: null }, swedbank)).toBe(BANK_FILE_IMPORT_PATH)
  })
})

describe('closedRenewalDestination', () => {
  it('reads the company\'s campaign when the renewal is clicked and routes by it', async () => {
    fetchBankSwitchProgress.mockResolvedValueOnce({ campaign: campaign(true), company: applies })
    await expect(closedRenewalDestination(swedbank)).resolves.toBe(switchDeepLink('conn-1'))
    fetchBankSwitchProgress.mockResolvedValueOnce({ campaign: campaign(false), company: null })
    await expect(closedRenewalDestination(swedbank)).resolves.toBeNull()
    expect(fetchBankSwitchProgress).toHaveBeenCalledTimes(2)
  })

  it('rejects when the campaign cannot be read, so the caller runs the renewal', async () => {
    fetchBankSwitchProgress.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(closedRenewalDestination(swedbank)).rejects.toThrow('Unavailable')
  })
})
