/**
 * Enable Banking, all the way into the database.
 *
 * The contract test next door proves the client speaks the protocol. This one
 * proves the money lands correctly: it runs the real syncAccountTransactions()
 * against the fake bank API and a real local Postgres carrying every migration,
 * then reads the `transactions` rows back and checks them.
 *
 * Requires the local stack. Start it with:
 *   bash tests/e2e/setup-env.sh
 *   set -a && . ./.env.e2e && set +a
 *
 * Skips itself when the stack is not configured, so `npm test` and CI stay
 * green without it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as crypto from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Only run against a LOCAL stack. A remote URL here would mean the suite is
// pointed at a real project, which must never happen.
const isLocal =
  !!SUPABASE_URL && /^(http:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/.test(SUPABASE_URL)
const enabled = isLocal && !!SERVICE_KEY

let admin: SupabaseClient
let fake: { url: string; scenario: Record<string, unknown>; close: () => Promise<void> }
let sync: typeof import('@/extensions/general/enable-banking/lib/sync')

const companyId = crypto.randomUUID()
const connectionId = crypto.randomUUID()
let userId: string

const SEK_ACCOUNT = {
  uid: 'acc-sek-0000-0000-0000-000000000001',
  iban: 'SE4550000000058398257466',
  name: 'Företagskonto',
  currency: 'SEK',
  enabled: true,
  ledger_account: '1930',
}

describe.skipIf(!enabled)('enable banking sync into the database', () => {
  beforeAll(async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })

    const mod = await import('../fakes/enable-banking-server.mjs')
    fake = await mod.startFakeEnableBanking({ publicKey })

    process.env.ENABLE_BANKING_API_URL = fake.url
    process.env.ENABLE_BANKING_API_URL_PRODUCTION = ''
    process.env.ENABLE_BANKING_APP_ID = 'e2e-test-app-id'
    process.env.ENABLE_BANKING_APP_ID_PRODUCTION = ''
    process.env.ENABLE_BANKING_PRIVATE_KEY = Buffer.from(privateKey).toString('base64')
    process.env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION = ''

    admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const email = `e2e-${Date.now()}@example.test`
    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email,
      password: 'e2e-password-that-is-long-enough',
      email_confirm: true,
    })
    if (userError) throw userError
    userId = created.user!.id

    const { error: companyError } = await admin.from('companies').insert({
      id: companyId,
      name: 'E2E Testbolag AB',
      entity_type: 'aktiebolag',
      created_by: userId,
    })
    if (companyError) throw companyError

    const { error: memberError } = await admin
      .from('company_members')
      .insert({ company_id: companyId, user_id: userId })
    if (memberError) throw memberError

    // The consent row a real connect flow would have written. Sync takes its
    // id, so this has to exist rather than be a made-up string.
    const { error: connectionError } = await admin.from('bank_connections').insert({
      id: connectionId,
      user_id: userId,
      company_id: companyId,
      provider: 'enablebanking',
      bank_name: 'Swedbank',
      session_id: 'e2e-session',
      status: 'active',
      psu_type: 'business',
      consent_expires: new Date(Date.now() + 90 * 86400000).toISOString(),
      accounts_data: [SEK_ACCOUNT],
    })
    if (connectionError) throw connectionError

    sync = await import('@/extensions/general/enable-banking/lib/sync')
  })

  afterAll(async () => {
    if (admin && companyId) {
      await admin.from('transactions').delete().eq('company_id', companyId)
      await admin.from('bank_connections').delete().eq('company_id', companyId)
      await admin.from('company_members').delete().eq('company_id', companyId)
      await admin.from('companies').delete().eq('id', companyId)
    }
    if (userId) await admin?.auth.admin.deleteUser(userId)
    await fake?.close()
  })

  const window = () => {
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
    return { from, to }
  }

  it('imports every transaction from the bank', async () => {
    const { from, to } = window()

    // SyncResult reports an error count but not the reason. Wrapping the real
    // ingest keeps the underlying Postgres error so a failure here names the
    // constraint instead of just saying "0 rows".
    const { ingestTransactions } = await import('@/lib/transactions/ingest')
    let firstError: unknown = null
    const ingest: typeof ingestTransactions = async (...args) => {
      const r = await ingestTransactions(...args)
      if (!firstError && r.first_error) firstError = r.first_error
      return r
    }

    const result = await sync.syncAccountTransactions(
      admin,
      companyId,
      userId,
      connectionId,
      SEK_ACCOUNT,
      from,
      to,
      ingest
    )

    expect(result.errors, `ingest failed: ${JSON.stringify(firstError)}`).toBe(0)
    expect(result.imported).toBe(20)

    const { data, error } = await admin
      .from('transactions')
      .select('date, description, amount, external_id')
      .eq('company_id', companyId)
      .order('date', { ascending: false })

    expect(error).toBeNull()
    expect(data).toHaveLength(20)
  })

  it('gets the signs right: money in positive, money out negative', async () => {
    const { data } = await admin
      .from('transactions')
      .select('description, amount')
      .eq('company_id', companyId)

    const rows = data ?? []
    const incoming = rows.filter((r) => Number(r.amount) > 0)
    const outgoing = rows.filter((r) => Number(r.amount) < 0)

    // 6 CRDT and 14 DBIT in the fixture.
    expect(incoming).toHaveLength(6)
    expect(outgoing).toHaveLength(14)

    // Tax payments are the sign error that hurts most: booked the wrong way
    // round they turn a skattekonto payment into income.
    const skatt = rows.find((r) => (r.description ?? '').includes('skattekonto'))
    expect(skatt).toBeDefined()
    expect(Number(skatt!.amount)).toBeLessThan(0)
  })

  it('keeps öre intact', async () => {
    const { data } = await admin
      .from('transactions')
      .select('amount')
      .eq('company_id', companyId)

    const amounts = (data ?? []).map((r) => Number(r.amount))
    // 7350.25 in, 62.75 out: both must survive the numeric round trip exactly.
    expect(amounts).toContain(7350.25)
    expect(amounts).toContain(-62.75)

    // Nothing may carry sub-öre precision.
    for (const a of amounts) {
      expect(Math.round(a * 100) / 100).toBe(a)
    }
  })

  it('is idempotent: a second sync imports nothing new', async () => {
    const { from, to } = window()

    const before = await admin
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)

    await sync.syncAccountTransactions(
      admin,
      companyId,
      userId,
      connectionId,
      SEK_ACCOUNT,
      from,
      to
    )

    const after = await admin
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)

    // Re-running a sync is routine (nightly cron, manual refresh, reconnect).
    // Duplicated rows here would mean double-booked bank lines.
    expect(after.count).toBe(before.count)
  })

  it('gives every transaction a stable external id', async () => {
    const { data } = await admin
      .from('transactions')
      .select('external_id')
      .eq('company_id', companyId)

    const ids = (data ?? []).map((r) => r.external_id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('describes every transaction, including the ones the bank left blank', async () => {
    const { data } = await admin
      .from('transactions')
      .select('description, counterparty_account, bank_transaction_code')
      .eq('company_id', companyId)

    const rows = data ?? []
    const descriptions = rows.map((r) => r.description ?? '')

    // The bank's own payment message wins: it is what carries the OCR and the
    // invoice number that invoice matching keys off.
    expect(descriptions).toContain('Betalning faktura 2026-114 OCR 1141234567890')
    expect(descriptions).toContain('Inbetalning skattekonto 16556677-8899')

    // The fee row has no remittance text and no counterparty at all, which is
    // exactly where a bank feed usually produces a blank line. It must still
    // come out with a readable Swedish label.
    const fee = rows.find((r) => r.bank_transaction_code === 'PMNT-RCDT-CHRG')
    expect(fee).toBeDefined()
    expect(fee!.description?.trim()).toBeTruthy()
    expect(fee!.description).not.toBe('Okänd transaktion')

    // Nothing may land blank: an empty description is unbookable in the UI.
    expect(descriptions.every((d) => d.trim().length > 0)).toBe(true)
  })
})
