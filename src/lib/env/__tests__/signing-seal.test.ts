import { describe, expect, it } from 'vitest'
import { signingSealConfig } from '../signing-seal'

describe('signing seal settings (SIGNING_SEAL_*)', () => {
  const all = { SIGNING_SEAL_P12_BASE64: 'TUlJ\nS0Z3\n', SIGNING_SEAL_P12_PASSWORD: ' pass word ', SIGNING_SEAL_TSA_URLS: 'http://tsa-1.example, https://tsa-2.example/tsr ,' }

  it('is off while nothing is set', () => {
    expect(signingSealConfig({})).toEqual({ state: 'off' })
    expect(signingSealConfig({ SIGNING_SEAL_P12_BASE64: ' ', SIGNING_SEAL_TSA_URLS: '' })).toEqual({ state: 'off' })
  })

  it('is on with all three: the file without its line breaks, the password as written, the authorities in order', () => {
    expect(signingSealConfig(all)).toEqual({
      state: 'on',
      p12Base64: 'TUlJS0Z3',
      password: ' pass word ',
      timestampUrls: ['http://tsa-1.example/', 'https://tsa-2.example/tsr'],
    })
  })

  it('names what is missing from a half-filled set', () => {
    expect(signingSealConfig({ SIGNING_SEAL_P12_BASE64: 'TUlJ' })).toEqual({ state: 'incomplete', missing: ['SIGNING_SEAL_P12_PASSWORD', 'SIGNING_SEAL_TSA_URLS'] })
    expect(signingSealConfig({ ...all, SIGNING_SEAL_P12_BASE64: undefined })).toEqual({ state: 'incomplete', missing: ['SIGNING_SEAL_P12_BASE64'] })
  })

  it('counts an authority only when it is an http(s) address, each once', () => {
    expect(signingSealConfig({ ...all, SIGNING_SEAL_TSA_URLS: 'tsa.example, ftp://tsa.example' })).toEqual({ state: 'incomplete', missing: ['SIGNING_SEAL_TSA_URLS'] })
    expect(signingSealConfig({ ...all, SIGNING_SEAL_TSA_URLS: 'https://tsa.example, not a url, https://tsa.example/' })).toMatchObject({ state: 'on', timestampUrls: ['https://tsa.example/'] })
  })
})
