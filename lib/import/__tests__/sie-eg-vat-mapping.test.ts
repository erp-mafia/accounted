import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { detectEncoding, decodeBuffer, parseSIEFile } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { enrichAccountMappingsWithVat } from '@/lib/import/account-vat-treatment'
import { resolveVatTreatmentRuta } from '@/lib/vat/account-vat-treatment'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

/**
 * End-to-end cover for the EG/EU account-label class of bug (#2525), across
 * the chain the import wizard actually runs: decode -> parse -> suggestMappings
 * -> enrichAccountMappingsWithVat. The unit tests in
 * lib/vat/__tests__/account-vat-treatment.test.ts cover the matcher alone;
 * this file exists because that is not the same thing. The suggestions are
 * computed client-side from the decoded label, so a matcher that is correct on
 * a UTF-8 string can still produce the wrong momskod on a real file.
 *
 * The fixture is deliberately real CP437 (`#FORMAT PC8`) and NOT valid UTF-8,
 * which is what SIE4 exporters emit. That makes the decode part of the
 * assertion: if decodeBuffer ever regressed and "utanför" arrived mojibaked,
 * OUTSIDE_UNION would stop matching and 3045/3055 would silently fall back to
 * the intra-union branch. A UTF-8 fixture could not catch that.
 */
const FIXTURE = join(__dirname, 'fixtures', 'eg-eu-bas97.se')

function runImportChain() {
  const buf = readFileSync(FIXTURE)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const encoding = detectEncoding(ab)
  const parsed = parseSIEFile(decodeBuffer(ab, encoding))
  const mappings = enrichAccountMappingsWithVat(
    suggestMappings(parsed.accounts, BAS_REFERENCE),
    [],
  )
  return { encoding, parsed, mappings }
}

describe('SIE import: EG-labelled accounts (EU-BAS 97)', () => {
  it('decodes the CP437 fixture without mangling the Swedish labels', () => {
    const { encoding, parsed } = runImportChain()
    expect(encoding).toBe('cp437')
    const byNumber = new Map(parsed.accounts.map((a) => [a.number, a.name]))
    expect(byNumber.get('3045')).toBe('Försäljn tjänst utanför EG momsfri')
    expect(byNumber.get('4056')).toBe('Inköp varor 25% EG')
    // No replacement characters anywhere: a failed decode shows up here first.
    expect([...byNumber.values()].join('')).not.toContain('�')
  })

  // Every row below was wrong before #2525: the class 3 accounts were suggested
  // as `exempt` (ruta 42) or standard_25 (ruta 05), and the class 4 accounts got
  // no suggestion at all. 4056-4058 are not in ACCOUNT_TO_BOX either, so their
  // amounts left the declaration entirely rather than landing in a wrong box.
  it.each([
    ['3045', 'export_services', 0, 'ruta40'],
    ['3046', 'reverse_charge_eu_services', 0, 'ruta39'],
    ['3048', 'reverse_charge_eu_services', 0, 'ruta39'],
    ['3055', 'export_goods', 0, 'ruta36'],
    ['3057', 'reverse_charge_eu_goods', 0, 'ruta35'],
    ['3058', 'reverse_charge_eu_goods', 0, 'ruta35'],
    ['4056', 'reverse_charge_eu_goods', 0.25, 'ruta20'],
    ['4057', 'reverse_charge_eu_goods', 0.12, 'ruta20'],
    ['4058', 'reverse_charge_eu_goods', 0.06, 'ruta20'],
    ['4059', 'reverse_charge_eu_goods', 0.25, 'ruta20'],
  ])('maps %s to %s and its ruta', (account, treatment, rate, ruta) => {
    const { mappings } = runImportChain()
    const row = mappings.find((m) => m.sourceAccount === account)
    expect(row, `no mapping produced for ${account}`).toBeDefined()
    expect(row!.defaultVatTreatment).toBe(treatment)
    expect(row!.defaultVatRate).toBe(rate)
    expect(
      resolveVatTreatmentRuta(row!.defaultVatTreatment!, Number(account[0]), account),
    ).toEqual({ box: ruta, side: Number(account[0]) === 3 ? 'credit' : 'debit' })
  })

  it('leaves momspliktig EU-varuförsäljning for review rather than guessing', () => {
    // 3056 "Försäljn varor till EG 25% momspliktig" carries Swedish moms below
    // the OSS threshold and destination-country moms above it. The label cannot
    // tell which, so no suggestion is the honest answer. Matches what the EU
    // spelling already does for BAS 3106.
    const { mappings } = runImportChain()
    const row = mappings.find((m) => m.sourceAccount === '3056')
    expect(row?.defaultVatTreatment).toBeNull()
    // Still surfaced to the user: class 3 always sits behind the review gate.
    expect(row?.requiresVatTreatmentReview).toBe(true)
  })

  it('keeps every EG suggestion behind the review gate', () => {
    const { mappings } = runImportChain()
    const eg = mappings.filter((m) => /\bEG\b/.test(m.sourceName))
    expect(eg).toHaveLength(11)
    expect(eg.every((m) => m.requiresVatTreatmentReview)).toBe(true)
    expect(eg.every((m) => m.vatTreatmentReviewed === false)).toBe(true)
  })
})
