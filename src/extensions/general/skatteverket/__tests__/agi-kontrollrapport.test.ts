import { describe, it, expect } from 'vitest'
import { firstAgiKontrollMessage, summarizeAgiKontrollrapport } from '../lib/agi-kontrollrapport'
import type { SkatteverketAGIKontrollresultat } from '../types'

// Synthetic personnummer; the employer id is 16 + a synthetic org nr.
const PNR = '190001010000'
const EMPLOYER = '165560000000'

function kontroll(overrides: Partial<SkatteverketAGIKontrollresultat> = {}): SkatteverketAGIKontrollresultat {
  return {
    status: 'DONE_REJECTED',
    inlamnad: '2026-10-06T10:00:00Z',
    antalUppgifter: 2,
    kontrolleradeUppgifter: 2,
    kontrollrapport: {
      filstorlek: 1000,
      filnamn: 'agi.xml',
      inkanal: 'eFIL',
      status: 'FAILED',
      antalFel: 2,
      antalVarningar: 0,
      bearbetningsfel: [],
      valideringsfel: [{ felmeddelande: `Fältkod 001 saknas för ${PNR}`, arbetsgivare: EMPLOYER }],
      redovisningsperioder: [
        {
          arbetsgivare: EMPLOYER,
          perioder: [
            {
              period: '202610',
              antalIU: 1,
              antalHU: 1,
              antalFel: 1,
              antalVarningar: 0,
              kontrollfel: [
                {
                  felkategori: 'Kontroll',
                  uppgiftsTyp: 'IU',
                  textNyckel: 'IU_001',
                  textTyp: 'FEL',
                  identifierare: PNR,
                  specifikationsnummer: 1,
                  felmeddelande: `Individuppgift för ${PNR.slice(0, 8)}-${PNR.slice(8)} saknar ruta 001.`,
                  felstatus: 'STOPP',
                },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  }
}

describe('summarizeAgiKontrollrapport', () => {
  it('keeps status, counts and every message, with personnummer masked', () => {
    const summary = summarizeAgiKontrollrapport(kontroll())!
    expect(summary.kontrollresultat_status).toBe('DONE_REJECTED')
    expect(summary.status).toBe('FAILED')
    expect(summary.antalFel).toBe(2)
    expect(summary.valideringsfel).toEqual([{ felmeddelande: 'Fältkod 001 saknas för 19000101-XXXX' }])
    expect(summary.redovisningsperioder).toEqual([
      {
        period: '202610',
        antalFel: 1,
        antalVarningar: 0,
        kontrollfel: [
          {
            felkategori: 'Kontroll',
            uppgiftsTyp: 'IU',
            textNyckel: 'IU_001',
            specifikationsnummer: 1,
            identifierare: '19000101-XXXX',
            felmeddelande: 'Individuppgift för 19000101-XXXX saknar ruta 001.',
            felstatus: 'STOPP',
          },
        ],
      },
    ])
    expect(summary.truncated).toBe(false)
    const json = JSON.stringify(summary)
    expect(json).not.toContain(PNR)
    expect(json).not.toContain(EMPLOYER) // the employer id is dropped
  })

  it('returns null when Skatteverket sent no kontrollrapport', () => {
    expect(summarizeAgiKontrollrapport(kontroll({ kontrollrapport: undefined }))).toBeNull()
  })

  it('caps a long list and flags it as truncated', () => {
    const base = kontroll()
    const many = Array.from({ length: 60 }, (_, i) => ({ felmeddelande: `Fel ${i}` }))
    const summary = summarizeAgiKontrollrapport({
      ...base,
      kontrollrapport: { ...base.kontrollrapport!, valideringsfel: many },
    })!
    expect(summary.valideringsfel).toHaveLength(50)
    expect(summary.truncated).toBe(true)
  })
})

describe('firstAgiKontrollMessage', () => {
  it('picks the first validation message', () => {
    expect(firstAgiKontrollMessage(summarizeAgiKontrollrapport(kontroll()))).toBe(
      'Fältkod 001 saknas för 19000101-XXXX',
    )
  })

  it('falls back to the first kontrollfel when there are no validation errors', () => {
    const base = kontroll()
    const summary = summarizeAgiKontrollrapport({
      ...base,
      kontrollrapport: { ...base.kontrollrapport!, valideringsfel: [] },
    })
    expect(firstAgiKontrollMessage(summary)).toBe('Individuppgift för 19000101-XXXX saknar ruta 001.')
  })

  it('is null for no summary', () => {
    expect(firstAgiKontrollMessage(null)).toBeNull()
  })
})
