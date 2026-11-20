/**
 * What a BankID signature binds (../visible-data.ts): the text the BankID app
 * shows (simpleMarkdownV1, people's text made safe for it), the hidden payload
 * that carries the document hash, and reading both back out of the XML-DSig
 * TIC hands over (base64, the BankID elements base64 inside it).
 */
import { describe, expect, it } from 'vitest'
import {
  buildUserNonVisibleData,
  buildUserVisibleData,
  markdownSafe,
  signatureBindsPayload,
  signedVisibleText,
  type SignedPayload,
} from '../visible-data'

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

const PAYLOAD: SignedPayload = {
  v: 1,
  kind: 'accounted.signing',
  request: '11111111-1111-4111-8111-111111111111',
  signer: '22222222-2222-4222-8222-222222222222',
  sha256: 'ab'.repeat(32),
}

/** The XML-DSig as TIC answers it: base64 of the XML, the BankID data base64 inside. */
function signatureXml(parts: { visible?: string | null; nonVisible?: string | null; raw?: boolean; prefix?: string }): string {
  const p = parts.prefix ? `${parts.prefix}:` : ''
  const encode = (value: string) => (parts.raw ? value : b64(value))
  const visible = parts.visible == null ? '' : `<${p}usrVisibleData charset="UTF-8" visible="wysiwys">${encode(parts.visible)}</${p}usrVisibleData>`
  const nonVisible = parts.nonVisible == null ? '' : `<${p}usrNonVisibleData>${encode(parts.nonVisible)}</${p}usrNonVisibleData>`
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>c2ln</SignatureValue>' +
    `<Object><${p}bankIdSignedData xmlns${parts.prefix ? `:${parts.prefix}` : ''}="http://www.bankid.com/signature/v1.0.0/types">` +
    `<${p}srvInfo><${p}name>cn=TIC</${p}name></${p}srvInfo>${visible}${nonVisible}` +
    `</${p}bankIdSignedData></Object></Signature>`
  return b64(xml)
}

describe('markdownSafe', () => {
  it('strips the characters that start formatting and every line break, and collapses spaces', () => {
    expect(markdownSafe('Hyres*avtal* | #1 + bilaga\n\nrad två\t ')).toBe('Hyresavtal 1 bilaga rad två')
    expect(markdownSafe('Rad ett\r\nRad två')).toBe('Rad ett Rad två')
    expect(markdownSafe('# Rubrik')).toBe('Rubrik')
    expect(markdownSafe('+ punkt')).toBe('punkt')
  })

  it('leaves no trailing or leading space and keeps Swedish letters', () => {
    expect(markdownSafe('  Åsa Öberg  ')).toBe('Åsa Öberg')
    expect(markdownSafe('Bolaget AB *')).toBe('Bolaget AB')
  })
})

describe('buildUserVisibleData', () => {
  const input = {
    title: 'Hyresavtal *2026*',
    companyName: 'Bolaget # AB',
    fileName: 'hyres\navtal.pdf',
    sha256: 'abcdef0123456789'.repeat(4),
    signerName: 'Anna *Andersson*',
    roleLabel: 'VD',
  }

  it('says what is signed, by whom, which file and the start of its checksum, with people\'s text made safe', () => {
    expect(buildUserVisibleData(input)).toBe(
      [
        '# Signera dokument',
        '',
        'Jag signerar *Hyresavtal 2026* för Bolaget AB.',
        '',
        '+ Undertecknare: Anna Andersson, VD',
        '+ Fil: hyres avtal.pdf',
        '+ Kontrollsumma (SHA-256): abcdef0123456789',
      ].join('\n'),
    )
  })

  it('leaves the role out when there is none', () => {
    expect(buildUserVisibleData({ ...input, roleLabel: null })).toContain('+ Undertecknare: Anna Andersson\n')
  })

  it('replaces the default statement, made safe too, when one is given', () => {
    const text = buildUserVisibleData({ ...input, statement: 'Vi intygar *att* årsredovisningen\när riktig.' })
    expect(text).toContain('\nVi intygar att årsredovisningen är riktig.\n')
    expect(text).not.toContain('Jag signerar')
  })
})

describe('buildUserNonVisibleData', () => {
  it('is the payload as JSON, read back unchanged', () => {
    expect(JSON.parse(buildUserNonVisibleData(PAYLOAD))).toEqual(PAYLOAD)
    const withContent = { ...PAYLOAD, content_hash: 'cd'.repeat(32) }
    expect(JSON.parse(buildUserNonVisibleData(withContent))).toEqual(withContent)
  })
})

describe('signatureBindsPayload', () => {
  const nonVisible = buildUserNonVisibleData(PAYLOAD)

  it('accepts the payload carried base64, as BankID carries it', () => {
    expect(signatureBindsPayload(signatureXml({ visible: 'text', nonVisible }), nonVisible)).toBe(true)
  })

  it('accepts the payload carried raw, and under a namespace prefix', () => {
    expect(signatureBindsPayload(signatureXml({ nonVisible, raw: true }), nonVisible)).toBe(true)
    expect(signatureBindsPayload(signatureXml({ visible: 'text', nonVisible, prefix: 'bankid' }), nonVisible)).toBe(true)
  })

  it('refuses a signature of another document or another signer', () => {
    const other = buildUserNonVisibleData({ ...PAYLOAD, sha256: 'ef'.repeat(32) })
    expect(signatureBindsPayload(signatureXml({ visible: 'text', nonVisible: other }), nonVisible)).toBe(false)
    const otherSigner = buildUserNonVisibleData({ ...PAYLOAD, signer: '33333333-3333-4333-8333-333333333333' })
    expect(signatureBindsPayload(signatureXml({ visible: 'text', nonVisible: otherSigner }), nonVisible)).toBe(false)
  })

  it('refuses a signature that carries no hidden payload, and one that is not XML at all', () => {
    expect(signatureBindsPayload(signatureXml({ visible: 'text', nonVisible: null }), nonVisible)).toBe(false)
    expect(signatureBindsPayload(b64('not xml'), nonVisible)).toBe(false)
    expect(signatureBindsPayload('', nonVisible)).toBe(false)
  })
})

describe('signedVisibleText', () => {
  it('reads the text the BankID app showed out of the signature', () => {
    const shown = '# Signera dokument\n\nJag signerar *Hyresavtal* för Bolaget AB.'
    expect(signedVisibleText(signatureXml({ visible: shown, nonVisible: 'x' }))).toBe(shown)
    expect(signedVisibleText(signatureXml({ visible: shown, nonVisible: 'x', prefix: 'ns2' }))).toBe(shown)
  })

  it('answers null when the signature carries no visible text, or only whitespace', () => {
    expect(signedVisibleText(signatureXml({ visible: null, nonVisible: 'x' }))).toBeNull()
    expect(signedVisibleText(signatureXml({ visible: '   ', nonVisible: 'x' }))).toBeNull()
  })
})
