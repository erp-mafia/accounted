/**
 * The electronic seal on a signed copy (../pades-seal.ts): the seal is
 * appended to the file it is given, covers all of it, and breaks when a byte
 * changes; several timestamp authorities are asked in turn; and the
 * environment decides whether there is a seal at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { P12Signer, type TimestampAuthority } from '@libpdf/core'
import { PDFDocument } from 'pdf-lib'
import { firstTimestampThatAnswers, loadSigningSeal, sealPdf } from '../pades-seal'
import { onePagePdf, testLogger, type TestLogger } from './fixtures'
import { TEST_SEAL_P12_BASE64, TEST_SEAL_PASSWORD, sealIntegrity } from './seal-fixture'

let pdf: Uint8Array
let signer: P12Signer
let log: TestLogger

beforeAll(async () => {
  pdf = await onePagePdf('Hyresavtal mellan parterna')
  signer = await P12Signer.create(new Uint8Array(Buffer.from(TEST_SEAL_P12_BASE64, 'base64')), TEST_SEAL_PASSWORD)
})

beforeEach(() => {
  log = testLogger()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sealPdf', () => {
  it('appends a PAdES signature that covers the whole file and leaves the file it was given untouched', async () => {
    const sealed = await sealPdf(pdf, { signer, timestampAuthority: null, log })
    expect(sealed.length).toBeGreaterThan(pdf.length)
    expect(Buffer.from(sealed.subarray(0, pdf.length)).equals(Buffer.from(pdf))).toBe(true)
    expect(sealIntegrity(sealed)).toEqual({ coversWholeFile: true, digestMatches: true, subFilter: 'ETSI.CAdES.detached' })
    // Still the same document to a reader that ignores signatures.
    expect((await PDFDocument.load(sealed)).getPageCount()).toBe(1)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('no longer matches once a byte of the sealed file changes', async () => {
    const sealed = await sealPdf(pdf, { signer, timestampAuthority: null, log })
    const tampered = new Uint8Array(sealed)
    tampered[200] = tampered[200]! ^ 0x01
    expect(sealIntegrity(tampered)).toMatchObject({ digestMatches: false })
  })

  it('fails, sealing nothing, when the timestamp authority gives no answer', async () => {
    const down: TimestampAuthority = { timestamp: vi.fn().mockRejectedValue(new Error('tsa down')) }
    await expect(sealPdf(pdf, { signer, timestampAuthority: down, log })).rejects.toThrow('tsa down')
  })
})

describe('firstTimestampThatAnswers', () => {
  const digest = new Uint8Array(32)
  const token = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])

  it('asks each authority in turn and takes the first answer, saying which ones gave none', async () => {
    const first = { timestamp: vi.fn().mockRejectedValue(new Error('timeout')) }
    const second = { timestamp: vi.fn().mockResolvedValue(token) }
    const third = { timestamp: vi.fn() }
    const authority = firstTimestampThatAnswers(
      [
        { url: 'https://tsa-1.example/', authority: first },
        { url: 'https://tsa-2.example/', authority: second },
        { url: 'https://tsa-3.example/', authority: third },
      ],
      log,
    )
    expect(await authority.timestamp(digest, 'SHA-256')).toBe(token)
    expect(second.timestamp).toHaveBeenCalledWith(digest, 'SHA-256')
    expect(third.timestamp).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('timestamp authority did not answer', { url: 'https://tsa-1.example/', error: 'timeout' })
  })

  it('fails with the last authority\'s error when none answers', async () => {
    const authority = firstTimestampThatAnswers(
      [
        { url: 'https://tsa-1.example/', authority: { timestamp: vi.fn().mockRejectedValue(new Error('timeout')) } },
        { url: 'https://tsa-2.example/', authority: { timestamp: vi.fn().mockRejectedValue(new Error('503')) } },
      ],
      log,
    )
    await expect(authority.timestamp(digest, 'SHA-256')).rejects.toThrow('503')
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

describe('loadSigningSeal', () => {
  const on = { SIGNING_SEAL_P12_BASE64: TEST_SEAL_P12_BASE64, SIGNING_SEAL_P12_PASSWORD: TEST_SEAL_PASSWORD, SIGNING_SEAL_TSA_URLS: 'https://tsa-1.example, https://tsa-2.example' }

  it('is no seal while nothing is set, without a word', async () => {
    expect(await loadSigningSeal(log, {})).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('is no seal while the set is half filled, and says what is missing', async () => {
    expect(await loadSigningSeal(log, { SIGNING_SEAL_P12_BASE64: TEST_SEAL_P12_BASE64 })).toBeNull()
    expect(log.warn).toHaveBeenCalledWith('signing seal is half configured, signed copies get no seal', { missing: ['SIGNING_SEAL_P12_PASSWORD', 'SIGNING_SEAL_TSA_URLS'] })
  })

  it('refuses a certificate file its password does not open', async () => {
    await expect(loadSigningSeal(log, { ...on, SIGNING_SEAL_P12_PASSWORD: 'wrong' })).rejects.toThrow()
  })

  it('refuses a certificate outside its validity, and says so in the log during its last 30 days', async () => {
    const seal = await loadSigningSeal(log, on)
    expect(seal!.certificate).toMatchObject({ subject: expect.stringContaining('CN=Test seal'), issuer: expect.stringContaining('CN=Test seal') })
    expect(log.warn).not.toHaveBeenCalled()
    const expires = Date.parse(seal!.certificate.validTo)
    const DAY = 24 * 60 * 60 * 1000

    expect(await loadSigningSeal(log, on, expires - 10 * DAY)).not.toBeNull()
    expect(log.warn).toHaveBeenCalledWith('signing seal certificate runs out soon', { validTo: seal!.certificate.validTo })
    await expect(loadSigningSeal(log, on, expires)).rejects.toThrow('The signing seal certificate is not valid now')
    await expect(loadSigningSeal(log, on, Date.parse(seal!.certificate.validFrom) - DAY)).rejects.toThrow('The signing seal certificate is not valid now')
  })

  it('seals with the configured certificate, asking the configured authorities for the time in order', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        asked.push(String(url))
        throw new Error('no network in tests')
      }),
    )
    const seal = await loadSigningSeal(log, on)
    expect(seal).not.toBeNull()
    // No authority answers here, so the seal fails rather than going out without a trusted time.
    await expect(seal!.apply(pdf)).rejects.toThrow()
    expect(asked).toEqual(['https://tsa-1.example/', 'https://tsa-2.example/'])
    expect(log.warn).toHaveBeenCalledWith('timestamp authority did not answer', expect.objectContaining({ url: 'https://tsa-1.example/' }))
    expect(log.warn).toHaveBeenCalledWith('timestamp authority did not answer', expect.objectContaining({ url: 'https://tsa-2.example/' }))
  })
})
