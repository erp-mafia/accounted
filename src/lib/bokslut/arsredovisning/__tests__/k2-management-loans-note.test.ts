/**
 * ÅRL 5 kap. 18 §: a company that has lent money to, or made a commitment
 * for, a styrelseledamot or VD states it in a note. 5 kap. 1 § puts the
 * paragraph on mindre företag too, so a K2 årsredovisning carries it as well
 * as a K3 one (BFN:s vägledning K2, kapitel 18, repeats the paragraph).
 *
 * The answer is stored under the disclosure matrix's id (not.lan_ledande),
 * which the K3 document already reads. The K2 document must read the same
 * answer: the PDF note, and the iXBRL note tagged with the K2 taxonomy's own
 * concept. A year that has not stated it is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { renderToBuffer } from '@react-pdf/renderer'
import { pdfTextStrings } from '@/tests/pdf-text'
import { createLedgerFakeDb, type LedgerRow } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import { generateIxbrlDocument } from '@/lib/bokslut/ixbrl/document/generate'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { buildCanonicalAnnualReport } from '../model'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }
const TITLE = 'Lån till ledande befattningshavare'
const CONCEPT = 'se-gen-base:NotLanSakerheterAtagandenFormanLedandeBefattningshavare'
const LOAN = 'Bolaget har per balansdagen en fordran på en styrelseledamot om 12 000 kr.'
const TERMS = 'Fordran löper utan ränta och återbetalas under nästa räkenskapsår.'
const LOAN_TEXT = `${LOAN}\n\n${TERMS}`

function books(answer: Record<string, unknown> | undefined): Record<string, LedgerRow[]> {
  const tables = reportBooks('aktiebolag')
  if (answer !== undefined) {
    tables.arsredovisning_narratives[0].disclosure_answers = { 'not.lan_ledande': answer }
  }
  return tables
}

async function build(answer: Record<string, unknown> | undefined) {
  const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: books(answer) })
  return buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', OPTIONS)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('K2 note on lån till ledande befattningshavare (ÅRL 5 kap. 18 §)', () => {
  it('prints the stated answer as a note in the report and the PDF and tags it in the iXBRL document', async () => {
    const model = await build({ applies: true, confirmed: true, text: LOAN_TEXT })
    expect(model.report.accounting_framework).toBe('k2')

    const note = model.report.noter.find((n) => n.title === TITLE)
    expect(note?.body).toBe(LOAN_TEXT)
    // Numbered in sequence with the other notes, and koncernförhållanden or
    // any later note keeps its own number after it.
    expect(model.report.noter.map((n) => n.number)).toEqual(model.report.noter.map((_, index) => index + 1))

    const pdf = pdfTextStrings(await renderToBuffer(ArsredovisningPDF({ data: model.report }))).join(' ')
    expect(pdf).toContain(TITLE)
    expect(pdf.replace(/\s+/g, ' ')).toContain('återbetalas under nästa räkenskapsår')

    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    const { xhtml } = generateIxbrlDocument(model.ixbrl)
    expect(xhtml).toContain(`Not ${note?.number} ${TITLE}`)
    // One fact that keeps both paragraphs.
    expect(xhtml).toMatch(new RegExp(`contextRef="period0" name="${CONCEPT}"[^>]*><p>${LOAN}</p>\\s*<p>${TERMS}</p></ix:nonNumeric>`))
    expect(XMLValidator.validate(xhtml)).toBe(true)
    // The note adds no validation issue: the same issues as the year without it.
    const baseline = await build(undefined)
    expect(model.validation.issues.map((issue) => issue.code)).toEqual(
      baseline.validation.issues.map((issue) => issue.code),
    )
  }, 30_000)

  it('prints no note when the year has not stated it, or stated that it does not apply', async () => {
    for (const answer of [undefined, { applies: false }]) {
      const model = await build(answer)
      expect(model.report.noter.map((n) => n.title)).not.toContain(TITLE)
      expect([...model.report.warnings, ...(model.report.errors ?? [])].join('\n')).not.toContain('ÅRL 5 kap. 18 §')
    }
  })

  it('blocks the document when the year says it applies but states nothing to print', async () => {
    const model = await build({ applies: true })
    expect(model.report.noter.map((n) => n.title)).not.toContain(TITLE)
    expect(model.report.errors ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('ÅRL 5 kap. 18 §')]),
    )
    expect(
      model.validation.issues.filter((issue) => issue.severity === 'error' && issue.message.includes('ÅRL 5 kap. 18 §')),
    ).toHaveLength(1)
  })
})
