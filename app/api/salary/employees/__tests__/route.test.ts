/**
 * Regression test for the plaintext-personnummer crash, plus auth wiring.
 *
 * GET /api/salary/employees decrypts every employee's personnummer on read and
 * maps over the whole roster. A row whose personnummer was stored UNENCRYPTED
 * (a pre-fix v1 REST create, or a seed) used to throw
 * ERR_CRYPTO_INVALID_AUTH_TAG ("Invalid authentication tag length: 6") inside
 * the .map(), 500-ing the entire endpoint for the affected company. The decrypt
 * helper now passes a raw 12-digit value through unchanged, so a mixed
 * encrypted/plaintext table no longer takes the roster down.
 *
 * The route now runs through the withRouteContext wrapper, so we mock its
 * auth/company/write dependencies and inject the Supabase client via requireAuth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn(),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

// Synthetic 12-digit values (year 1900 / 1902, zero suffix): obviously not
// real birthdates. ISO A.5.34 / GDPR Art.5(1)(c): fixtures must not look like
// production PII.
const PLAINTEXT_PNR = '190001010000'
const ENCRYPTED_PNR = encryptPersonnummer('190203040000')

function supabaseWithRows(rows: unknown[]) {
  const query: Record<string, unknown> = {}
  query.select = vi.fn(() => query)
  query.eq = vi.fn(() => query)
  query.order = vi.fn(() => Promise.resolve({ data: rows, error: null }))
  return { from: vi.fn(() => query) }
}

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: supabase as never,
    error: null,
  } as never)
}

function req() {
  return new Request('https://x.test/api/salary/employees')
}

const params = { params: Promise.resolve({}) } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/salary/employees', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)

    const res = await GET(req(), params)
    expect(res.status).toBe(401)
  })

  it('does not 500 on a mixed plaintext + encrypted roster; masks both', async () => {
    authed(
      supabaseWithRows([
        { id: 'e1', last_name: 'A', personnummer: PLAINTEXT_PNR, personnummer_last4: '0000' },
        { id: 'e2', last_name: 'B', personnummer: ENCRYPTED_PNR, personnummer_last4: '0000' },
      ]),
    )

    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Both rows masked birthdate-visible, last-4 hidden.
    expect(body.data[0].personnummer_masked).toBe('19000101-XXXX')
    expect(body.data[1].personnummer_masked).toBe('19020304-XXXX')
    // Neither the plaintext nor the stored ciphertext may leak.
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_PNR)
    expect(JSON.stringify(body)).not.toContain(ENCRYPTED_PNR)
  })

  it('never returns the mask under the writable `personnummer` key', async () => {
    // The roster feeds edit forms. If the mask came back as `personnummer`, a
    // client that reads a row and writes it back would post 'ÅÅÅÅMMDD-XXXX'
    // into the encrypt path. The masked value lives under `personnummer_masked`
    // so the read key and the write key can never be confused.
    authed(supabaseWithRows([{ id: 'e1', last_name: 'A', personnummer: ENCRYPTED_PNR }]))

    const res = await GET(req(), params)
    const body = await res.json()
    expect(body.data[0].personnummer).toBeUndefined()
    expect('personnummer' in body.data[0]).toBe(false)
    expect(body.data[0].personnummer_masked).toBe('19020304-XXXX')
  })

  it('strips personnummer_last4 so the mask cannot be reassembled', async () => {
    // The mask is YYYYMMDD-XXXX. A response carrying the mask AND the last
    // four digits hands the client the full personnummer by concatenation, so
    // personnummer_last4 must never ride along with the roster rows.
    authed(
      supabaseWithRows([
        { id: 'e1', last_name: 'A', personnummer: ENCRYPTED_PNR, personnummer_last4: '0000' },
      ]),
    )

    const res = await GET(req(), params)
    const body = await res.json()
    expect(body.data[0]).not.toHaveProperty('personnummer_last4')
    expect(body.data[0]).not.toHaveProperty('personnummer')
    expect(body.data[0].personnummer_masked).toBe('19020304-XXXX')
  })
})

describe('POST /api/salary/employees', () => {
  // Luhn-valid synthetic personnummer (checksum verified in personnummer.test.ts).
  const NEW_PNR = '199001019802'

  function supabaseWithInsert(returned: Record<string, unknown>) {
    const single = vi.fn(() => Promise.resolve({ data: returned, error: null }))
    const select = vi.fn(() => ({ single }))
    const insert = vi.fn((_payload: Record<string, unknown>) => ({ select }))
    return { supabase: { from: vi.fn(() => ({ insert })) }, insert }
  }

  it('create response carries the mask only: no ciphertext, no last4', async () => {
    const inserted = {
      id: 'emp-new',
      company_id: 'company-1',
      first_name: 'Test',
      last_name: 'Testsson',
      personnummer: encryptPersonnummer(NEW_PNR),
      personnummer_last4: '9802',
      employment_type: 'employee',
    }
    const { supabase } = supabaseWithInsert(inserted)
    authed(supabase)

    const res = await POST(
      new Request('https://x.test/api/salary/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: 'Test',
          last_name: 'Testsson',
          personnummer: NEW_PNR,
          employment_start: '2026-01-01',
          monthly_salary: 30000,
          tax_table_number: 34,
          tax_municipality: 'Stockholm',
        }),
      }),
      params,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.personnummer_masked).toBe('19900101-XXXX')
    expect(body.data).not.toHaveProperty('personnummer')
    expect(body.data).not.toHaveProperty('personnummer_last4')
    // Neither the full personnummer nor its suffix may appear anywhere in the
    // serialized response: mask + last4 would reassemble the identity.
    expect(JSON.stringify(body)).not.toContain(NEW_PNR)
    expect(JSON.stringify(body)).not.toContain('9802')
  })

  // #1913: the NewEmployeeDialog sends the jämkning beslut on create; pin that
  // the insert carries it, and that omitting it inserts nulls (no beslut).
  const CREATE_BASE = {
    first_name: 'Test',
    last_name: 'Testsson',
    personnummer: NEW_PNR,
    employment_start: '2026-01-01',
    monthly_salary: 30000,
    tax_table_number: 34,
    tax_municipality: 'Stockholm',
  }

  function postRequest(body: Record<string, unknown>) {
    return new Request('https://x.test/api/salary/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('inserts the jämkning percentage and validity when provided', async () => {
    const { supabase, insert } = supabaseWithInsert({ id: 'emp-new', personnummer: encryptPersonnummer(NEW_PNR) })
    authed(supabase)

    const res = await POST(
      postRequest({
        ...CREATE_BASE,
        jamkning_percentage: 12.5,
        jamkning_valid_from: '2026-01-01',
        jamkning_valid_to: '2026-12-31',
      }),
      params,
    )

    expect(res.status).toBe(201)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      jamkning_percentage: 12.5,
      jamkning_valid_from: '2026-01-01',
      jamkning_valid_to: '2026-12-31',
    })
  })

  it('inserts null jämkning fields when the body omits them', async () => {
    const { supabase, insert } = supabaseWithInsert({ id: 'emp-new', personnummer: encryptPersonnummer(NEW_PNR) })
    authed(supabase)

    const res = await POST(postRequest(CREATE_BASE), params)

    expect(res.status).toBe(201)
    expect(insert.mock.calls[0][0]).toMatchObject({
      jamkning_percentage: null,
      jamkning_valid_from: null,
      jamkning_valid_to: null,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)

    const res = await POST(postRequest(CREATE_BASE), params)
    expect(res.status).toBe(401)
  })

  it('returns 400 on a personnummer that fails the checksum, without inserting', async () => {
    const { supabase, insert } = supabaseWithInsert({ id: 'emp-new' })
    authed(supabase)

    const res = await POST(postRequest({ ...CREATE_BASE, personnummer: '199001019803' }), params)

    expect(res.status).toBe(400)
    expect(insert).not.toHaveBeenCalled()
  })

  // #1996: the deployment that filed the issue had no PERSONNUMMER_ENCRYPTION_KEY.
  // The encrypt helper used to throw a bare Error, which the wrapper answered
  // with the generic INTERNAL_ERROR 500 ("try again later") even though no
  // retry can ever succeed. It now carries a registry code, so the envelope
  // names the configuration gap, points at support, and keeps the requestId.
  describe('missing PERSONNUMMER_ENCRYPTION_KEY in production', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('answers 503 PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED with a requestId and no insert', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
      const { supabase, insert } = supabaseWithInsert({ id: 'emp-new' })
      authed(supabase)

      const res = await POST(postRequest(CREATE_BASE), params)

      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error.code).toBe('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
      expect(body.error.message).toContain('PERSONNUMMER_ENCRYPTION_KEY')
      expect(body.error.message).toMatch(/Kontakta supporten/)
      expect(body.error.message_en).toContain('PERSONNUMMER_ENCRYPTION_KEY')
      expect(body.error.requestId).toMatch(/^req_/)
      expect(res.headers.get('X-Request-Id')).toBe(body.error.requestId)
      // The failure happens before the database is touched: nothing to clean up.
      expect(supabase.from).not.toHaveBeenCalled()
      expect(insert).not.toHaveBeenCalled()
      // The personnummer itself must never leak into the error envelope.
      expect(JSON.stringify(body)).not.toContain(NEW_PNR)
    })
  })
})
