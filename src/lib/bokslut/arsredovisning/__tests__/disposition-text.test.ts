/**
 * The sentence under "Förslag till resultatdisposition" states what the table
 * under it states. With a proposed dividend and no text of the board's own,
 * the PDF and the iXBRL used to say "årets resultat balanseras i ny räkning"
 * beside a table that pays a dividend; the editor saved that sentence as if
 * the user had written it, so it stayed after the dividend was entered.
 * Followed over the in-memory ledger: the report, the PDF and the iXBRL
 * document built from the same books.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { createLedgerFakeDb } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import { pdfTextStrings } from '@/tests/pdf-text'
import { generateIxbrlDocument } from '@/lib/bokslut/ixbrl/document/generate'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { buildCanonicalAnnualReport } from '../model'
import { formatPdfKronor } from '../pdf-format'
import {
  NO_DIVIDEND_DISPOSITION_TEXT,
  defaultDispositionText,
  dispositionText,
  isGeneratedDispositionText,
} from '../disposition-text'
import { proposalTextWithoutAmounts } from '@/lib/bolaget/meetings/disposition-sentence'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }
const RENDER_TIMEOUT = 30_000
const DIVIDEND = 30_000
const BOARD_TEXT = 'Styrelsen föreslår att vinstmedlen disponeras enligt tabellen nedan.'

async function build(narrative: { proposed_dividend?: number; resultatdisposition?: string }, proposedDividend?: number) {
  const tables = reportBooks('aktiebolag')
  Object.assign(tables.arsredovisning_narratives[0], narrative)
  const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables })
  return buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', { ...OPTIONS, proposedDividend })
}

/** sv-SE groups with a no-break space: compare on plain spaces. */
const plain = (text: string) => text.replace(/\s+/g, ' ').trim()

function ixbrlComment(xhtml: string): string | null {
  const match = /name="se-gen-base:DispositionerVinstForlustKommentar"><p>([^<]*)<\/p>/.exec(xhtml)
  return match ? plain(match[1]) : null
}

function dividendSentence(dividend: number, carried: number): string {
  return `Styrelsen föreslår att vinstmedlen disponeras så att ${formatPdfKronor(dividend)} kr delas ut och ${formatPdfKronor(carried)} kr balanseras i ny räkning.`
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the disposition sentence', () => {
  it('names the dividend and what is carried forward when one is proposed', () => {
    expect(defaultDispositionText({ proposed_dividend: 30_000, total: 1_066_618 })).toBe(
      'Styrelsen föreslår att vinstmedlen disponeras så att 30 000 kr delas ut och 1 036 618 kr balanseras i ny räkning.',
    )
  })

  it('is the sentence every report has printed when none is proposed', () => {
    expect(defaultDispositionText({ proposed_dividend: 0, total: 500 })).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
  })

  it('states the dividend in whole kronor and carries forward the rest, as the iXBRL table does', () => {
    expect(defaultDispositionText({ proposed_dividend: 0.49, total: 100 })).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
    expect(defaultDispositionText({ proposed_dividend: 0.5, total: 1 })).toBe(dividendSentence(1, 0))
    expect(defaultDispositionText({ proposed_dividend: 30_000.5, total: 100_000 })).toBe(dividendSentence(30_001, 69_999))
  })

  it('keeps a stored text as written unless it is a generated sentence for other amounts', () => {
    const withDividend = { proposed_dividend: 30_000, total: 100_000 }
    const without = { proposed_dividend: 0, total: 100_000 }
    expect(dispositionText(BOARD_TEXT, withDividend)).toBe(BOARD_TEXT)
    expect(dispositionText('', withDividend)).toBe('')
    expect(dispositionText(`${NO_DIVIDEND_DISPOSITION_TEXT} `, without)).toBe(`${NO_DIVIDEND_DISPOSITION_TEXT} `)
    expect(dispositionText(NO_DIVIDEND_DISPOSITION_TEXT, withDividend)).toBe(defaultDispositionText(withDividend))
    expect(dispositionText(undefined, withDividend)).toBe(defaultDispositionText(withDividend))
    // A dividend sentence stored for other amounts, by the editor or an API
    // write that copied the report's text, states the current ones.
    const stale = defaultDispositionText({ proposed_dividend: 30_000, total: 90_000 })
    const raised = { proposed_dividend: 40_000, total: 100_000 }
    expect(dispositionText(stale, raised)).toBe(dividendSentence(40_000, 60_000))
    expect(dispositionText(stale, without)).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
    expect(dispositionText(`${defaultDispositionText(withDividend)}\n`, withDividend)).toBe(`${defaultDispositionText(withDividend)}\n`)
    expect(dispositionText(`${stale} Utdelningen betalas i juni.`, raised)).toBe(`${stale} Utdelningen betalas i juni.`)
  })

  it('knows its own sentences by their form, with any amounts and spacing', () => {
    expect(isGeneratedDispositionText(` ${NO_DIVIDEND_DISPOSITION_TEXT}\n`)).toBe(true)
    expect(isGeneratedDispositionText(dividendSentence(1_250_000, -4_000))).toBe(true)
    expect(isGeneratedDispositionText('Styrelsen föreslår att vinstmedlen disponeras så att 30 000 kr delas ut och 70 000 kr balanseras i ny räkning.')).toBe(true)
    expect(isGeneratedDispositionText(BOARD_TEXT)).toBe(false)
    expect(isGeneratedDispositionText('')).toBe(false)
  })

  it('gives a reader without the amounts the board text, the no-dividend sentence, or nothing', () => {
    expect(proposalTextWithoutAmounts(BOARD_TEXT, DIVIDEND)).toBe(BOARD_TEXT)
    expect(proposalTextWithoutAmounts(null, 0)).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
    expect(proposalTextWithoutAmounts(NO_DIVIDEND_DISPOSITION_TEXT, 0)).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
    expect(proposalTextWithoutAmounts(NO_DIVIDEND_DISPOSITION_TEXT, DIVIDEND)).toBeNull()
    expect(proposalTextWithoutAmounts(null, DIVIDEND)).toBeNull()
  })
})

describe('an annual report that proposes a dividend', () => {
  it.each([
    ['with no text of the board', { proposed_dividend: DIVIDEND }],
    ['with the no-dividend sentence the editor saved', { proposed_dividend: DIVIDEND, resultatdisposition: NO_DIVIDEND_DISPOSITION_TEXT }],
    ['with a dividend sentence stored for other amounts', { proposed_dividend: DIVIDEND, resultatdisposition: dividendSentence(10_000, 5) }],
  ])('states the dividend in the sentence of the report, the PDF and the iXBRL, %s', async (_, narrative) => {
    const model = await build(narrative)
    const amounts = model.report.forvaltningsberattelse.resultatdisposition_amounts
    expect(amounts.proposed_dividend).toBe(DIVIDEND)
    const expected = dividendSentence(DIVIDEND, amounts.total - DIVIDEND)

    expect(model.report.forvaltningsberattelse.resultatdisposition).toBe(expected)

    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    const xhtml = generateIxbrlDocument(model.ixbrl).xhtml
    expect(ixbrlComment(xhtml)).toBe(plain(expected))
    expect(xhtml).toContain('till aktieägarna utdelas')

    const pdf = plain(pdfTextStrings(await renderToBuffer(ArsredovisningPDF({ data: model.report }))).join(' '))
    expect(pdf).toContain(plain(expected))
    expect(pdf).not.toContain('årets resultat balanseras i ny räkning')
  }, RENDER_TIMEOUT)

  it('states in the iXBRL sentence the whole kronor the iXBRL table states, for a dividend in öre', async () => {
    const model = await build({ proposed_dividend: DIVIDEND + 0.5 })
    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    const { summa, utdelning, balanserasINyRakning } = model.ixbrl.forvaltningsberattelse.resultatdisposition
    expect(utdelning).toBe(DIVIDEND + 1)
    expect(ixbrlComment(generateIxbrlDocument(model.ixbrl).xhtml)).toBe(plain(dividendSentence(utdelning, summa - utdelning)))
    expect(balanserasINyRakning).toBe(summa - utdelning)
  })

  it('keeps a text the board wrote', async () => {
    const model = await build({ proposed_dividend: DIVIDEND, resultatdisposition: BOARD_TEXT })
    expect(model.report.forvaltningsberattelse.resultatdisposition).toBe(BOARD_TEXT)
    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    expect(ixbrlComment(generateIxbrlDocument(model.ixbrl).xhtml)).toBe(BOARD_TEXT)
  })
})

describe('an annual report without a dividend', () => {
  it('says the result is carried forward, stored or not', async () => {
    for (const narrative of [{}, { resultatdisposition: NO_DIVIDEND_DISPOSITION_TEXT }]) {
      const model = await build(narrative)
      expect(model.report.forvaltningsberattelse.resultatdisposition).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
      if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
      expect(ixbrlComment(generateIxbrlDocument(model.ixbrl).xhtml)).toBe(NO_DIVIDEND_DISPOSITION_TEXT)
    }
  })

  it('keeps a stored sentence byte for byte in the report and the iXBRL input, so the content hash stays', async () => {
    const stored = `${NO_DIVIDEND_DISPOSITION_TEXT}\n`
    const model = await build({ resultatdisposition: stored })
    expect(model.report.forvaltningsberattelse.resultatdisposition).toBe(stored)
    expect(model.ixbrl?.forvaltningsberattelse.resultatdisposition.kommentar).toBe(stored)
  })
})

describe('a live draft filed with another dividend', () => {
  it('states that dividend in the iXBRL sentence when the board wrote none', async () => {
    const model = await build({}, DIVIDEND)
    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    const { summa, utdelning } = model.ixbrl.forvaltningsberattelse.resultatdisposition
    expect(utdelning).toBe(DIVIDEND)
    expect(ixbrlComment(generateIxbrlDocument(model.ixbrl).xhtml)).toBe(plain(dividendSentence(DIVIDEND, summa - DIVIDEND)))
  })

  it('keeps a text the board wrote', async () => {
    const model = await build({ resultatdisposition: BOARD_TEXT }, DIVIDEND)
    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    expect(ixbrlComment(generateIxbrlDocument(model.ixbrl).xhtml)).toBe(BOARD_TEXT)
  })
})
