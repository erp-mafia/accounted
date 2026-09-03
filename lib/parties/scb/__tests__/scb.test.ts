import { describe, expect, it } from 'vitest'
import { createScbClient } from '../client'
import { isScbConfigured, scbConfigFromEnv } from '../config'
import { factsFromScbCompany, BOLAGSVERKET_WARNING_CODES } from '../map'
import { isLegalPersonOrgNumber, toPeOrgNr } from '../org-number'

describe('org numbers we send to SCB', () => {
  it('accepts legal persons (month slot 20 or more) and refuses personnummer-shaped numbers', () => {
    expect(isLegalPersonOrgNumber('556012-5790')).toBe(true)
    expect(isLegalPersonOrgNumber('5564300142')).toBe(true)
    expect(isLegalPersonOrgNumber('9696789012')).toBe(true) // handelsbolag
    expect(isLegalPersonOrgNumber('19800101-1234')).toBe(false)
    expect(isLegalPersonOrgNumber('8001011234')).toBe(false) // sole trader: a personnummer
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

describe('factsFromScbCompany', () => {
  const row = {
    PeOrgNr: '165560125790',
    Företagsnamn: 'Beijer Byggmaterial AB',
    Firma: '',
    'F-skattstatus': '1',
    Momsstatus: '1',
    Arbetsgivarstatus: '1',
    Företagsstatus: '1',
    'Juridisk form': '49',
    'Status hos Bolagsverket': '0',
    'Storleksklass Anställda': '9',
    Bransch_1: '46731',
    'Bransch_1, text': 'Partihandel med virke och andra byggmaterial',
    Postadress: 'Box 4102',
    PostNr: '20212',
    PostOrt: 'MALMÖ',
    COadress: null,
    Säteskommun: '1280',
    Säteslän: '12',
    Registreringsdatum: '19740101',
    Startdatum: '1974-01-01',
    Slutdatum: '',
    Telefon: '040-123456',
    'E-post': 'info@beijerbygg.se',
    'Antal arbetsställen': '78',
  }

  it('maps every documented variable to a labelled fact', () => {
    const facts = factsFromScbCompany(row)
    const by = Object.fromEntries(facts.map((f) => [f.field, f.value]))
    expect(by.legal_name).toBe('Beijer Byggmaterial AB')
    expect(by.trade_name).toBeUndefined()
    expect(by.f_tax).toEqual({ code: '1', label: 'Godkänd för F-skatt' })
    expect(by.vat_registration).toEqual({ code: '1', label: 'Momsregistrerad' })
    expect(by.employer_registration).toEqual({ code: '1', label: 'Registrerad som arbetsgivare' })
    expect(by.company_status).toEqual({ code: '1', label: 'Verksamt' })
    expect(by.legal_form).toEqual({ code: '49', label: 'Aktiebolag' })
    expect(by.bolagsverket_status).toEqual({ code: '0', label: 'Normalläge', warning: false })
    expect(by.employees_band).toEqual({ code: '9', label: '500 till 999 anställda' })
    expect(by.industry).toEqual({ code: '46731', label: 'Partihandel med virke och andra byggmaterial' })
    expect(by.postal_address).toEqual({ street: 'Box 4102', co: null, postal_code: '20212', city: 'MALMÖ' })
    expect(by.seat).toEqual({ municipality_code: '1280', county_code: '12' })
    expect(by.registered_at).toBe('1974-01-01')
    expect(by.active_since).toBe('1974-01-01')
    expect(by.active_until).toBeUndefined()
    expect(by.phone).toBe('040-123456')
    expect(by.email).toBe('info@beijerbygg.se')
    expect(by.workplaces).toBe(78)
  })

  it('flags a company in konkurs and tolerates renamed or missing columns', () => {
    const facts = factsFromScbCompany({ foretagsnamn: 'Gone AB', statushosbolagsverket: '20', fskattstatus: '9' })
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

  it('refuses a sole trader before any call is made', async () => {
    const json = async () => {
      throw new Error('should not be called')
    }
    const client = createScbClient(cfg, { json: json as never })
    await expect(client.lookupByOrgNumber('8001011234')).rejects.toThrow(/juridiska personer/)
  })

  it('posts the Je lookup with PeOrgNr and maps the returned row', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    const json = async (_c: unknown, method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return [{ PeOrgNr: '165560125790', Företagsnamn: 'Beijer Byggmaterial AB', 'F-skattstatus': '1' }]
    }
    const client = createScbClient(cfg, { json: json as never })
    const r = await client.lookupByOrgNumber('556012-5790')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.path).toBe('/api/Je/HamtaForetag')
    expect((calls[0]!.body as { Identiteter: string[] }).Identiteter).toEqual(['165560125790'])
    expect(r.found).toBe(true)
    expect(r.facts.map((f) => f.field)).toEqual(['legal_name', 'f_tax'])
  })

  it('reports not found when the list is empty', async () => {
    const json = async () => []
    const client = createScbClient(cfg, { json: json as never })
    const r = await client.lookupByOrgNumber('5564300142')
    expect(r.found).toBe(false)
    expect(r.facts).toEqual([])
  })
})
