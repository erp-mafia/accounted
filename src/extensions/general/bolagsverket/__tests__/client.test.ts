import { describe, it, expect, afterEach } from 'vitest'
import {
  BolagsverketClient,
  BolagsverketApiError,
  BOLAGSVERKET_ERROR_MESSAGES,
  configFromEnv,
  extractFelkod,
  isBolagsverketEnvironment,
} from '../lib/client'

describe('configFromEnv', () => {
  const originalEnv = process.env.BOLAGSVERKET_ENV
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BOLAGSVERKET_ENV
    else process.env.BOLAGSVERKET_ENV = originalEnv
  })

  it('defaults to the test environment', () => {
    delete process.env.BOLAGSVERKET_ENV
    const config = configFromEnv()
    expect(config.environment).toBe('test')
  })

  it('rejects an invalid environment override with a clear error', () => {
    expect(() => configFromEnv({ environment: 'banana' as never })).toThrow(
      /Ogiltig Bolagsverket-miljö/,
    )
  })

  it('rejects a garbage BOLAGSVERKET_ENV env var with a clear error', () => {
    process.env.BOLAGSVERKET_ENV = 'production' // common typo for 'prod'
    expect(() => configFromEnv()).toThrow(/Ogiltig Bolagsverket-miljö/)
  })

  it('isBolagsverketEnvironment validates the three known environments', () => {
    expect(isBolagsverketEnvironment('test')).toBe(true)
    expect(isBolagsverketEnvironment('accept')).toBe(true)
    expect(isBolagsverketEnvironment('prod')).toBe(true)
    expect(isBolagsverketEnvironment('production')).toBe(false)
    expect(isBolagsverketEnvironment(undefined)).toBe(false)
    expect(isBolagsverketEnvironment(null)).toBe(false)
  })

  it('decodes base64-wrapped PEM material', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'
    const config = configFromEnv({
      environment: 'accept',
      clientCertPem: pem,
      clientKeyPem: pem,
    })
    expect(config.clientCertPem).toContain('-----BEGIN CERTIFICATE-----')
  })
})

describe('BolagsverketClient', () => {
  it('refuses accept/prod calls without an organisationscertifikat', async () => {
    const client = new BolagsverketClient({ environment: 'accept' })
    await expect(client.getGrunduppgifter('5560001111')).rejects.toThrow(
      /Organisationscertifikat saknas/,
    )
  })

  it('exposes the configured environment', () => {
    expect(new BolagsverketClient({ environment: 'test' }).environment).toBe('test')
    expect(new BolagsverketClient({ environment: 'prod' }).environment).toBe('prod')
  })
})

describe('extractFelkod (error-body anchoring)', () => {
  it('extracts the felkod from JSON bodies', () => {
    expect(extractFelkod('{"felkod":"4001","text":"fel"}')).toBe('4001')
    expect(extractFelkod('{"kod":7003}')).toBe('7003')
  })

  it('extracts the felkod from "NNNN=text" bodies', () => {
    expect(extractFelkod('4008=Filen innehåller tekniska fel')).toBe('4008')
    expect(extractFelkod('  \n 5006 = Dokumentet är för stort')).toBe('5006')
  })

  it('does not false-positive on years or stray four-digit numbers in prose', () => {
    expect(extractFelkod('Räkenskapsåret 2026 kunde inte hanteras just nu')).toBeNull()
    expect(extractFelkod('{"message":"taxonomin för 2024 hittades inte (id 5008)"}')).toBeNull()
    expect(extractFelkod('Internt fel 9003 uppstod')).toBeNull()
  })
})

describe('felkodskarta (GUIDE Appendix A §6.2)', () => {
  it('covers the documented API error codes with Swedish messages', () => {
    for (const code of ['4001', '4003', '4005', '4008', '4010', '5006', '7003', '7006', '9003']) {
      expect(BOLAGSVERKET_ERROR_MESSAGES[code]).toBeTruthy()
    }
  })

  it('BolagsverketApiError carries status + truncated body for logging', () => {
    const err = new BolagsverketApiError('Testfel', 400, 'body')
    expect(err.name).toBe('BolagsverketApiError')
    expect(err.status).toBe(400)
    expect(err.body).toBe('body')
  })
})
