import { describe, it, expect } from 'vitest'
import { beslutFileIsForCompany, readBeslutFile } from '../rot-rut-beslut-file'

const FILE = {
  version: '1',
  utforare: '168780003656',
  beslut: [
    {
      namn: 'RUT 1',
      referensnummer: '12345678901',
      arenden: [{ personnummer: '191212121212', fakturanummer: '1001', godkantBelopp: 1500 }],
    },
  ],
}

describe('readBeslutFile', () => {
  it('reads the decision JSON', () => {
    expect(readBeslutFile(JSON.stringify(FILE))).toEqual(FILE)
  })

  it("reads Skatteverket's own schema example, where a beslut has no ärenden", () => {
    // The examples block of Skatteverket's Beslut.json schema (skattered/begaran/V1), verbatim.
    const example = {
      version: '1',
      utforare: '165519991234',
      beslut: [
        { namn: 'Mitt beslut', referensnummer: '20180000001', arenden: [] },
        {
          namn: 'Mitt andra beslut',
          referensnummer: '20180000002-01',
          arenden: [{ personnummer: '191212121212', fakturanummer: '99', godkantBelopp: 0 }],
        },
      ],
    }
    expect(readBeslutFile(JSON.stringify(example))).toEqual(example)
  })

  it('returns null for text that is not JSON', () => {
    expect(readBeslutFile('Fakturanr;Belopp\n1001;1500')).toBeNull()
    expect(readBeslutFile('')).toBeNull()
  })

  it('returns null for JSON that is not a beslutsfil', () => {
    expect(readBeslutFile(JSON.stringify({ ...FILE, beslut: [] }))).toBeNull()
    expect(readBeslutFile(JSON.stringify([{ fakturanummer: '1001', godkantBelopp: 1500 }]))).toBeNull()
  })
})

describe('beslutFileIsForCompany', () => {
  it("matches the company's 10-digit org number to the 16-prefixed utförare in the file", () => {
    expect(beslutFileIsForCompany(FILE, '878000-3656')).toBe(true)
  })

  it('refuses another utförare, and a company without an org number', () => {
    expect(beslutFileIsForCompany(FILE, '556123-4567')).toBe(false)
    expect(beslutFileIsForCompany(FILE, null)).toBe(false)
  })
})
