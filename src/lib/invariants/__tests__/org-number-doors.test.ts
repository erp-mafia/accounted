import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { luhnCheckDigit } from '@/lib/bankgiro/luhn'
import { FilingIdentityError, formatOrgNumberDisplay, normalizeOrgNumber, orgNumberKey, toRedovisare12 } from '@/lib/invariants/org-number'
import { AGIIncompleteDataError, generateAGIXml, findMissingCompanyData } from '@/lib/salary/agi/xml-generator'
import { generateSRUSubmission } from '@/lib/reports/ink2/sru-generator'
import { generateNESRUSubmission } from '@/lib/reports/ne-bilaga/sru-generator'
import { buildESkdFile } from '@/lib/reports/vat-eskd-file'
import { buildForaFile } from '@/lib/salary/fora/file'
import { beslutFileIsForCompany } from '@/lib/invoices/rot-rut-beslut-file'
import { settingsMismatches, type LiveFact, type SettingsSnapshot } from '@/lib/arkiv/lint/checks'
import { classifyCustomer } from '@/lib/import/shared/classify'
import { preparePeppolParticipant } from '@/lib/invoices/peppol-registration'
import { importSkattekontoFile } from '@/lib/import/skattekonto-file/import-file'
import { bankFileIdOrg, companyOrgNumber } from '@/lib/company/org-number'
import { decideOrgNumberChange } from '@/lib/company/org-number-rule'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { generateSkattekontoOcr } from '@/lib/skatteverket/skattekonto-ocr'
import { companyIdentity } from '@/lib/bolaget/capital/ku31'
import { companyForPdf } from '@/lib/bolaget/session'
import type { INK2Declaration } from '@/lib/reports/ink2/types'
import type { NEDeclaration } from '@/lib/reports/ne-bilaga/types'
import type { OperationContext } from '@/lib/operations/types'

/**
 * One number through every door that reads it. Each case failed before the
 * rule had one definition: the same input gave a different answer, or a
 * refusal, depending on which copy of the rule a door held.
 *
 * Personal numbers here are fabricated samordningsnummer (the day plus 60),
 * so none of them is anybody's.
 */
const withCheck = (nine: string) => `${nine}${luhnCheckDigit(nine)}`

const LEGAL = withCheck('556677889')
/** Born 1980-03-14. */
const PERSON = withCheck('800374011')
/** Born 2008-12-15: a minor, whose firm files under 20. */
const YOUNG = withCheck('081275011')
/** Born 1926-12-15: the two-digit year equals this year's and the birthday is still ahead. */
const BIRTHDAY_AHEAD = withCheck('261275011')

const agiCompany = (orgNumber: string, entityType: 'enskild_firma' | 'aktiebolag') => ({
  orgNumber,
  entityType,
  companyName: 'Testfirman',
  periodYear: 2026,
  periodMonth: 3,
  contactName: 'Test Testsson',
  contactPhone: '0700000000',
  contactEmail: 'test@example.com',
})
const agiTotals = {
  totalTax: 0,
  totalAvgifterBasis: 0,
  totalAvgifterAmount: 0,
  avgifterByCategory: {},
}

function ink2Declaration(orgNumber: string) {
  return {
    fiscalYear: { id: 'fp', name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    ink2: { '7011': '20250101', '7012': '20251231', '7104': 0, '7114': 0, '7132': 0, '7133': 0 },
    ink2r: {},
    ink2s: {},
    sruBlockers: [],
    companyInfo: {
      companyName: 'Testbolaget AB',
      orgNumber,
      entityType: 'aktiebolag',
      addressLine1: 'Gatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      email: 'a@example.se',
    },
  } as unknown as INK2Declaration
}

function neDeclaration(orgNumber: string) {
  return {
    fiscalYear: { id: 'fp', name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    rutor: { R1: 1000, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0, R9: 0, R10: 0, R11: 1000 },
    companyInfo: {
      companyName: 'Testfirman',
      orgNumber,
      entityType: 'enskild_firma',
      addressLine1: 'Gatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      email: 'a@example.se',
    },
    warnings: [],
    bookedResult: 1000,
    sruBlockers: [],
    balans: { B1: 0, B2: 0, B3: 0, B4: 0, B5: 0, B6: 0, B7: 0, B8: 0, B9: 0, B10: 0, B11: 0, B12: 0, B13: 0, B14: 0, B15: 0, B16: 0 },
    balansBreakdown: Object.fromEntries(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16'].map((b) => [b, { accounts: [], total: 0 }])) as never,
    sida2: { R12: 0, R13: 0, R14: 0 },
    sida2Breakdown: { R13: { items: [], total: 0 }, R14: { items: [], total: 0 } },
  } as unknown as NEDeclaration
}

/** company_settings and companies as a door reads them. */
function companyRows(settings: string | null, company: string | null) {
  const chain = (table: string) => {
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order', 'gte', 'lte', 'in', 'limit', 'neq', 'not', 'is']) query[method] = () => query
    const row = table === 'company_settings'
      ? { data: { org_number: settings }, error: null }
      : { data: { org_number: company, name: 'Testbolaget AB', entity_type: 'aktiebolag' }, error: null }
    query.maybeSingle = async () => row
    query.single = async () => row
    query.range = async () => ({ data: [], error: null })
    query.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null })
    return query
  }
  return { from: chain } as unknown as SupabaseClient
}

function skattekontoCsv(header: string) {
  const text = `"Testbolaget AB";"${header}";""\n"";"Ingående saldo 2026-05-03";"1000"\n"2026-05-05";"Moms";"-200"\n"";"Utgående saldo 2026-08-01";"800"\n`
  return { filename: 'skattekonto.csv', content_base64: Buffer.from(text).toString('base64') }
}

const skattekontoCtx = (supabase: SupabaseClient) =>
  ({ supabase, companyId: 'c1', userId: 'u1', log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child() { return this } } }) as never

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-01T12:00:00Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the identity a filing carries (company-identity-12-digit)', () => {
  it('a sole trader stored in 10-digit form files an AGI under the birth century', () => {
    const xml = generateAGIXml(agiCompany(PERSON, 'enskild_firma'), [], agiTotals)
    expect(xml).toContain(`<gem:Organisationsnummer>19${PERSON}</gem:Organisationsnummer>`)
    expect(xml).toContain(`<gem:Arendeagare>19${PERSON}</gem:Arendeagare>`)
  })

  it('the staging pre-check refuses what generation would refuse, and passes what it accepts', () => {
    expect(findMissingCompanyData(agiCompany(PERSON, 'enskild_firma'))).toBeNull()
    expect(findMissingCompanyData(agiCompany(LEGAL, 'aktiebolag'))).toBeNull()
    expect(findMissingCompanyData(agiCompany(PERSON, 'aktiebolag'))?.message).toMatch(/organisationsnummer/i)
    expect(() => generateAGIXml(agiCompany(PERSON, 'aktiebolag'), [], agiTotals)).toThrow(/organisationsnummer/i)
  })

  it('no AGI refusal asks a sole trader for a 12-digit number the settings door cannot store', () => {
    const refusal = findMissingCompanyData(agiCompany(`16${PERSON}`, 'enskild_firma'))
    expect(refusal?.message).not.toMatch(/12-siffrigt/)
  })

  it('INK2 writes one 12-digit identity whatever separator the number was stored with', () => {
    const spaced = `${LEGAL.slice(0, 6)} ${LEGAL.slice(6)}`
    const { infoSru, blanketterSru } = generateSRUSubmission(ink2Declaration(spaced))
    expect(infoSru).toContain(`#ORGNR 16${LEGAL}`)
    expect(blanketterSru).toContain(`#IDENTITET 16${LEGAL} `)
  })

  it('NE files a minor under the same century as moms and AGI', () => {
    const { infoSru } = generateNESRUSubmission(neDeclaration(YOUNG))
    expect(infoSru).toContain(`#ORGNR 20${YOUNG}`)
    expect(toRedovisare12(YOUNG, 'enskild_firma')).toBe(`20${YOUNG}`)
  })

  it('NE refuses a number that is not a person, instead of a birth century on a company number', () => {
    expect(() => generateNESRUSubmission(neDeclaration(LEGAL))).toThrow(/personnummer/)
  })

  it('a birthday later this year is last century, not a date ahead of today', () => {
    expect(toRedovisare12(BIRTHDAY_AHEAD, 'enskild_firma')).toBe(`19${BIRTHDAY_AHEAD}`)
  })

  it('a number that cannot be a birth date takes 16 under every legal form', () => {
    expect(toRedovisare12(LEGAL, 'enskild_firma')).toBe(`16${LEGAL}`)
    expect(toRedovisare12(LEGAL, 'aktiebolag')).toBe(`16${LEGAL}`)
    // A handelsbolag has no form of its own here and sits on enskild firma.
    expect(toRedovisare12(`16${LEGAL}`, 'enskild_firma')).toBe(`16${LEGAL}`)
  })

  it('a stored century on an enskild firma is the exact answer', () => {
    expect(toRedovisare12(`19${PERSON}`, 'enskild_firma')).toBe(`19${PERSON}`)
    expect(toRedovisare12(`20${YOUNG}`, 'enskild_firma')).toBe(`20${YOUNG}`)
  })
})

describe('a filing identity fits the legal form (company-identity-12-digit)', () => {
  it.each([
    ['a birth century on an aktiebolag, which would file and pay under that person', `19${PERSON}`],
    ['a personal number in 10 digits', PERSON],
    ['16 in front of a birth date, which names nobody', `16${PERSON}`],
    ['a birth century in front of a company number', `19${LEGAL}`],
    ['a VAT number without its SE', `${LEGAL}01`],
    ['nothing at all', ''],
  ])('refuses %s, at every door', (_what, stored) => {
    expect(() => toRedovisare12(stored, 'aktiebolag')).toThrow(FilingIdentityError)
    expect(() => generateSkattekontoOcr(stored, 'aktiebolag')).toThrow(FilingIdentityError)
    expect(() => generateSRUSubmission(ink2Declaration(stored))).toThrow(FilingIdentityError)
    expect(() => generateAGIXml(agiCompany(stored, 'aktiebolag'), [], agiTotals)).toThrow(AGIIncompleteDataError)
    expect(findMissingCompanyData(agiCompany(stored, 'aktiebolag'))).toBeInstanceOf(AGIIncompleteDataError)
  })

  it.each([
    ['a date no calendar has', withCheck('801374011')],
    ['16 in front of a birth date', `16${PERSON}`],
    ['nothing at all', ''],
  ])('refuses %s on an enskild firma too', (_what, stored) => {
    expect(() => toRedovisare12(stored, 'enskild_firma')).toThrow(FilingIdentityError)
  })

  it('NE and INK2 refuse the same way, with no placeholder identity in a file', () => {
    expect(() => generateNESRUSubmission(neDeclaration(LEGAL))).toThrow(FilingIdentityError)
    expect(() => generateNESRUSubmission(neDeclaration(''))).toThrow(FilingIdentityError)
    expect(() => generateSRUSubmission(ink2Declaration(''))).toThrow(FilingIdentityError)
  })

  it('names a way out that works where the settings door cannot help', () => {
    const stored = `19${PERSON}`
    // A valid number is locked, so the text cannot stop at "correct it".
    expect(decideOrgNumberChange({
      incoming: LEGAL, storedSettings: stored, storedCompany: stored, entityType: 'aktiebolag',
    })).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })

    const refusal = new FilingIdentityError()
    expect(refusal.message).toMatch(/kontakta supporten/)
    expect(refusal.message).toContain('Inställningar → Företagsuppgifter')
    expect(refusal.message).not.toContain(stored)
    expect(findMissingCompanyData(agiCompany(stored, 'aktiebolag'))?.message).toBe(refusal.message)
  })

  it('reaches the screen by its code, in both languages', () => {
    const refusal = new FilingIdentityError()
    expect(getErrorMessage(refusal)).toBe(refusal.message)
    expect(getErrorMessage(refusal, { locale: 'en' })).toMatch(/contact support/)
    const structured = getStructuredError(refusal)
    expect(structured.code).toBe('FILING_IDENTITY_REFUSED')
    expect(structured.message_sv).toBe(refusal.message)
  })
})

describe('the org part of a bank file id', () => {
  it('stays the company row as written, so a re-download stays one message at the bank', () => {
    expect(bankFileIdOrg(`16${LEGAL}`, LEGAL)).toBe(`16${LEGAL}`)
    expect(bankFileIdOrg('556677-8899', '5566778899')).toBe('5566778899')
  })

  it('takes the key when the company row holds nothing', () => {
    expect(bankFileIdOrg(null, LEGAL)).toBe(LEGAL)
    expect(bankFileIdOrg('', LEGAL)).toBe(LEGAL)
    expect(bankFileIdOrg(undefined, null)).toBe('')
  })
})

describe('one 10-digit key (org-number-ten-digit-key)', () => {
  const OTHER_PREFIX = `83${LEGAL}`

  it('a 12-digit value without a century is not cut to somebody else\'s number', () => {
    expect(orgNumberKey(OTHER_PREFIX)).toBeNull()
    expect(normalizeOrgNumber(OTHER_PREFIX)).toBeNull()
    expect(buildForaFile({ orgNumber: OTHER_PREFIX, year: 2026, month: 3, employees: [] } as never)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'FORA_ORG_NUMBER_MISSING' })],
    })
    expect(formatOrgNumberDisplay(OTHER_PREFIX)).toBe(OTHER_PREFIX)
    expect(() => buildESkdFile({} as never, { orgNumber: OTHER_PREFIX, periodEnd: '2026-03-31' })).toThrow(/organisationsnummer/i)
  })

  it('the plus form of an owner aged 100 or more reads as the same number', () => {
    const born1925 = withCheck('250175011')
    const plus = `${born1925.slice(0, 6)}+${born1925.slice(6)}`
    expect(orgNumberKey(plus)).toBe(born1925)
    expect(normalizeOrgNumber(plus)).toBe(born1925)
    expect(toRedovisare12(plus, 'enskild_firma')).toBe(`19${born1925}`)
    expect(toRedovisare12(born1925, 'enskild_firma')).toBe(`20${born1925}`)
  })

  it('a beslutsfil is this company\'s whichever form either side writes the number in', () => {
    expect(beslutFileIsForCompany({ utforare: `19${PERSON}` }, PERSON)).toBe(true)
    expect(beslutFileIsForCompany({ utforare: `16${PERSON}` }, `19${PERSON}`)).toBe(true)
    expect(beslutFileIsForCompany({ utforare: `16${LEGAL}` }, LEGAL)).toBe(true)
    expect(beslutFileIsForCompany({ utforare: `16${LEGAL}` }, PERSON)).toBe(false)
    expect(beslutFileIsForCompany({ utforare: `16${LEGAL}` }, null)).toBe(false)
  })

  it('an archive fact naming the stored number in another form is no mismatch', () => {
    const fact = { id: 'f1', predicate: 'org_number', value_text: PERSON, source_document_id: 'd1', sources: [] } as unknown as LiveFact
    const settings = { org_number: `19${PERSON}` } as unknown as SettingsSnapshot
    expect(settingsMismatches([fact], settings)).toEqual([])
    const other = { ...fact, value_text: LEGAL }
    expect(settingsMismatches([other], settings)).toHaveLength(1)
  })

})

describe('legal person or natural person (legal-or-personal-number)', () => {
  it('a 16-prefixed company is a company in the customer import', () => {
    expect(classifyCustomer({ org_number: `16${LEGAL}`, vat_number: null })).toBe('swedish_business')
    expect(classifyCustomer({ org_number: `19${PERSON}`, vat_number: null })).toBe('individual')
    expect(classifyCustomer({ org_number: PERSON, vat_number: null })).toBe('individual')
    expect(classifyCustomer({ org_number: LEGAL, vat_number: null })).toBe('swedish_business')
  })

  it('a day no calendar has is not a person', () => {
    expect(classifyCustomer({ org_number: withCheck('800100123'), vat_number: null })).toBe('swedish_business')
    expect(classifyCustomer({ org_number: withCheck('800132123'), vat_number: null })).toBe('swedish_business')
  })

  it('a Peppol participant with the 18 century is a personal number, whatever the digits', () => {
    const settings = { org_number: `18${PERSON}`, company_name: 'X', vat_number: null, city: null, country: 'SE', entity_type: null } as never
    expect(preparePeppolParticipant(settings)).toEqual({ ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' })
  })
})

describe('the wrong-company check (import-org-number-key)', () => {
  const header = `${LEGAL.slice(0, 6)}-${LEGAL.slice(6)}`

  it('the same number stored in 12-digit form is not another company', async () => {
    const result = await importSkattekontoFile(skattekontoCtx(companyRows(`16${LEGAL}`, LEGAL)), skattekontoCsv(header) as never, { dryRun: true })
    expect((result as { code?: string }).code).not.toBe('SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH')
  })

  it('a company with its number only on the company row is still checked', async () => {
    const other = withCheck('559999999')
    const result = await importSkattekontoFile(skattekontoCtx(companyRows(null, other)), skattekontoCsv(header) as never, { dryRun: true })
    expect((result as { code?: string }).code).toBe('SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH')
  })
})

describe('the company\'s own number (company-org-number-source)', () => {
  const ctx = (supabase: SupabaseClient) => ({ supabase, companyId: 'c1' }) as unknown as OperationContext

  it('every reader finds a number held in settings only', async () => {
    const db = companyRows(LEGAL, null)
    expect(await companyOrgNumber(db, 'c1')).toBe(LEGAL)
    expect((await companyIdentity(ctx(db))).org_number).toBe(LEGAL)
    expect((await companyForPdf(db, 'c1')).org_number).toBe(LEGAL)
  })

  it('an empty string on the company row hides nothing', async () => {
    const db = companyRows(LEGAL, '')
    expect((await companyIdentity(ctx(db))).org_number).toBe(LEGAL)
    expect((await companyForPdf(db, 'c1')).org_number).toBe(LEGAL)
  })
})
