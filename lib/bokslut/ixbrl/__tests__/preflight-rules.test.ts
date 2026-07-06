import { describe, expect, it } from 'vitest'
import { runPreflightChecks } from '../validate/rules'
import { makeInput } from './fixtures'
import type { IxbrlArsredovisningInput } from '../types'

const TODAY = '2026-06-10'

const codes = (input: IxbrlArsredovisningInput): string[] =>
  runPreflightChecks(input, TODAY).issues.map((issue) => issue.code)

describe('runPreflightChecks', () => {
  it('passes the happy-path fixture with no errors', () => {
    const result = runPreflightChecks(makeInput(), TODAY)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('1020/1035: company identity', () => {
    const input = makeInput()
    input.company.name = '  '
    input.company.orgNumber = '12345'
    const found = codes(input)
    expect(found).toContain('1020')
    expect(found).toContain('1035')
  })

  it('1051: förvaltningsberättelse missing', () => {
    const input = makeInput()
    input.forvaltningsberattelse.allmantOmVerksamheten = ''
    expect(codes(input)).toContain('1051')
  })

  it('1107/1201/1214: underskrifter completeness', () => {
    const noSigners = makeInput()
    noSigners.underskrifter.signers = []
    expect(codes(noSigners)).toContain('1107')

    const nameless = makeInput()
    nameless.underskrifter.signers[0].lastName = ''
    expect(codes(nameless)).toContain('1201')

    const dateless = makeInput()
    dateless.underskrifter.signers[0].signedDate = ''
    expect(codes(dateless)).toContain('1214')
  })

  it('1214: an unsigned signature request (signedDate null) BLOCKS filing', () => {
    // build-input never fabricates a signing date: an unsigned request keeps
    // signedDate null, and that must surface as a blocking error, not a warn.
    const input = makeInput()
    input.underskrifter.signers[1].signedDate = null
    const result = runPreflightChecks(input, TODAY)
    const hit = result.issues.find((issue) => issue.code === '1214')
    expect(hit?.severity).toBe('error')
    expect(result.ok).toBe(false)
  })

  it('1103/1169: fastställelseintyg completeness', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = null
    input.faststallelseintyg.signerLastName = ''
    const found = codes(input)
    expect(found).toContain('1103')
    expect(found).toContain('1169')
  })

  it('1103: missing AGM date is a blocking error (no today-fallback)', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = null
    const result = runPreflightChecks(input, TODAY)
    const hit = result.issues.find((issue) => issue.code === '1103')
    expect(hit?.severity).toBe('error')
    expect(result.ok).toBe(false)
    // The date-ordering rules must not crash or misfire on the null date.
    const found = result.issues.map((issue) => issue.code)
    expect(found).not.toContain('1101')
    expect(found).not.toContain('1178')
  })

  it('1015: fiscal year not yet ended', () => {
    const input = makeInput()
    input.period = { start: '2026-01-01', end: '2026-12-31' }
    expect(codes(input)).toContain('1015')
  })

  it('1046: fiscal year longer than 18 months', () => {
    const input = makeInput()
    input.period = { start: '2024-01-01', end: '2025-12-31' }
    expect(codes(input)).toContain('1046')
  })

  it('1101: AGM on or before period end', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = '2025-12-31'
    expect(codes(input)).toContain('1101')
  })

  it('1178: AGM in the future', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = '2026-09-01'
    expect(codes(input)).toContain('1178')
  })

  it('1114: signature date inside the fiscal year', () => {
    const input = makeInput()
    input.underskrifter.signers[0].signedDate = '2025-12-30'
    expect(codes(input)).toContain('1114')
  })

  it('1183: AGM before board signatures', () => {
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = '2026-02-20'
    input.underskrifter.signers[1].signedDate = '2026-02-21'
    expect(codes(input)).toContain('1183')
  })

  it('1165: FI generated before AGM is warn-level only', () => {
    const input = makeInput()
    input.faststallelseintyg.genereratDatum = '2026-03-01' // AGM is 2026-03-15
    const result = runPreflightChecks(input, TODAY)
    const hit = result.issues.find((issue) => issue.code === '1165')
    expect(hit?.severity).toBe('warn')
    expect(result.ok).toBe(true)
  })

  it('3005: unbalanced balance sheet blocks', () => {
    const input = makeInput()
    input.totals.tillgangar = { current: 100, previous: null }
    const result = runPreflightChecks(input, TODAY)
    expect(result.issues.map((issue) => issue.code)).toContain('3005')
    expect(result.ok).toBe(false)
  })

  it('3006/3007: comparison figures required except first year', () => {
    const input = makeInput()
    input.totals.tillgangar = { ...input.totals.tillgangar, previous: null }
    input.totals.aretsResultat = { ...input.totals.aretsResultat, previous: null }
    const found = codes(input)
    expect(found).toContain('3006')
    expect(found).toContain('3007')

    const firstYear = makeInput()
    firstYear.isFirstFiscalYear = true
    firstYear.totals.tillgangar = { ...firstYear.totals.tillgangar, previous: null }
    firstYear.totals.aretsResultat = { ...firstYear.totals.aretsResultat, previous: null }
    const firstYearCodes = codes(firstYear)
    expect(firstYearCodes).not.toContain('3006')
    expect(firstYearCodes).not.toContain('3007')
  })

  it('ACC-2099: unbooked result blocks', () => {
    const input = makeInput()
    input.br['AretsResultatEgetKapital'] = { current: 0, previous: null }
    expect(codes(input)).toContain('ACC-2099')
  })

  it('ACC-DISP/ACC-UTD: resultatdisposition consistency', () => {
    const broken = makeInput()
    broken.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = 1
    expect(codes(broken)).toContain('ACC-DISP')

    const negative = makeInput()
    negative.forvaltningsberattelse.resultatdisposition.summa = -5_000
    negative.forvaltningsberattelse.resultatdisposition.utdelning = 1_000
    negative.forvaltningsberattelse.resultatdisposition.balanserasINyRakning = -6_000
    expect(codes(negative)).toContain('ACC-UTD')
  })

  it('carries mapper warnings as warn-level issues', () => {
    const input = makeInput()
    input.warnings = ['Konto 9999 täcks inte av K2-mappningen']
    const result = runPreflightChecks(input, TODAY)
    expect(result.warnings.some((issue) => issue.message.includes('9999'))).toBe(true)
    expect(result.ok).toBe(true)
  })
})
