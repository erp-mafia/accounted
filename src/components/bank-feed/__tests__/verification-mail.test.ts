import { describe, expect, it } from 'vitest'
import { resumeFlowUrl, verificationMailto } from '../verification-mail'

describe('verificationMailto', () => {
  it('builds a mailto with the subject and a two-line body ending in the link', () => {
    const href = verificationMailto({
      subject: 'Verifiering för bankbetalningar',
      lines: ['Hej, kan du verifiera företaget hos betalningsleverantören?', 'Länken gäller 24 timmar och signeras med BankID.'],
      url: 'https://verify.example.se/form?token=a%20b&x=1',
    })
    expect(href.startsWith('mailto:?subject=Verifiering%20f%C3%B6r%20bankbetalningar&body=')).toBe(true)
    const body = decodeURIComponent(href.split('&body=')[1])
    expect(body).toBe(
      'Hej, kan du verifiera företaget hos betalningsleverantören?\nLänken gäller 24 timmar och signeras med BankID.\n\nhttps://verify.example.se/form?token=a%20b&x=1',
    )
    // The ampersand inside the link must not split the mailto's own parameters.
    expect(href.split('&').length).toBe(2)
  })
})

describe('resumeFlowUrl', () => {
  it('points the second signatory at Kopplingar with the connection named', () => {
    expect(resumeFlowUrl('https://app.accounted.se', '0b1c')).toBe('https://app.accounted.se/settings/connections?bank_connect=0b1c')
  })
})
