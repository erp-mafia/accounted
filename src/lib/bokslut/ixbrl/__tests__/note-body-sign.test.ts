import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { buildTangibleImpairmentNote } from '@/lib/bokslut/arsredovisning/ledger-fixed-asset-notes'
import { pdfTextDeep } from '@/lib/pdf/number-text'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { makeInput } from './fixtures'

const MINUS = String.fromCharCode(0x2212)

/** A write-down booked by hand, outside the register: 6 000 kr at the start of the year. */
const handBookedWriteDown = {
  account_number: '1228',
  account_name: 'Ackumulerade nedskrivningar på inventarier',
  opening_debit: 0,
  opening_credit: 6000,
  period_debit: 0,
  period_credit: 0,
  closing_debit: 0,
  closing_credit: 6000,
}

describe('a negative amount in a note body', () => {
  const note = buildTangibleImpairmentNote([handBookedWriteDown], 7)
  if (!note) throw new Error('expected the write-down note')

  it('prints in the iXBRL with the minus sign the rest of the document uses', () => {
    const input = makeInput()
    input.noter = [...input.noter, { number: note.number, title: note.title, body: note.body }]
    const { xhtml } = generateK2IxbrlDocument(input)
    const noteText = xhtml.slice(xhtml.indexOf(`Not ${note.number} Nedskrivningar av anläggningstillgångar`))
    expect(noteText).toMatch(new RegExp(`Ingående nedskrivningar: ${MINUS}6\\s000 kr`))
    expect(noteText).not.toMatch(/: -\d/)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('still prints with a hyphen in the PDF, whose font has no minus sign', () => {
    const pdfBody = pdfTextDeep(note.body)
    expect(pdfBody).toMatch(/Ingående nedskrivningar: -6\s000 kr/)
    expect(pdfBody).not.toContain(MINUS)
  })
})
