/**
 * KU31 from the dividend register: who is reported, what blocks the file,
 * and the file itself. The register, the people module and the admin check
 * are mocked; the XML is the real builder's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { OperationContext } from '@/lib/operations/types'
import { luhnValid } from '../ku31-xml'

vi.mock('@/lib/bolaget/share-register', () => ({ loadShareRegisterData: vi.fn() }))
vi.mock('@/lib/bolaget/people', () => ({ loadRegisterParties: vi.fn(), loadFullPersonnummer: vi.fn(), ensureRegisterParty: vi.fn(), checkPartyRef: vi.fn() }))
vi.mock('@/lib/operations/access', () => ({ requireCompanyAdmin: vi.fn(), COMPANY_ADMIN_ROLES: ['owner', 'admin'] }))
vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: vi.fn() } }))
vi.mock('@/lib/bookkeeping/engine', () => ({ findFiscalPeriod: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/bookkeeping/entry-lines', () => ({ fetchEntryLines: vi.fn() }))
vi.mock('../free-equity', () => ({ checkFreeEquity: vi.fn() }))
vi.mock('../deadlines', () => ({ syncKu31Deadline: vi.fn(), upsertCapitalDeadline: vi.fn() }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2027-01-10',
}))

const { loadShareRegisterData } = await import('@/lib/bolaget/share-register')
const { loadRegisterParties, loadFullPersonnummer } = await import('@/lib/bolaget/people')
const { requireCompanyAdmin } = await import('@/lib/operations/access')
const { loadKu31Status, generateKu31File, saveKu31Settings, splitName } = await import('../ku31')

function withCheck(nine: string): string {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(`${nine}${d}`)) return `${nine}${d}`
  throw new Error('no check digit')
}

const COMPANY = '00000000-0000-4000-8000-00000000c001'
const USER = '00000000-0000-4000-8000-00000000a001'
const ORG = withCheck('556000000')
const ANNA = 'party-anna'
const BO = 'party-bo'
const CIA = 'party-cia'
const BOLAG = 'party-bolag'
const DODSBO = 'party-dodsbo'
function pnr(nine: string): string {
  const ten = withCheck(nine)
  return `19${ten.slice(0, 6)}-${ten.slice(6)}`
}

const PERSON = (party_id: string, name: string, masked: string | null) => ({
  party_id,
  name,
  kind: 'person' as const,
  org_number: null,
  personnummer_masked: masked,
  foreign_id_masked: null,
  birth_date: null,
  address: null,
  email: null,
})
const ALL_PARTIES = new Map<string, unknown>([
  [ANNA, PERSON(ANNA, 'Anna Ek', 'XXXXXXXX-1231')],
  [BO, PERSON(BO, 'Bo Ek', 'XXXXXXXX-2342')],
  [CIA, PERSON(CIA, 'Cia Berg', 'XXXXXXXX-3453')],
  [DODSBO, PERSON(DODSBO, 'Dödsboet efter Dan Ek', 'XXXXXXXX-4564')],
  [BOLAG, { party_id: BOLAG, name: 'Holding AB', kind: 'company', org_number: ORG, personnummer_masked: null, foreign_id_masked: null, birth_date: null, address: null, email: null }],
])

function dividendRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    company_id: COMPANY,
    decided_on: '2026-05-01',
    decided_by: 'arsstamma',
    origin: 'register',
    share_class_ids: null,
    amount_per_share: null,
    total_amount: 100_000,
    record_date: '2026-05-01',
    record_date_basis: 'decision_date',
    payment_date: '2026-05-15',
    status: 'paid',
    paid_on: '2026-05-15',
    ...over,
  }
}

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

const specRows: Array<{ party_id: string; specification_number: number }> = []

function setup(distributions: Array<{ dividend_id: string; party_id: string; amount: number }>, dividends = [dividendRow('d1')], settings: Record<string, unknown> | null = { famansforetag: true, contact_name: 'Anna Ek', contact_phone: '0701234567', contact_email: 'anna@exempel.se', last_generated_at: null }) {
  specRows.length = 0
  mock = createTableMockSupabase({
    dividends: { data: dividends },
    dividend_distributions: { data: distributions.map((d) => ({ ...d, share_count: 1, by_class: [] })) },
    ku31_filings: (chain) => (chain.some((c) => c.method === 'update' || c.method === 'insert') ? { data: null } : { data: settings }),
    companies: { data: { name: 'Exempel AB', org_number: ORG } },
    ku31_specification_numbers: (chain) => {
      const insert = chain.find((c) => c.method === 'insert')
      if (insert) {
        specRows.push(insert.args[0] as (typeof specRows)[number])
        return { data: null }
      }
      return { data: [...specRows] }
    },
  })
  ctx = { supabase: mock.supabase as never, companyId: COMPANY, userId: USER, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never }
  const ids = new Set(distributions.map((d) => d.party_id))
  vi.mocked(loadRegisterParties).mockImplementation(async (_c, list) => new Map([...ALL_PARTIES].filter(([id]) => (list as string[]).includes(id) && ids.has(id))) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireCompanyAdmin).mockResolvedValue(null)
  vi.mocked(loadShareRegisterData).mockResolvedValue({
    summary: { holders: [{ party_id: ANNA, votes: 600 }, { party_id: BO, votes: 400 }] },
  } as never)
})

describe('loadKu31Status', () => {
  it('one owner: ready, the amount summed over the year and öre dropped for field 574', async () => {
    setup([{ dividend_id: 'd1', party_id: ANNA, amount: 60_000.75 }, { dividend_id: 'd2', party_id: ANNA, amount: 1_000.5 }], [dividendRow('d1'), dividendRow('d2', { payment_date: '2026-12-20' })])
    const status = await loadKu31Status(ctx, 2026)
    expect(status.recipients).toEqual([
      expect.objectContaining({ party_id: ANNA, amount: 61_001.25, reported_amount: 61_001, reported: true, reason: null, identity: 'XXXXXXXX-1231' }),
    ])
    expect(status.deadline).toBe('2027-01-31')
    expect(status.famansforetag_derivation.derived).toBe(true)
    expect(status.blockers).toEqual([])
    expect(status.ready).toBe(true)
  })

  it('leaves out a Swedish legal person and keeps a dödsbo (SFL 19:2)', async () => {
    setup([{ dividend_id: 'd1', party_id: BOLAG, amount: 50_000 }, { dividend_id: 'd1', party_id: DODSBO, amount: 50_000 }])
    const status = await loadKu31Status(ctx, 2026)
    expect(status.recipients.find((r) => r.party_id === BOLAG)).toMatchObject({ reported: false, reason: 'legal_person' })
    expect(status.recipients.find((r) => r.party_id === DODSBO)).toMatchObject({ reported: true, reason: null })
    expect(status.ready).toBe(true)
  })

  it('blocks on a recipient without personnummer, pointing to the person form', async () => {
    setup([{ dividend_id: 'd1', party_id: ANNA, amount: 50_000 }, { dividend_id: 'd1', party_id: BO, amount: 50_000 }])
    vi.mocked(loadRegisterParties).mockResolvedValue(new Map([[ANNA, ALL_PARTIES.get(ANNA)], [BO, PERSON(BO, 'Bo Ek', null)]]) as never)
    const status = await loadKu31Status(ctx, 2026)
    expect(status.ready).toBe(false)
    expect(status.blockers).toEqual([
      expect.objectContaining({ code: 'KU31_PERSONNUMMER_MISSING', party_id: BO, message_sv: expect.stringContaining('Aktiebok') }),
    ])
  })

  it('blocks until the fåmansföretag question and the contact are answered, and counts dividends only decided', async () => {
    setup([{ dividend_id: 'd1', party_id: ANNA, amount: 1 }], [dividendRow('d1'), dividendRow('d3', { status: 'decided' })], null)
    const status = await loadKu31Status(ctx, 2026)
    expect(status.blockers.map((b) => b.code)).toEqual(['KU31_FAMANS_UNANSWERED', 'KU31_CONTACT_MISSING'])
    expect(status.unbooked_dividends).toBe(1)
  })

  it('says the file is for inkomstår 2026 only (schema 12.0)', async () => {
    setup([{ dividend_id: 'd1', party_id: ANNA, amount: 1 }], [dividendRow('d1', { payment_date: '2025-05-15' })])
    const status = await loadKu31Status(ctx, 2025)
    expect(status.file_supported).toBe(false)
    expect(status.blockers.map((b) => b.code)).toContain('KU31_SCHEMA_YEAR')
  })
})

describe('generateKu31File', () => {
  it('three owners: one KU31 each with full personnummer, numbered, stamped as generated', async () => {
    setup([
      { dividend_id: 'd1', party_id: ANNA, amount: 60_000 },
      { dividend_id: 'd1', party_id: BO, amount: 30_000 },
      { dividend_id: 'd1', party_id: CIA, amount: 10_000 },
    ])
    vi.mocked(loadFullPersonnummer).mockResolvedValue(new Map([[ANNA, pnr('800101123')], [BO, pnr('750615234')], [CIA, pnr('900203345')]]))
    const outcome = await generateKu31File(ctx, 2026)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data.recipients).toBe(3)
    expect(outcome.data.total_reported).toBe(100_000)
    expect(outcome.data.filename).toBe(`KU31_2026_${ORG}.xml`)
    const xml = outcome.data.xml
    expect(xml.match(/<ku:KU31>/g)).toHaveLength(3)
    expect(xml).toContain(`<ku:Inkomsttagare faltkod="215">${pnr('800101123').replace('-', '')}</ku:Inkomsttagare>`)
    expect(xml).toContain('<ku:Delagare faltkod="061">1</ku:Delagare>')
    expect(xml).toContain('<ku:Fornamn faltkod="216">Anna</ku:Fornamn>')
    expect(mock.payloads('ku31_specification_numbers', 'insert')).toEqual([
      { company_id: COMPANY, income_year: 2026, party_id: ANNA, specification_number: 1 },
      { company_id: COMPANY, income_year: 2026, party_id: BO, specification_number: 2 },
      { company_id: COMPANY, income_year: 2026, party_id: CIA, specification_number: 3 },
    ])
    expect(mock.payloads('ku31_filings', 'update')[0]).toMatchObject({ last_generated_by: USER })
  })

  it('an estate and a company: the estate is reported, the company is not', async () => {
    setup([{ dividend_id: 'd1', party_id: BOLAG, amount: 70_000 }, { dividend_id: 'd1', party_id: DODSBO, amount: 30_000 }])
    vi.mocked(loadFullPersonnummer).mockResolvedValue(new Map([[DODSBO, pnr('400101456')]]))
    const outcome = await generateKu31File(ctx, 2026)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data.recipients).toBe(1)
    expect(outcome.data.xml).not.toContain(ORG.slice(2) + '</ku:Inkomsttagare>')
    expect(outcome.data.xml).toContain('<ku:UtbetaldUtdelning faltkod="574">30000</ku:UtbetaldUtdelning>')
  })

  it('refuses while a recipient misses a personnummer, and never decrypts anything', async () => {
    setup([{ dividend_id: 'd1', party_id: BO, amount: 50_000 }])
    vi.mocked(loadRegisterParties).mockResolvedValue(new Map([[BO, PERSON(BO, 'Bo Ek', null)]]) as never)
    const outcome = await generateKu31File(ctx, 2026)
    expect(outcome).toMatchObject({ ok: false, code: 'KU31_NOT_READY' })
    expect(loadFullPersonnummer).not.toHaveBeenCalled()
  })

  it('is for an owner or administrator only', async () => {
    setup([{ dividend_id: 'd1', party_id: ANNA, amount: 1 }])
    vi.mocked(requireCompanyAdmin).mockResolvedValue({ ok: false, code: 'FORBIDDEN' })
    expect(await generateKu31File(ctx, 2026)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(loadFullPersonnummer).not.toHaveBeenCalled()
  })
})

describe('saveKu31Settings', () => {
  it('stores the confirmed answer with what the aktiebok suggested', async () => {
    setup([], [], null)
    await saveKu31Settings(ctx, 2026, { famansforetag: false, contact_name: ' Anna Ek ', contact_email: '' })
    expect(mock.payloads('ku31_filings', 'insert')[0]).toMatchObject({
      company_id: COMPANY,
      income_year: 2026,
      famansforetag: false,
      famansforetag_derived: true,
      famansforetag_confirmed_by: USER,
      contact_name: 'Anna Ek',
      contact_email: null,
    })
  })
})

describe('splitName', () => {
  it('takes the last word as surname', () => {
    expect(splitName('Anna Maria Ek')).toEqual({ first: 'Anna Maria', last: 'Ek' })
    expect(splitName('Ek')).toEqual({ first: null, last: null })
  })
})

