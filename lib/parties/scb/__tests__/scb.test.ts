import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createScbClient, identityLookupBody } from '../client'
import { isScbConfigured, scbConfigFromEnv } from '../config'
import { factsFromScbCompany, BOLAGSVERKET_WARNING_CODES } from '../map'
import { isLegalPersonOrgNumber, toPeOrgNr } from '../org-number'

/** One Je row exactly as the live API returned it on 2026-09-03 (AB Volvo, public registry data). */
const volvo = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'volvo-je.json'), 'utf8')) as Record<string, string>

describe('org numbers we send to SCB', () => {
  it('accepts legal persons (month slot 20 or more) and refuses personnummer-shaped numbers', () => {
    expect(isLegalPersonOrgNumber('556012-5790')).toBe(true)
    expect(isLegalPersonOrgNumber('5564300142')).toBe(true)
    expect(isLegalPersonOrgNumber('9696789012')).toBe(true)
    expect(isLegalPersonOrgNumber('19800101-1234')).toBe(false)
    expect(isLegalPersonOrgNumber('8001011234')).toBe(false)
    expect(isLegalPersonOrgNumber('')).toBe(false)
    expect(isLegalPersonOrgNumber(null)).toBe(false)
  })

  it('builds PeOrgNr with the 16 prefix', () => {
    expect(toPeOrgNr('556012-5790')).toBe('165560125790')
  })
})

describe('config', () => {
  it('is configured only when both the certificate and its password are set', () => {
    const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv
    expect(isScbConfigured(env({}))).toBe(false)
    expect(isScbConfigured(env({ SCB_API_CERT_PFX_BASE64: 'AAAA' }))).toBe(false)
    expect(isScbConfigured(env({ SCB_API_CERT_PFX_BASE64: 'AAAA', SCB_API_CERT_PASSWORD: 'x' }))).toBe(true)
    const cfg = scbConfigFromEnv(env({ SCB_API_CERT_PFX_BASE64: Buffer.from('pfx').toString('base64'), SCB_API_CERT_PASSWORD: 'x', SCB_API_BASE_URL: 'https://example.test/base/' }))
    expect(cfg.baseUrl).toBe('https://example.test/base')
    expect(cfg.pfx.toString()).toBe('pfx')
    expect(() => scbConfigFromEnv(env({}))).toThrow(/SCB_API_CERT_PFX_BASE64/)
  })
})

describe('factsFromScbCompany on a live row', () => {
  it('maps the Volvo row with SCB codes and SCB text', () => {
    const facts = factsFromScbCompany(volvo)
    const by = Object.fromEntries(facts.map((f) => [f.field, f.value]))
    expect(by.legal_name).toBe('AKTIEBOLAGET VOLVO')
    expect(by.trade_name).toBeUndefined()
    expect(by.f_tax).toEqual({ code: '1', label: 'Är registrerad för F-skatt' })
    expect(by.vat_registration).toEqual({ code: '1', label: 'Är registrerad för moms' })
    expect(by.employer_registration).toEqual({ code: '1', label: 'Är registrerad som vanlig arbetsgivare' })
    expect(by.company_status).toEqual({ code: '1', label: 'Är verksam' })
    expect(by.legal_form).toEqual({ code: '49', label: 'Övriga aktiebolag' })
    expect(by.bolagsverket_status).toEqual({ code: '0', label: 'Normalläge', warning: false })
    expect(by.employees_band).toEqual({ code: '8', label: '200-499 anställda' })
    expect(by.registered_skv).toEqual({ code: '1', label: 'Registrerad' })
    expect(by.industry).toEqual({ code: '70100', label: 'Verksamheter som utövas av huvudkontor' })
    expect(by.postal_address).toEqual({ street: null, co: null, postal_code: '405 08', city: 'GÖTEBORG' })
    expect(by.seat).toEqual({ municipality_code: '1480', county_code: '14', municipality: 'Göteborg', county: 'Västra Götaland' })
    expect(by.turnover_band).toEqual({ code: '10', label: '1 000 000 - 4 999 999 tkr', year: '2025' })
    expect(by.registered_at).toBe('1972-01-01')
    expect(by.active_since).toBe('1972-01-01')
    expect(by.active_until).toBeUndefined()
    expect(by.phone).toBe('031660000')
    expect(by.email).toBeUndefined()
    expect(by.workplaces).toBe(1)
  })

  it('flags a company in konkurs, falls back to our labels without SCB text, and tolerates an empty row', () => {
    const facts = factsFromScbCompany({ Företagsnamn: 'Gone AB', 'Bolagsstatus, kod': '20', 'Fskattstatus, kod': '9 ' })
    const by = Object.fromEntries(facts.map((f) => [f.field, f.value]))
    expect(by.legal_name).toBe('Gone AB')
    expect(by.bolagsverket_status).toEqual({ code: '20', label: 'Konkurs inledd', warning: true })
    expect(by.f_tax).toEqual({ code: '9', label: 'Avregistrerad för F-skatt' })
    expect(BOLAGSVERKET_WARNING_CODES.has('0')).toBe(false)
    expect(factsFromScbCompany({})).toEqual([])
  })
})

describe('createScbClient', () => {
  const cfg = { baseUrl: 'https://scb.test', pfx: Buffer.from('x'), passphrase: 'p', timeoutMs: 1 }

  it('sends the identity filter the live API accepts', () => {
    expect(identityLookupBody('5560125790')).toEqual({
      Variabler: [{ Variabel: 'OrgNr (10 siffror)', Operator: 'ArLikaMed', Varde1: '5560125790', Varde2: '' }],
      Kategorier: [],
    })
  })

  it('refuses a sole trader before any call is made', async () => {
    const json = async () => {
      throw new Error('should not be called')
    }
    const client = createScbClient(cfg, { json: json as never })
    await expect(client.lookupByOrgNumber('8001011234')).rejects.toThrow(/juridiska personer/)
  })

  it('posts HamtaForetag and maps the returned row', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const json = async (_c: unknown, method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return [volvo]
    }
    const client = createScbClient(cfg, { json: json as never })
    const r = await client.lookupByOrgNumber('556012-5790')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.path).toBe('/api/Je/HamtaForetag')
    expect(calls[0]!.body).toEqual(identityLookupBody('5560125790'))
    expect(r.found).toBe(true)
    expect(r.peOrgNr).toBe('165560125790')
    expect(r.facts.find((f) => f.field === 'legal_name')?.value).toBe('AKTIEBOLAGET VOLVO')
  })

  it('reports not found when the list is empty', async () => {
    const json = async () => []
    const client = createScbClient(cfg, { json: json as never })
    const r = await client.lookupByOrgNumber('5564300142')
    expect(r.found).toBe(false)
    expect(r.facts).toEqual([])
  })
})
