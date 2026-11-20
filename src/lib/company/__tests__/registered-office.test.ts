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

import {
  fillRegisteredOfficeFromRegistry,
  registeredOfficeFromRegistry,
  registeredOfficeFromScbFacts,
} from '../registered-office'
import { createTableMockSupabase } from '@/tests/helpers'

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

describe('fillRegisteredOfficeFromRegistry', () => {
  type Row = { registered_office: string | null; org_number: string | null }

  /** company_settings answering the read with `row` and the guarded write with `written`. */
  function settingsTable(row: Row | null, written: Array<{ registered_office: string }> = [{ registered_office: 'Göteborg' }]) {
    const mock = createTableMockSupabase()
    mock.setTable('company_settings', (calls) =>
      calls.some((call) => call.method === 'update') ? { data: written } : { data: row },
    )
    return mock
  }

  const fill = (mock: ReturnType<typeof createTableMockSupabase>) =>
    // @ts-expect-error: the table mock is not typed as a SupabaseClient
    fillRegisteredOfficeFromRegistry(mock.supabase, 'company-1')

  const wrote = (mock: ReturnType<typeof createTableMockSupabase>) =>
    mock.calls.filter((call) => call.method === 'update')

  it('stores the register säte for a company that has none, guarded on the empty value it read', async () => {
    const mock = settingsTable({ registered_office: null, org_number: '556012-5790' })
    await expect(fill(mock)).resolves.toEqual({ status: 'filled', registered_office: 'Göteborg' })
    expect(scb.lookupByOrgNumber).toHaveBeenCalledWith('556012-5790')
    expect(wrote(mock)).toEqual([
      { table: 'company_settings', method: 'update', args: [{ registered_office: 'Göteborg' }] },
    ])
    expect(mock.calls).toContainEqual({ table: 'company_settings', method: 'is', args: ['registered_office', null] })
    // Both the read and the write name the company.
    expect(mock.calls.filter((call) => call.method === 'eq')).toEqual([
      { table: 'company_settings', method: 'eq', args: ['company_id', 'company-1'] },
      { table: 'company_settings', method: 'eq', args: ['company_id', 'company-1'] },
    ])
  })

  it('treats a whitespace-only säte as none and guards the write on that exact value', async () => {
    const mock = settingsTable({ registered_office: '  ', org_number: '5560125790' })
    await expect(fill(mock)).resolves.toEqual({ status: 'filled', registered_office: 'Göteborg' })
    expect(mock.calls).toContainEqual({ table: 'company_settings', method: 'eq', args: ['registered_office', '  '] })
    expect(mock.calls.some((call) => call.method === 'is')).toBe(false)
  })

  it('gives the register no longer than the caller allows, and stores nothing when it has not answered', async () => {
    vi.useFakeTimers()
    scb.lookupByOrgNumber.mockReturnValue(new Promise(() => {}))
    const mock = settingsTable({ registered_office: null, org_number: '5560125790' })
    // @ts-expect-error: the table mock is not typed as a SupabaseClient
    const pending = fillRegisteredOfficeFromRegistry(mock.supabase, 'company-1', { deadlineMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toEqual({ status: 'not_found' })
    expect(wrote(mock)).toEqual([])
  })

  it('never asks the register or writes when the company has a säte', async () => {
    const mock = settingsTable({ registered_office: ' Stockholm ', org_number: '5560125790' })
    await expect(fill(mock)).resolves.toEqual({ status: 'present', registered_office: 'Stockholm' })
    expect(scb.createScbClient).not.toHaveBeenCalled()
    expect(wrote(mock)).toEqual([])
  })

  it('is not_found, with nothing written, when the register has no säte to give', async () => {
    // No settings row.
    let mock = settingsTable(null)
    await expect(fill(mock)).resolves.toEqual({ status: 'not_found' })
    expect(scb.createScbClient).not.toHaveBeenCalled()

    // An enskild firma: its org number is a personnummer, which never reaches the register.
    mock = settingsTable({ registered_office: null, org_number: '8501011234' })
    await expect(fill(mock)).resolves.toEqual({ status: 'not_found' })
    expect(scb.createScbClient).not.toHaveBeenCalled()

    // The register has no row for the number.
    scb.lookupByOrgNumber.mockResolvedValue({ found: false, peOrgNr: '', row: null, facts: [], fetchedAt: '' })
    mock = settingsTable({ registered_office: null, org_number: '5560125790' })
    await expect(fill(mock)).resolves.toEqual({ status: 'not_found' })
    expect(wrote(mock)).toEqual([])
  })

  it('is not_saved when the write changed no row: a säte arrived meanwhile, or the row is closed to this writer', async () => {
    const mock = settingsTable({ registered_office: null, org_number: '5560125790' }, [])
    await expect(fill(mock)).resolves.toEqual({ status: 'not_saved' })
  })

  it('throws when the settings cannot be read or written, so the route answers an error', async () => {
    let mock = createTableMockSupabase({ company_settings: { data: null, error: { message: 'read refused' } } })
    await expect(fill(mock)).rejects.toThrow('read refused')

    mock = createTableMockSupabase()
    mock.setTable('company_settings', (calls) =>
      calls.some((call) => call.method === 'update')
        ? { data: null, error: { message: 'write refused' } }
        : { data: { registered_office: null, org_number: '5560125790' } },
    )
    await expect(fill(mock)).rejects.toThrow('write refused')
  })
})
