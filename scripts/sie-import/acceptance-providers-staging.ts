import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import dotenv from 'dotenv'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

// Provider responses are synthetic fixtures. Storage, admission, preparation,
// chunk commits, finalization and replay use the actual staging services.
async function main() {
  Object.assign(process.env, dotenv.parse(readFileSync('.env.sie-runtime.local')), { SIE_IMPORT_JOBS: 'true' })
  const branch = dotenv.parse(readFileSync('.env.sie.branch.local'))
  const url = new URL(branch.POSTGRES_URL)
  const project = 'metjnjrhvujscngnpzdv'
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, `https://${project}.supabase.co`)
  assert.ok(url.username.endsWith(`.${project}`) && url.hostname.endsWith('.pooler.supabase.com'), 'Staging only')
  url.searchParams.delete('sslmode')
  const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000,
    query_timeout: 30000, ssl: { rejectUnauthorized: true, ca: readFileSync('.env.sie-ca.crt', 'utf8') } })
  await db.connect()
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { fetchProviderSieFiles } = await import('../../extensions/general/arcim-migration/lib/sie-fetcher')
  const { detectEncoding, decodeBuffer } = await import('../../src/lib/import/sie-parser')
  const { readSIEIntakeFile } = await import('../../src/lib/import/sie-intake')
  const { submitSIEJob } = await import('../../src/lib/import/sie-jobs')
  const { runSIEWorker } = await import('../../src/lib/import/sie-job-worker')
  const { getOpeningBalances } = await import('../../src/lib/reports/opening-balances')
  const results: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  function source(program: string, year: number) {
    const opening = program === 'Fortnox' && year === 2026 ? 21400 : 1000
    const sales = year === 2025 ? 204 : 205
    return `#FLAGGA 0\n#PROGRAM "${program}" 1\n#FORMAT PC8\n#SIETYP 4\n#FNAMN "Åäö AB"\n` +
      `#RAR 0 ${year}0101 ${year}1231\n#KONTO 1930 "Företagskonto"\n#KONTO 3001 "Försäljning"\n#KONTO 2091 "Balanserat resultat"\n` +
      `#DIM 1 "Kostnadsställe"\n#OBJEKT 1 "K01" "Göteborg"\n#IB 0 1930 ${opening}\n#IB 0 2091 -${opening}\n` +
      Array.from({ length: sales }, (_, i) => `#VER A ${i + 1} ${year}0201 "Försäljning ${i + 1}"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {1 "K01"} -100\n}`).join('\n') +
      (year === 2025 ? '\n#VER A 205 20251231 "Resultatöverföring"\n{\n#TRANS 3001 {} 20400\n#TRANS 2091 {} -20400\n}' : '')
  }
  function encode(content: string, encoding: string): Uint8Array<ArrayBuffer> {
    if (encoding === 'utf8') return new TextEncoder().encode(content)
    const cp437: Record<string, number> = { å: 0x86, ä: 0x84, ö: 0x94, Å: 0x8f, Ä: 0x8e, Ö: 0x99 }
    return Uint8Array.from([...content].map(char => encoding === 'cp437' ? cp437[char] ?? char.charCodeAt(0) : char.charCodeAt(0)))
  }
  try {
    for (const [provider, encoding] of [['Fortnox', 'utf8'], ['Fortnox', 'cp437'], ['Visma Administration', 'cp437'], ['Visma eEkonomi', 'latin1'], ['Bokio', 'utf8']]) {
      const company = randomUUID(), actor = randomUUID()
      await db.query("INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')", [actor, `sie-provider-${actor}@test.invalid`])
      await db.query("INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,$2,'aktiebolag',$3)", [company, `SIE provider acceptance ${provider} ${encoding}`, actor])
      await db.query("INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')", [company, actor])
      let files: Array<{ fiscalYear: number; bytes: Uint8Array<ArrayBuffer> }>
      if (provider === 'Fortnox') {
        const calls: string[] = []
        globalThis.fetch = async (input, init) => {
          const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          if (address.hostname !== 'api.fortnox.se') return originalFetch(input, init)
          assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-provider-token')
          calls.push(address.pathname + address.search)
          if (address.pathname.endsWith('/financialyears')) return Response.json({ FinancialYears: [
            { Id: 2, FromDate: '2026-01-01', ToDate: '2026-12-31' }, { Id: 1, FromDate: '2025-01-01', ToDate: '2025-12-31' },
          ] })
          assert.ok(address.pathname.endsWith('/sie/4'))
          const year = address.searchParams.get('financialyear') === '1' ? 2025 : 2026
          return new Response(encode(source(provider, year), encoding))
        }
        const fetched = await fetchProviderSieFiles('fortnox', 'synthetic-provider-token', undefined, { years: [2025, 2026] })
        globalThis.fetch = originalFetch
        assert.deepEqual(fetched.failedYears, [])
        assert.deepEqual(fetched.files.map(file => file.fiscalYear), [2025, 2026])
        assert.equal(calls.length, 3)
        files = fetched.files.map(file => ({ fiscalYear: file.fiscalYear, bytes: encode(file.rawContent, 'utf8') }))
      } else {
        files = [{ fiscalYear: 2026, bytes: encode(source(provider, 2026), encoding) }]
      }
      for (const [fileIndex, { fiscalYear, bytes }] of files.entries()) {
        const filename = `acceptance-${fiscalYear}.se`, path = `${company}/sie-intake/${randomUUID()}.se`
        const signed = await supabase.storage.from('sie-files').createSignedUploadUrl(path)
        assert.equal(signed.error, null)
        const uploaded = await supabase.storage.from('sie-files').uploadToSignedUrl(path, signed.data!.token, bytes,
          { contentType: 'application/octet-stream', upsert: false })
        assert.equal(uploaded.error, null)
        const file = await readSIEIntakeFile(supabase, company, path, filename)
        const buffer = await file.arrayBuffer(), content = decodeBuffer(buffer, detectEncoding(buffer))
        assert.ok(content.includes('Företagskonto') && content.includes('Göteborg'))
        const mappings = ['1930', '3001', '2091'].map((number, i) => ({ sourceAccount: number, targetAccount: number,
          sourceName: ['Företagskonto', 'Försäljning', 'Balanserat resultat'][i], targetName: number,
          confidence: 1, matchType: 'exact' as const, isOverride: false }))
        const options = { filename, createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true, updateAccountNames: true }
        const job = await submitSIEJob(supabase, company, actor, content, mappings, options, file)
        let state = job.job_state
        for (let attempt = 0; attempt < 5 && state !== 'completed'; attempt++) {
          await runSIEWorker({ supabase, importId: job.id })
          const row = (await db.query('SELECT job_state,error_message FROM sie_imports WHERE id=$1', [job.id])).rows[0]
          assert.equal(row.error_message, null)
          state = row.job_state
        }
        assert.equal(state, 'completed')
        assert.equal((await submitSIEJob(supabase, company, actor, content, mappings, options, file)).id, job.id)
        const counts = (await db.query(`SELECT count(*) FILTER(WHERE source_type='import')::int vouchers,
          count(*) FILTER(WHERE source_type='opening_balance')::int openings,
          min(voucher_number) FILTER(WHERE source_type='import') lo,max(voucher_number) FILTER(WHERE source_type='import') hi
          FROM journal_entries WHERE import_batch_id=$1`, [job.id])).rows[0]
        // Later years use the existing ledger's opening-balance fallback.
        // Reposting each source year's IB would double-count prior activity.
        assert.deepEqual(counts, { vouchers: 205, openings: fileIndex === 0 ? 1 : 0, lo: 1, hi: 205 })
        const balances = (await db.query(`SELECT l.account_number,sum(l.debit_amount-l.credit_amount)::text amount
          FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.import_batch_id=$1 GROUP BY l.account_number ORDER BY l.account_number`, [job.id])).rows
        assert.deepEqual(balances.map(row => [row.account_number, Number(row.amount)]), fileIndex === 0
          ? fiscalYear === 2025 ? [['1930', 21400], ['2091', -21400], ['3001', 0]]
            : [['1930', 21500], ['2091', -1000], ['3001', -20500]]
          : [['1930', 20500], ['3001', -20500]])
        const bank = (await db.query(`SELECT sum(l.debit_amount-l.credit_amount)::text amount
          FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id
          WHERE j.company_id=$1 AND l.account_number='1930' AND j.status='posted'`, [company])).rows[0]
        assert.equal(Number(bank.amount), provider === 'Fortnox' ? 21400 + fileIndex * 20500 : 21500)
        assert.equal((await db.query(`SELECT count(*)::int n FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id
          WHERE j.import_batch_id=$1 AND l.dimensions->>'1'='K01'`, [job.id])).rows[0].n, fiscalYear === 2025 ? 204 : 205)
        if (fileIndex > 0) {
          const opening = await getOpeningBalances(supabase, company, { period_start: `${fiscalYear}-01-01`, opening_balance_entry_id: null })
          const net = [...opening.balances].map(([number, amount]) => [number, amount.debit - amount.credit])
            .sort(([first], [second]) => String(first).localeCompare(String(second)))
          assert.deepEqual(net, [['1930', 21400], ['2091', -21400]])
        }
        assert.equal((await db.query('SELECT import_hold FROM fiscal_periods WHERE id=$1', [job.fiscal_period_id])).rows[0].import_hold, null)
        const original = await supabase.storage.from('sie-files').download((job.manifest.originalSource as { path: string }).path)
        assert.equal(original.error, null)
        assert.deepEqual(new Uint8Array(await original.data!.arrayBuffer()), bytes)
        results.push({ provider, encoding, fiscalYear, company, importId: job.id, counts, replay: 'same job',
          uploadedBytesRetained: true, providerTransport: provider === 'Fortnox' ? 'decoded to UTF-8 before upload' : 'uploaded file bytes' })
        console.log(`${provider} ${encoding} ${fiscalYear}: 205 vouchers, IB, dimensions, balances, archive and replay passed`)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    writeFileSync('.env.sie-provider-acceptance.json', JSON.stringify({ project, syntheticProviderResponses: true, results }, null, 2))
    await db.end()
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1 })
