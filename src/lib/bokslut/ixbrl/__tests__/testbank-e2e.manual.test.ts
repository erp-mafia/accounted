/**
 * Manual E2E against Bolagsverket's testbänk (static test data). Skipped
 * unless BOLAGSVERKET_TESTBANK_E2E=1: requires the firewall opening for our
 * public IP (ordered via api@bolagsverket.se, confirmed 2026-06-18).
 *
 * Run: BOLAGSVERKET_TESTBANK_E2E=1 npx vitest run lib/bokslut/ixbrl/__tests__/testbank-e2e.manual.test.ts
 */
import { describe, expect, it } from 'vitest'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { makeInput } from './fixtures'

const BASE = 'https://api-accept2.bolagsverket.se/testapi'
// Static test env only accepts these (ANSLUTNINGSANVISNING §3.1); the pnr
// must match (19|20)\d{10} and pass Luhn: GUIDE's documented 190001010106
// fails Luhn, 190001010107 passes and is accepted.
const PNR = '190001010107'
const ORGNR = '1234567890'

const enabled = process.env.BOLAGSVERKET_TESTBANK_E2E === '1'

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, unknown> }
}

describe.skipIf(!enabled)('Bolagsverket testbänk E2E', () => {
  it('grunduppgifter returns the static test company', async () => {
    const res = await fetch(`${BASE}/hamta-arsredovisningsinformation/v1.4/grunduppgifter/${ORGNR}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { orgnr: string; namn: string }
    expect(json.orgnr).toBe(ORGNR)
    expect(json.namn).toBeTruthy()
    console.log('grunduppgifter:', json.namn)
  })

  it('skapa-inlamningtoken then kontrollera accepts our generated K2 document', async () => {
    const input = makeInput()
    input.company.orgNumber = '123456-7890'
    input.company.name = 'Aktiebolaget Specifik Konsult'
    const { xhtml } = generateK2IxbrlDocument(input)
    console.log(`generated iXBRL: ${(xhtml.length / 1024).toFixed(1)} KiB`)

    const tokenRes = await post('/lamna-in-arsredovisning/v2.1/skapa-inlamningtoken/', {
      pnr: PNR,
      orgnr: ORGNR,
    })
    expect(tokenRes.status).toBe(200)
    const token = tokenRes.json.token as string
    expect(token).toBeTruthy()

    const kontrollRes = await post(`/lamna-in-arsredovisning/v2.1/kontrollera/${token}`, {
      handling: { fil: Buffer.from(xhtml, 'utf8').toString('base64'), typ: 'arsredovisning_komplett' },
    })
    console.log('kontrollera status:', kontrollRes.status)
    console.log(JSON.stringify(kontrollRes.json, null, 2))
    expect(kontrollRes.status).toBe(200)
    // kontrollera answers 200 even for invalid documents; the validation
    // outcome lives in utfall, so acceptance means zero error entries.
    expect(kontrollRes.json.utfall).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ typ: 'error' })]),
    )
  }, 120_000)
})
