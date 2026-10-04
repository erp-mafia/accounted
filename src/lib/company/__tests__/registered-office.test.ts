import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import volvoRow from '@/lib/parties/scb/__tests__/fixtures/volvo-je.json'
import { factsFromScbCompany } from '@/lib/parties/scb/map'

const scb = vi.hoisted(() => ({
  configured: false,
  lookupByOrgNumber: vi.fn(),
  createScbClient: vi.fn(),
}))

vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: () => scb.configured,
  scbConfigFromEnv: () => ({ baseUrl: 'https://scb.test', pfx: Buffer.from(''), passphrase: 'x', timeoutMs: 20_000 }),
}))

vi.mock('@/lib/parties/scb/client', () => ({
  createScbClient: scb.createScbClient,
}))

import { registeredOfficeFromRegistry, registeredOfficeFromScbFacts } from '../registered-office'

/** A company whose post goes to another town than the municipality of its seat. */
const SPLIT_ROW = { ...volvoRow, PostOrt: 'MÖLNDAL', 'Säteskommun': 'Göteborg' }

beforeEach(() => {
  vi.clearAllMocks()
  scb.configured = true
  scb.createScbClient.mockReturnValue({ lookupByOrgNumber: scb.lookupByOrgNumber })
  scb.lookupByOrgNumber.mockResolvedValue({
    found: true,
    peOrgNr: '165560125790',
    row: SPLIT_ROW,
    facts: factsFromScbCompany(SPLIT_ROW),
    fetchedAt: '2026-10-03T00:00:00.000Z',
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('registeredOfficeFromScbFacts', () => {
  it("reads SCB's Säteskommun, not the postal town", () => {
    expect(registeredOfficeFromScbFacts(factsFromScbCompany(SPLIT_ROW))).toBe('Göteborg')
  })

  it('is null when SCB gave no seat, even with a postal town', () => {
    const row: Record<string, unknown> = { ...SPLIT_ROW }
    delete row['Säteskommun']
    delete row['Säteskommun, kod']
    delete row['Säteslän']
    delete row['Säteslän, kod']
    expect(registeredOfficeFromScbFacts(factsFromScbCompany(row))).toBeNull()
  })
})

describe('registeredOfficeFromRegistry', () => {
  it('returns the seat municipality for a legal person', async () => {
    await expect(registeredOfficeFromRegistry('5560125790')).resolves.toBe('Göteborg')
    expect(scb.lookupByOrgNumber).toHaveBeenCalledWith('5560125790')
  })

  it('never asks SCB about a personnummer (an enskild firma has no säte)', async () => {
    await expect(registeredOfficeFromRegistry('8501011234')).resolves.toBeNull()
    expect(scb.createScbClient).not.toHaveBeenCalled()
  })

  it('is null without an org number or without SCB credentials', async () => {
    await expect(registeredOfficeFromRegistry(null)).resolves.toBeNull()
    scb.configured = false
    await expect(registeredOfficeFromRegistry('5560125790')).resolves.toBeNull()
    expect(scb.createScbClient).not.toHaveBeenCalled()
  })

  it('is null when SCB has no row for the number', async () => {
    scb.lookupByOrgNumber.mockResolvedValue({ found: false, peOrgNr: '', row: null, facts: [], fetchedAt: '' })
    await expect(registeredOfficeFromRegistry('5560125790')).resolves.toBeNull()
  })

  it('is null, not a throw, when the lookup fails', async () => {
    scb.lookupByOrgNumber.mockRejectedValue(new Error('SCB svarade 500'))
    await expect(registeredOfficeFromRegistry('5560125790')).resolves.toBeNull()
  })

  it('gives up at the deadline so company creation is never held up', async () => {
    vi.useFakeTimers()
    scb.lookupByOrgNumber.mockReturnValue(new Promise(() => {}))
    const pending = registeredOfficeFromRegistry('5560125790', { deadlineMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toBeNull()
  })
})
