import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import { createServiceRoleClient } from '../../src/lib/supabase/service-client'
import { invoiceFixture, providerPage, type LoadProvider } from './fixtures'

const PROJECT = 'metjnjrhvujscngnpzdv'
const { values } = parseArgs({ options: {
  env: { type: 'string', default: '.env.provider-load.local' },
  provider: { type: 'string', default: 'both' }, count: { type: 'string', default: '25000' },
  budget: { type: 'string', default: '60000' }, 'detail-every': { type: 'string', default: '0' },
  'delay-ms': { type: 'string', default: '0' }, report: { type: 'string', default: '.env.provider-load-report.json' },
  child: { type: 'boolean', default: false }, job: { type: 'string' }, fault: { type: 'string' },
  'rate-limit': { type: 'boolean', default: false },
} })
const count = Number(values.count), budget = Number(values.budget)
const detailEvery = Number(values['detail-every']), delay = Number(values['delay-ms'])
assert.ok(Number.isInteger(count) && count >= 30 && count <= 100000)
assert.ok(Number.isInteger(budget) && budget >= 15000 && budget <= 210000)
assert.ok(Number.isInteger(detailEvery) && detailEvery >= 0)
assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 10000)
assert.ok(['visma', 'bokio', 'both'].includes(values.provider!))
assert.notEqual(basename(values.env!), '.env.local', 'Never load the production env file')
const config = dotenv.parse(readFileSync(resolve(values.env!)))
const url = config.NEXT_PUBLIC_SUPABASE_URL ?? config.SUPABASE_URL
const key = config.SUPABASE_SERVICE_ROLE_KEY ?? config.SERVICE_ROLE_KEY
assert.equal(url, `https://${PROJECT}.supabase.co`, 'This harness only writes to erp-base staging')
assert.ok(key, 'A staging service-role key is required; never paste it into logs')
// Deliberately copy only these settings, never mail, analytics, or Redis credentials.
process.env.NEXT_PUBLIC_SUPABASE_URL = url
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = config.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? config.SUPABASE_ANON_KEY ?? 'synthetic-unused-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = key
process.env.PERSONNUMMER_ENCRYPTION_KEY = 'synthetic-provider-load-test-only'
for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_STORAGE_KV_REST_API_URL', 'UPSTASH_STORAGE_KV_REST_API_TOKEN']) delete process.env[name]
Object.assign(process.env, { NODE_ENV: 'test' })
const originalFetch = globalThis.fetch
const client = () => createServiceRoleClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => originalFetch(input, { ...init, signal: AbortSignal.timeout(30000) }) } })
const db = client()
async function checked<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const result = await query
  if (result.error) throw new Error(result.error.message)
  return result.data
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

async function child() {
  assert.ok(values.job)
  const provider = values.provider as LoadProvider
  assert.notEqual(provider, 'both')
  let providerRequests = 0, detailRequests = 0, maxDatabaseMs = 0, largestWriteBytes = 0
  let injected = false, rateLimited = false, leaseChecked = false
  globalThis.fetch = async (input, init) => {
    const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (address.hostname === `${PROJECT}.supabase.co`) {
      if (init?.body && typeof init.body === 'string') largestWriteBytes = Math.max(largestWriteBytes, Buffer.byteLength(init.body))
      const start = performance.now()
      const response = await originalFetch(input, init)
      maxDatabaseMs = Math.max(maxDatabaseMs, performance.now() - start)
      if (address.pathname.endsWith('/claim_provider_migration_job') && response.ok && !leaseChecked) {
        const claimed = await response.clone().json()
        if (claimed?.id) {
          const other = await checked(db.rpc('claim_provider_migration_job', { p_job_id: values.job, p_worker_id: randomUUID() }))
          assert.ok(!other?.id, 'Two workers claimed the same active lease')
          leaseChecked = true
        }
      }
      if (!injected && response.ok && address.pathname.endsWith('/commit_provider_migration_records')) {
        injected = true
        if (values.fault === 'crash') {
          process.stdout.write('LOAD_CRASH_AFTER_COMMIT ' + JSON.stringify({ rateLimited }) + '\n', () => process.kill(process.pid, 'SIGKILL'))
          return new Promise<Response>(() => {})
        }
        if (values.fault === 'lost-ack') return Response.json({ message: 'Synthetic lost commit acknowledgement' }, { status: 503 })
      }
      return response
    }
    const host = provider === 'visma' ? 'eaccountingapi.vismaonline.com' : 'api.bokio.se'
    assert.equal(address.hostname, host, 'Unexpected outbound request blocked')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-load-token')
    providerRequests++
    if (delay) await sleep(delay)
    if (values['rate-limit'] && !rateLimited) {
      rateLimited = true
      return Response.json({ message: 'Synthetic rate limit' }, { status: 429, headers: { 'Retry-After': '1' } })
    }
    const detail = address.pathname.match(/\/load-(\d+)$/)
    if (detail) { detailRequests++; return Response.json(invoiceFixture(provider, Number(detail[1]))) }
    assert.ok(address.pathname.endsWith(provider === 'visma' ? '/customerinvoices' : '/invoices'))
    const page = Number(address.searchParams.get(provider === 'visma' ? '$page' : 'page'))
    const size = Number(address.searchParams.get(provider === 'visma' ? '$pagesize' : 'pageSize'))
    assert.ok(page >= 1 && size > 0)
    return Response.json(providerPage(provider, page, size, count, detailEvery))
  }
  const { runProviderMigrationWorker } = await import('../../src/extensions/general/arcim-migration/lib/migration-job-worker')
  const start = performance.now()
  const result = await runProviderMigrationWorker({ jobId: values.job, budgetMs: budget })
  const elapsedMs = Math.round(performance.now() - start)
  assert.ok(elapsedMs <= budget + 1500, `Worker exceeded ${budget}ms budget: ${elapsedMs}ms`)
  assert.ok(largestWriteBytes <= 760000, `Oversized write: ${largestWriteBytes} bytes`)
  console.log('LOAD_RESULT ' + JSON.stringify({ ...result, elapsedMs, providerRequests, detailRequests,
    maxDatabaseMs: Math.round(maxDatabaseMs), largestWriteBytes, rssBytes: process.memoryUsage().rss,
    leaseChecked, injected, rateLimited }))
}

async function runChild(provider: LoadProvider, job: string, fault?: string, rateLimit = false) {
  const args = ['--import', 'tsx', '--conditions', 'react-server', resolve('scripts/provider-migration/load-staging.ts'),
    '--child', '--env', resolve(values.env!), '--provider', provider, '--count', String(count), '--budget', String(budget),
    '--detail-every', String(detailEvery), '--delay-ms', String(delay), '--job', job]
  if (fault) args.push('--fault', fault)
  if (rateLimit) args.push('--rate-limit')
  return new Promise<Record<string, number | boolean>>((done, fail) => {
    const worker = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    worker.stdout.on('data', data => { output = (output + data.toString()).slice(-100000) })
    worker.stderr.on('data', data => { errors = (errors + data.toString()).slice(-10000) })
    const watchdog = setTimeout(() => { worker.kill('SIGKILL'); fail(new Error('Worker watchdog exceeded budget')) }, budget + 15000)
    worker.on('error', error => { clearTimeout(watchdog); fail(error) })
    worker.on('exit', (code, signal) => {
      clearTimeout(watchdog)
      if (signal === 'SIGKILL' && fault === 'crash' && output.includes('LOAD_CRASH_AFTER_COMMIT')) return done({ crashed: true, rateLimited: output.includes('LOAD_CRASH_AFTER_COMMIT {"rateLimited":true}') })
      const report = output.split('\n').find(line => line.startsWith('LOAD_RESULT '))
      if (code !== 0 || !report) return fail(new Error(`Worker failed (${code}/${signal}): ${errors || output}`))
      done(JSON.parse(report.slice('LOAD_RESULT '.length)))
    })
  })
}

async function main() {
  if (values.child) return child()
  const reports: Record<string, unknown>[] = []
  const providers: LoadProvider[] = values.provider === 'both' ? ['visma', 'bokio'] : [values.provider as LoadProvider]
  try {
    for (const provider of providers) {
      const start = performance.now()
      const company = randomUUID(), consent = randomUUID()
      const auth = await db.auth.admin.createUser({ email: `provider-load-${company}@test.invalid`, email_confirm: true })
      if (auth.error) throw new Error(auth.error.message)
      const user = auth.data.user.id
      await checked(db.from('companies').insert({ id: company, name: `SYNTHETIC provider load ${provider} ${count}`, entity_type: 'aktiebolag', created_by: user }))
      await checked(db.from('company_members').insert({ company_id: company, user_id: user, role: 'owner' }))
      await checked(db.from('provider_consents').insert({ id: consent, company_id: company, name: 'Synthetic load test', provider, org_number: '556000-0000' }))
      await checked(db.from('provider_consent_tokens').insert({ consent_id: consent, provider, access_token: 'synthetic-load-token', provider_company_id: 'synthetic-company' }))
      // Admission fixture only. This benchmark imports invoice registers, not a ledger.
      await checked(db.from('sie_imports').insert({ company_id: company, user_id: user, filename: 'synthetic-load-precondition.se', file_hash: company, sie_type: 4, status: 'completed' }))
      const job = await checked(db.rpc('create_provider_migration_job', { p_company_id: company, p_user_id: user,
        p_consent_id: consent, p_resources: ['salesInvoices'], p_scope: null }))
      const report = { provider, company, job: job.id, user, count, detailEvery, delay, budget, invocations: [] as Record<string, number | boolean>[], state: 'running', elapsedMs: 0 }
      reports.push(report)
      console.log(`${provider}: ${count} invoices; synthetic company ${company}; job ${job.id}`)
      let crashDone = false, lostAckDone = false, rateLimitDone = false
      for (let attempt = 0; attempt < 2000; attempt++) {
        const row = await checked(db.from('migration_jobs').select('*').eq('id', job.id).eq('company_id', company).single())
        if (row.state === 'completed') { report.state = row.state; break }
        assert.notEqual(row.state, 'needs_attention', `Unexpected review state: ${row.error_code}`)
        // Accelerate only this synthetic job's lease/backoff after the forced crash.
        if (row.state === 'running' || row.state === 'retry_wait') await checked(db.from('migration_jobs')
          .update({ lease_until: new Date(0).toISOString(), next_attempt_at: new Date(0).toISOString() })
          .eq('id', job.id).eq('company_id', company))
        const fault: string | undefined = !crashDone ? 'crash' : !lostAckDone ? 'lost-ack' : undefined
        const result = await runChild(provider, job.id, fault, !rateLimitDone)
        rateLimitDone ||= result.rateLimited === true
        crashDone ||= result.crashed === true
        lostAckDone ||= fault === 'lost-ack' && result.injected === true
        report.invocations.push(result)
        const counts = await checked(db.rpc('provider_migration_counts', { p_job_id: job.id }))
        console.log(`${provider} run ${attempt + 1}: ${JSON.stringify({ ...result, counts })}`)
        writeFileSync(values.report!, JSON.stringify({ project: PROJECT, syntheticProviderResponses: true, reports }, null, 2))
      }
      assert.equal(report.state, 'completed')
      assert.ok(crashDone && lostAckDone && rateLimitDone, 'All recovery faults must be exercised; use more invoices or a shorter budget')
      for (const [table, expected] of [['invoices', count], ['customers', Math.min(count, 250)]] as const) {
        const result = await db.from(table).select('id', { head: true, count: 'exact' }).eq('company_id', company)
        assert.equal(result.error, null); assert.equal(result.count, expected, `${table} count`)
      }
      const lineCount = await db.from('invoice_items').select('id,invoices!inner(company_id)', { head: true, count: 'exact' }).eq('invoices.company_id', company)
      assert.equal(lineCount.error, null); assert.equal(lineCount.count, count * 3)
      const completions = await db.from('processing_history').select('event_id', { head: true, count: 'exact' })
        .eq('company_id', company).eq('event_type', 'InvoiceRowsCompleted')
      assert.equal(completions.error, null); assert.equal(completions.count, count, 'Duplicate row-completion events')
      const receipts = (await checked(db.rpc('provider_migration_counts', { p_job_id: job.id })))[0]
      assert.equal(Number(receipts.total), count)
      assert.equal(Number(receipts.completed), count)
      assert.equal(Number(receipts.needs_attention), 0)
      let totalOre = 0, seen = 0
      for (let offset = 0; offset < count; offset += 1000) {
        const rows = await checked(db.from('invoices').select('total,subtotal,vat_amount').eq('company_id', company).order('id').range(offset, offset + 999))
        for (const row of rows ?? []) { assert.equal(Number(row.subtotal), 300); assert.equal(Number(row.vat_amount), 75); totalOre += Math.round(Number(row.total) * 100); seen++ }
      }
      assert.equal(seen, count); assert.equal(totalOre, count * 37500)
      report.elapsedMs = Math.round(performance.now() - start)
      console.log(`${provider}: PASS, ${count} invoices, ${count * 3} lines, no duplicates, exact totals, ${report.elapsedMs}ms overall`)
    }
  } finally {
    writeFileSync(values.report!, JSON.stringify({ project: PROJECT, syntheticProviderResponses: true, reports }, null, 2))
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1 })
