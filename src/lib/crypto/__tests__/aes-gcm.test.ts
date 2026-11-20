/**
 * Every value stored today must still open after the encryption copies moved
 * onto lib/crypto/aes-gcm.ts. Each fixture was sealed by the code this
 * replaced (2026-10-12), with the test keys below: none is a real secret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openAesGcm, sealAesGcm, sha256Key } from '../aes-gcm'

vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn() }))

const FIXTURES = {
  cloudBackup: "erjLXccQo8i9LClAbH9_5AcyLSyxaYeqD6wEnujxCUKRf8hEK8Ur_YxRGcgaz_k",
  mailDerived: "qzwPgp2wukYmJr-i22XO-Bbh-VPRAzCwbSyUiNjZH0b7ji30xhPO_HnEXjjXqw",
  mailDedicated: "v2.-QDFoeg0O7lms7OIj33QNFRCN9hlD9wlJI-1-n7Iwmz95tXeTBXOFngRcY8Rs31FUA",
  shopify: "RWmp0kMXQtSbCtFRjc2DTFVRWzSXtTTLGJGwUoVq36krvoEh7BnsEah9R0sFnrMW7w",
  woocommerce: "xSRiMZVbniVrDTBNu6CAEPk2tigbYO5bleiyFYH67c0iKoKhwJBqENhatZdixHE",
  zettle: "UKbOHO6uK8z6hWoeSSe7DPbbqi4McLdLZKIpuVO2kz2hsjAST-KoiQTTvg1jVNeW",
  handoff: "v1:HZad11u_fD5qlVvDGHx_Uy8-QPPsBMjO3XURELJW28VitjlHogU9T818",
  oauthFlow: "v1:iWnw8bmPJLiiezKPeLsk8Cxuyld7SErqm4Lr2O5Ti3j_1xhM6mxH",
  oauthCode: "Y4UxQApXGv1O9wXxdPQVEYe6nWGha-t3av86bmyvsFU8bBL72kH1K2S4nyHXkEAJ5vetCNRbNQ-wABwGV-Uq5Lb9q1DOwKnuo4bOg_eHAiA0DCJVSgs3czGUt5Fn21IxP6KDS_Ecfh1OvhWMt24FfcHuTOyx2Odkxttu834JtpxHbQ0jTwbNCGwwkLeonbj-__luYySfXqQixKBTiCQa4bcbX0niwfX-tktnb5mZo8-yjAL1929lH0UwAgNcNALBeWxxKqF2n7D6",
  whatsappPhone: "6a5161747fe2a204b76a25ab2e3ce7e13e8d5629aea73cc833f47f35092386a47455f9ec67434d",
  bankid: "\\x19cbb84cc157730f3853e2d91046842a8d197a9fb11f7bd5a63cbdbb5199c58cea14c19c34906e57",
  migrationPayload: "Uo+gbOAaSFQkPKNh9z1v3xfbZFTEZ8lgSUqBpD0VTQdX6I+xzxCK+Va6OpOCAetiynkLYSs=",
  skatteverket: "ib18kHGNMXRgUhDel4cZgAS63Y1KQK-mUHVpiZJbaDG8L7p7KM2HPNdVtno",
}

const ENV = {
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
  MAIL_TOKEN_ENCRYPTION_KEY: '33'.repeat(32),
  SHOPIFY_CREDENTIALS_ENCRYPTION_KEY: 'fixture-shopify-key',
  WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY: 'fixture-woocommerce-key',
  ZETTLE_CREDENTIALS_ENCRYPTION_KEY: 'fixture-zettle-key',
  SKATTEVERKET_TOKEN_ENCRYPTION_KEY: 'fixture-skatteverket-key',
  WHATSAPP_PHONE_ENCRYPTION_KEY: '11'.repeat(32),
  BANKID_ENCRYPTION_KEY: '22'.repeat(32),
  PERSONNUMMER_ENCRYPTION_KEY: 'fixture-personnummer-key',
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('aes-gcm', () => {
  it('opens what it seals, and refuses a wrong key or AAD', () => {
    const key = sha256Key('k')
    const sealed = sealAesGcm(key, 'hemligt', 'ctx')
    expect(openAesGcm(key, sealed, 'ctx')).toBe('hemligt')
    expect(() => openAesGcm(sha256Key('other'), sealed, 'ctx')).toThrow()
    expect(() => openAesGcm(key, sealed, 'other-ctx')).toThrow()
  })

  it('seals with a fresh IV every time', () => {
    const key = sha256Key('k')
    expect(sealAesGcm(key, 'x').equals(sealAesGcm(key, 'x'))).toBe(false)
  })
})

describe('values stored by the code aes-gcm replaced still open', () => {
  it('cloud-backup refresh tokens', async () => {
    const { decryptToken } = await import('@/extensions/general/cloud-backup/lib/crypto')
    expect(decryptToken(FIXTURES.cloudBackup)).toBe('cloud-refresh-token')
  })

  it('mail tokens, derived (v1) and dedicated-key (v2.)', async () => {
    const { decryptToken } = await import('@/extensions/general/mail/lib/crypto')
    expect(decryptToken(FIXTURES.mailDerived)).toBe('mail-refresh-token')
    expect(decryptToken(FIXTURES.mailDedicated)).toBe('mail-refresh-token-v2')
  })

  it('webshop credentials', async () => {
    const shopify = await import('@/extensions/general/shopify/lib/credentials')
    const woo = await import('@/extensions/general/woocommerce/lib/credentials')
    const zettle = await import('@/extensions/general/zettle/lib/credentials')
    expect(shopify.decryptCredential(FIXTURES.shopify)).toBe('shopify-client-secret')
    expect(woo.decryptCredential(FIXTURES.woocommerce)).toBe('woo-consumer-secret')
    expect(zettle.decryptCredential(FIXTURES.zettle)).toBe('zettle-refresh-token')
  })

  it('OAuth handoff and flow values, bound to their context', async () => {
    const handoff = await import('@/extensions/general/arcim-migration/lib/handoff-crypto')
    const flow = await import('@/lib/auth/oauth-flow-crypto')
    expect(handoff.decryptHandoffValue(FIXTURES.handoff, 'consent-1')).toBe('handoff-secret')
    expect(() => handoff.decryptHandoffValue(FIXTURES.handoff, 'consent-2')).toThrow()
    expect(flow.decryptOAuthFlowValue(FIXTURES.oauthFlow, 'flow-1')).toBe('flow-secret')
  })

  it('MCP OAuth auth codes', async () => {
    vi.useFakeTimers()
    // Before the fixture's 5-minute expiry.
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'))
    const { decryptAuthCode } = await import('@/lib/auth/oauth-codes')
    expect(decryptAuthCode(FIXTURES.oauthCode)).toMatchObject({ userId: 'user-1', codeChallenge: 'challenge' })
  })

  it('WhatsApp phone numbers (hex)', async () => {
    const { decryptPhone } = await import('@/extensions/general/whatsapp-inbox/lib/phone-crypto')
    expect(decryptPhone(FIXTURES.whatsappPhone)).toBe('46701234567')
  })

  it('BankID personnummer (bytea hex)', async () => {
    const { decryptStoredPersonalNumber } = await import('@/lib/auth/bankid')
    expect(decryptStoredPersonalNumber(FIXTURES.bankid)).toBe('199001011234')
  })

  it('provider migration payloads (base64)', async () => {
    const { openMigrationPayload } = await import('@/lib/providers/migration-payload')
    expect(openMigrationPayload(FIXTURES.migrationPayload)).toEqual({ name: 'Kund AB', nr: 1 })
  })

  it('Skatteverket tokens', () => {
    // token-store keeps encrypt/decrypt private: its key derivation, opened here.
    const key = sha256Key(ENV.SKATTEVERKET_TOKEN_ENCRYPTION_KEY)
    expect(openAesGcm(key, Buffer.from(FIXTURES.skatteverket, 'base64url'))).toBe('skv-access-token')
  })
})
