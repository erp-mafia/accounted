/** Read-only SQL/HTTP benchmark on the synthetic staging fixture; --flows also refreshes its suggestions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import dotenv from 'dotenv'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

async function main() {
  const env = dotenv.parse(readFileSync(process.argv[2] ?? '.env.observed-staging.local'))
  const url = new URL(env.POSTGRES_URL)
  assert.equal(env.SUPABASE_URL, 'https://metjnjrhvujscngnpzdv.supabase.co')
  assert.ok(url.username.endsWith('.metjnjrhvujscngnpzdv') && url.hostname.endsWith('.pooler.supabase.com'))
  const fixture = JSON.parse(readFileSync('.env.observed-fixture.json', 'utf8')) as {
    company: string; user: string; email: string; password: string
  }
  const db = new pg.Client({ connectionString: url.toString(), application_name: 'observed-party-benchmark' })
  const api = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const report: Record<string, unknown> = { project: 'erp-base staging', measuredAt: new Date().toISOString() }
  await db.connect()
  try {
    const company = await db.query('SELECT name, created_by FROM companies WHERE id=$1', [fixture.company])
    assert.equal(company.rows[0]?.name, 'SYNTHETIC observed party load')
    assert.equal(company.rows[0]?.created_by, fixture.user)
    const dataset = (await db.query(`SELECT count(*)::int AS entries, count(DISTINCT description)::int AS descriptions,
      (SELECT count(*)::int FROM journal_entry_lines l JOIN journal_entries e ON e.id=l.journal_entry_id
       WHERE e.company_id=$1) AS lines FROM journal_entries WHERE company_id=$1`, [fixture.company])).rows[0]
    assert.equal(dataset.entries, 100000, 'Wait for both synthetic imports to complete before benchmarking')
    const jobs = await db.query('SELECT job_state FROM sie_imports WHERE company_id=$1', [fixture.company])
    assert.equal(jobs.rows.length, 2)
    assert.ok(jobs.rows.every(job => job.job_state === 'completed'), 'Wait for import finalization')
    report.dataset = dataset
    const auth = await api.auth.signInWithPassword({ email: fixture.email, password: fixture.password })
    assert.equal(auth.error, null)
    const from = new Date()
    from.setUTCFullYear(from.getUTCFullYear() - 1)
    const fromDate = from.toISOString().slice(0, 10)
    const calls: Array<{ window: string; ms: number; keys?: number; code?: string }> = []
    async function measure(date: string | null) {
      const started = performance.now()
      const { data, error } = await api.rpc('get_observed_parties', { p_company_id: fixture.company, p_from_date: date, p_limit: 5000 })
      const measurement = { window: date ?? 'all', ms: Math.round(performance.now() - started),
        ...(error ? { code: error.code || 'RPC_ERROR' } : { keys: data.length }) }
      calls.push(measurement)
      console.log(JSON.stringify(measurement))
    }
    for (const date of [null, fromDate]) for (let i = 0; i < 5; i++) await measure(date)
    const serial = calls.splice(0)
    report.serial = serial
    for (let i = 0; i < 3; i++) await Promise.all([measure(null), measure(fromDate)])
    const concurrentPairs = calls.splice(0)
    report.concurrentPairs = concurrentPairs
    assert.ok([...serial, ...concurrentPairs].every(call => !call.code), 'Authenticated HTTP benchmark failed; see the report')

    // Compare the shipped query and new RPC in one snapshot under the caller's
    // RLS. The longer diagnostic timeout only lets the old oracle finish;
    // measured HTTP requests above retain the actual authenticated timeout.
    const original = readFileSync('supabase/migrations/20260902170000_ledger_key_and_observed_parties.sql', 'utf8')
      .split('AS $$')[2]!.split('$$;')[0]!
      .replaceAll('p_company_id', '$1::uuid').replaceAll('p_from_date', '$2::date').replaceAll('p_limit', '$3::integer')
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: fixture.user, role: 'authenticated' }),
    ])
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [fixture.user])
    await db.query('SET LOCAL ROLE authenticated')
    await db.query("SET LOCAL statement_timeout='120s'")
    assert.equal((await db.query('SELECT auth.uid()::text AS uid')).rows[0]?.uid, fixture.user,
      'The parity transaction must run as the synthetic fixture user')
    const parity = []
    for (const date of [null, fromDate]) {
      const args = [fixture.company, date, 5000]
      const started = performance.now()
      const before = Object.values((await db.query(original, args)).rows[0])[0]
      const originalMs = Math.round(performance.now() - started)
      const after = (await db.query('SELECT get_observed_parties($1,$2,$3) AS result', args)).rows[0].result
      assert.deepEqual(after, before)
      assert.ok(Array.isArray(after))
      assert.equal(after.length, 1000, 'The existing cap is unchanged')
      parity.push({ window: date ?? 'all', originalMs, keys: after.length,
        sha256: createHash('sha256').update(JSON.stringify(after)).digest('hex') })
    }
    report.parity = parity
    await db.query('ROLLBACK')
    if (process.argv.includes('--flows')) {
      const { getRegister } = await import('../../lib/parties/register')
      const { suggestPartiesForCompany } = await import('../../lib/parties/suggest')
      const started = performance.now()
      report.refresh = await suggestPartiesForCompany(api, fixture.company, fixture.user)
      report.refreshMs = Math.round(performance.now() - started)
      const readStarted = performance.now()
      const register = await getRegister(api, fixture.company, { period: 'all', view: 'all' })
      report.register = { ms: Math.round(performance.now() - readStarted), rows: register.rows.length }
      const evidenceStarted = performance.now()
      const evidence = await api.rpc('get_ledger_key_evidence', { p_company_id: fixture.company })
      assert.equal(evidence.error, null)
      report.evidence = { ms: Math.round(performance.now() - evidenceStarted), keys: evidence.data.length }
    }
  } finally {
    await db.query('ROLLBACK').catch(() => {})
    await db.end()
    writeFileSync('.env.observed-benchmark.json', JSON.stringify(report, null, 2))
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
