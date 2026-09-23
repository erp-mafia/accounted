import { afterEach, describe, expect, it, vi } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { LEGAL_FORMS, PLANNED_LEGAL_FORMS } from '@/lib/company/forms'
import type { LegalFormProfile } from '@/lib/company/forms'
import {
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS_SV,
  UnknownEntityTypeError,
  booksCurrentTax,
  creationFlagReader,
  filesIncomeReturn,
  hasOwners,
  isEntityTypeCreatable,
  legalFormGlossary,
  legalFormProfile,
  plannedLegalForms,
  supportsAccountingFramework,
  supportsCorporateTaxDispositions,
  templateAccountForForm,
} from '@/lib/company/entity-type'

const forms = [...ENTITY_TYPES]
const basNumbers = new Set(BAS_REFERENCE.map((a) => a.account_number))

/** Leaf capability fields, dotted, in the order they appear on the profile. */
function leaves(profile: LegalFormProfile): Record<string, unknown> {
  return {
    'identity.orgId': profile.identity.orgId,
    'fiscalYear.calendarOnly': profile.fiscalYear.calendarOnly,
    'bookkeeping.defaultMethod': profile.bookkeeping.defaultMethod,
    'bookkeeping.simplifiedRegelverk': profile.bookkeeping.simplifiedRegelverk,
    'bookkeeping.templateColumn': profile.bookkeeping.templateColumn,
    'equity.closing': profile.equity.closing,
    'equity.priorYearCarry': profile.equity.priorYearCarry,
    'equity.hasOwners': profile.equity.hasOwners,
    'equity.settlement': JSON.stringify(profile.equity.settlement),
    'equity.memberCapital': profile.equity.memberCapital,
    'filings.incomeReturn': profile.filings.incomeReturn,
    'filings.booksCurrentTax': profile.filings.booksCurrentTax,
    'filings.corporateTaxDispositions': profile.filings.corporateTaxDispositions,
    'filings.arsredovisning': profile.filings.arsredovisning,
    'filings.frameworks': JSON.stringify(profile.filings.frameworks),
    'filings.ixbrl': profile.filings.ixbrl,
    'filings.auditorAlwaysRequired': profile.filings.auditorAlwaysRequired,
  }
}

describe('legal forms: the registry', () => {
  it('has one profile per form, keyed by its own code, all Swedish', () => {
    for (const form of forms) {
      expect(LEGAL_FORMS[form].code).toBe(form)
      expect(LEGAL_FORMS[form].jurisdiction).toBe('SE')
      expect(legalFormProfile(form)).toBe(LEGAL_FORMS[form])
    }
    expect(ENTITY_TYPE_LABELS_SV).toEqual({
      enskild_firma: 'Enskild firma',
      aktiebolag: 'Aktiebolag',
      ideell_forening: 'Ideell förening',
      ekonomisk_forening: 'Ekonomisk förening',
    })
  })

  it('refuses a corrupt form at runtime', () => {
    expect(() => legalFormProfile('handelsbolag' as never)).toThrow(UnknownEntityTypeError)
  })

  it('names only accounts that exist in the BAS reference', () => {
    for (const form of forms) {
      const { closing, priorYearCarry, settlement } = LEGAL_FORMS[form].equity
      const named = [closing, priorYearCarry, settlement.withdrawal, settlement.contribution].filter(
        (n): n is string => n !== null,
      )
      for (const account of named) {
        expect(basNumbers.has(account), `${form}: ${account} is not a BAS reference account`).toBe(true)
      }
    }
  })

  it('has no field every form answers the same way (that would be a constant, not a capability)', () => {
    const perForm = forms.map((form) => leaves(LEGAL_FORMS[form]))
    for (const key of Object.keys(perForm[0])) {
      const answers = new Set(perForm.map((p) => JSON.stringify(p[key])))
      expect(answers.size, `${key} is identical for every form`).toBeGreaterThan(1)
    }
  })

  it('has a flag reader for every profile that declares a creation flag', () => {
    for (const form of forms) {
      const { creationFlag } = LEGAL_FORMS[form]
      if (!creationFlag) continue
      expect(creationFlagReader(creationFlag), `${form}: no reader for ${creationFlag}`).toBeTypeOf('function')
    }
  })

  it('lists planned forms that are not creatable yet, with labels', () => {
    expect(plannedLegalForms()).toBe(PLANNED_LEGAL_FORMS)
    for (const planned of PLANNED_LEGAL_FORMS) {
      expect(forms).not.toContain(planned.code)
      expect(planned.label.length).toBeGreaterThan(0)
      expect(planned.jurisdiction).toBe('SE')
    }
  })
})

describe('legal forms: capability readers', () => {
  it('report the filing capabilities of each form', () => {
    expect(filesIncomeReturn('aktiebolag')).toBe('INK2')
    expect(filesIncomeReturn('enskild_firma')).toBe('NE')
    expect(filesIncomeReturn('ideell_forening')).toBeNull()
    expect(booksCurrentTax('aktiebolag')).toBe(true)
    expect(booksCurrentTax('ideell_forening')).toBe(false)
    expect(supportsCorporateTaxDispositions('aktiebolag')).toBe(true)
    expect(supportsCorporateTaxDispositions('enskild_firma')).toBe(false)
    expect(supportsCorporateTaxDispositions('ideell_forening')).toBe(false)
    expect(supportsAccountingFramework('aktiebolag', 'K3')).toBe(true)
    expect(supportsAccountingFramework('ideell_forening', 'K2')).toBe(false)
    expect(supportsAccountingFramework('ideell_forening', 'K1')).toBe(true)
  })

  it('know that a förening has members, not owners', () => {
    expect(hasOwners('enskild_firma')).toBe(true)
    expect(hasOwners('aktiebolag')).toBe(true)
    expect(hasOwners('ideell_forening')).toBe(false)
    expect(legalFormGlossary('ideell_forening')).toEqual({ entity: 'föreningen', owner: 'Medlem', meeting: 'årsmöte' })
    expect(legalFormGlossary('enskild_firma').meeting).toBeNull()
  })

  it('resolve a template account per form exactly as before the profiles', () => {
    // EF reads the base column, AB the override, a förening the base column
    // with owner accounts translated to its member settlement account.
    expect(templateAccountForForm('enskild_firma', '2013', '2893')).toBe('2013')
    expect(templateAccountForForm('aktiebolag', '2013', '2893')).toBe('2893')
    expect(templateAccountForForm('aktiebolag', '6991', undefined)).toBe('6991')
    expect(templateAccountForForm('ideell_forening', '2013', '2893')).toBe('2890')
    expect(templateAccountForForm('ideell_forening', '2018', undefined)).toBe('2890')
    expect(templateAccountForForm('ideell_forening', '6991', '6991')).toBe('6991')
    expect(templateAccountForForm('ideell_forening', undefined, undefined)).toBeUndefined()
  })
})

describe('legal forms: creation gate reads the profile flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('opens a flagged form only when its variable is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(true)
    expect(isEntityTypeCreatable('aktiebolag')).toBe(true)
  })
})
