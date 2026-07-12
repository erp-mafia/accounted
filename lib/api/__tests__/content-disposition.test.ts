import { describe, it, expect } from 'vitest'
import { contentDisposition } from '../content-disposition'

describe('contentDisposition', () => {
  it('passes a plain ASCII filename through unchanged in both forms', () => {
    expect(contentDisposition('inline', 'kvitto.pdf')).toBe(
      `inline; filename="kvitto.pdf"; filename*=UTF-8''kvitto.pdf`,
    )
  })

  it('supports the attachment type', () => {
    expect(contentDisposition('attachment', 'report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    )
  })

  it('produces a ByteString-safe value for an NFD Swedish filename', () => {
    // macOS/iOS NFD upload: base letter + combining diaeresis U+0308 (776),
    // the exact shape that crashed the inline route in prod.
    const nfd = 'kvitto fo\u0308rvaring.pdf'
    expect(nfd.charCodeAt(9)).toBe(776)

    const header = contentDisposition('inline', nfd)

    const maxCode = Math.max(...[...header].map((c) => c.charCodeAt(0)))
    expect(maxCode).toBeLessThanOrEqual(255)
    // The whole header is in fact printable ASCII.
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true)
    // filename* carries the NFC-composed UTF-8 percent-encoding of the name.
    expect(header).toContain(`filename*=UTF-8''kvitto%20f%C3%B6rvaring.pdf`)
    // The quoted fallback replaces the non-ASCII character with _.
    expect(header).toContain('filename="kvitto f_rvaring.pdf"')
  })

  it('is stable across NFD and NFC inputs of the same name', () => {
    const nfd = 'lo\u0308n.pdf' // o + combining diaeresis
    const nfc = 'l\u00f6n.pdf' // precomposed \u00f6
    expect(contentDisposition('inline', nfd)).toBe(contentDisposition('inline', nfc))
  })

  it('does not throw when used as an undici Headers value', () => {
    const nfd = 'lo\u0308nespec_a\u030agren.pdf'
    expect(
      () => new Headers({ 'Content-Disposition': contentDisposition('inline', nfd) }),
    ).not.toThrow()
  })

  it('neutralizes quote and CRLF header injection', () => {
    const header = contentDisposition('attachment', 'evil"\r\nSet-Cookie: x=y.pdf')
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')
    expect(header).toContain('filename="evil___Set-Cookie: x=y.pdf"')
    // The extended form percent-encodes them instead of emitting them raw.
    expect(header).toContain('%0D%0A')
  })

  it('replaces backslash in the quoted fallback', () => {
    expect(contentDisposition('inline', 'a\\b.pdf')).toContain('filename="a_b.pdf"')
  })

  it(`percent-escapes ! ' ( ) * which encodeURIComponent leaves bare`, () => {
    const header = contentDisposition('inline', "a!'()*.pdf")
    expect(header).toContain(`filename*=UTF-8''a%21%27%28%29%2A.pdf`)
  })

  it('sanitizes a lone high surrogate instead of throwing', () => {
    let header = ''
    expect(() => {
      header = contentDisposition('attachment', '\uD800')
    }).not.toThrow()
    // The lone surrogate becomes U+FFFD: _ in the fallback, percent-encoded
    // UTF-8 (%EF%BF%BD) in the extended form.
    expect(header).toBe(`attachment; filename="_"; filename*=UTF-8''%EF%BF%BD`)
    expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow()
  })

  it('sanitizes an embedded unpaired surrogate and keeps the rest of the name', () => {
    let header = ''
    expect(() => {
      header = contentDisposition('inline', 'a\uD800b')
    }).not.toThrow()
    expect(header).toBe(`inline; filename="a_b"; filename*=UTF-8''a%EF%BF%BDb`)
    expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow()
  })

  it('keeps a valid surrogate pair (emoji) working unchanged', () => {
    const header = contentDisposition('inline', 'r😀.pdf')
    expect(header).toBe(`inline; filename="r__.pdf"; filename*=UTF-8''r%F0%9F%98%80.pdf`)
    expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow()
  })
})
