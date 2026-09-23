import { readFileSync, writeFileSync, existsSync, copyFileSync, createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

// Measure the ordinary authenticated report endpoint while the fault-injection
// runner imports two 6,000-voucher files into different synthetic companies.
// Requires run-next-staging.mjs start and browser-fixture.mjs first.
const env = dotenv.parse(readFileSync('.env.sie-runtime.local'))
if (env.NEXT_PUBLIC_SUPABASE_URL !== 'https://metjnjrhvujscngnpzdv.supabase.co') throw new Error('Staging only')
const fixture = JSON.parse(readFileSync('.env.sie-ui.json', 'utf8'))
const state = JSON.parse(readFileSync('.env.sie-browser-state.json', 'utf8'))
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const company = await supabase.from('companies').select('name').eq('id', fixture.company).single()
assert.ok(company.data?.name.startsWith('SIE acceptance'), 'Synthetic report company required')
const periods = await supabase.from('fiscal_periods').select('id').eq('company_id', fixture.company).eq('name', '2026').single()
if (periods.error) throw periods.error
const cookie = state.cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
const samples = { baseline: [], concurrent: [] }
async function sample(group) {
  const started = performance.now()
  const response = await fetch(`http://localhost:3228/api/reports/balance-sheet?period_id=${periods.data.id}`, {
    headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(10000),
  })
  const body = await response.json()
  assert.equal(response.status, 200, `Report failed: ${response.status}`)
  assert.ok(body.data, 'Authenticated report data required')
  samples[group].push(performance.now() - started)
}
// Warm routing and connection caches before the baseline.
await sample('baseline')
samples.baseline = []
for (let i = 0; i < 12; i++) { await sample('baseline'); await delay(300) }
if (existsSync('.env.sie-acceptance.json')) copyFileSync('.env.sie-acceptance.json', '.env.sie-acceptance.previous.json')
const output = createWriteStream('.env.sie-acceptance-repeat.log')
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/sie-import/acceptance-staging.ts'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
let finished = false
const completed = new Promise((resolve, reject) => {
  child.on('error', reject)
  child.on('exit', code => { finished = true; resolve(code) })
})
let failure
try {
  while (!finished) { await sample('concurrent'); await delay(1000) }
} catch (error) { failure = error }
// Let any in-flight accounting transaction finish even if the report fails.
const code = await completed
output.end()
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return { requests: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) }
}
const result = { measuredAt: new Date().toISOString(), project: 'metjnjrhvujscngnpzdv', compute: 'Micro',
  baseline: summary(samples.baseline), concurrent: summary(samples.concurrent), acceptanceExitCode: code,
  failure: failure?.message, samples }
writeFileSync('.env.sie-report-latency.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify({ ...result, samples: undefined }))
if (failure) throw failure
assert.equal(code, 0, 'Concurrent import acceptance failed; inspect its private log')
