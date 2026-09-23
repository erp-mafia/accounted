/** Synthetic staging fixture. Journal writes use the existing SIE worker and engine.
 * Retains its accounting history; see observed-benchmark.md before running.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID, randomBytes } from 'node:crypto'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

interface Fixture {
  company: string
  user: string
  email: string
  password: string
  jobs: string[]
}

async function main() {
  const env = dotenv.parse(readFileSync(process.argv[2] ?? '.env.observed-staging.local'))
  if (env.SUPABASE_URL !== 'https://metjnjrhvujscngnpzdv.supabase.co') throw new Error('Staging only')
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    SIE_IMPORT_JOBS: 'true', SIE_IMPORT_CHUNK_AUDIT: 'true', NODE_ENV: 'test',
  })
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { submitSIEJob, getSIEJob } = await import('../../src/lib/import/sie-jobs')
  const { runSIEWorker } = await import('../../src/lib/import/sie-job-worker')
  async function checked<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
    const result = await query
    if (result.error) throw new Error(result.error.message)
    return result.data
  }
  const save = (fixture: Fixture) => writeFileSync('.env.observed-fixture.json', JSON.stringify(fixture), { mode: 0o600 })
  let fixture: Fixture
  if (existsSync('.env.observed-fixture.json')) {
    fixture = JSON.parse(readFileSync('.env.observed-fixture.json', 'utf8'))
  } else {
    const company = randomUUID()
    const email = `observed-load-${company}@test.invalid`
    const password = randomBytes(32).toString('hex') + 'Aa1!'
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error) throw new Error(created.error.message)
    const { user } = created.data
    if (!user) throw new Error('Synthetic user was not created')
    fixture = { company, user: user.id, email, password, jobs: [] }
    await checked(db.from('companies').insert({
      id: company, name: 'SYNTHETIC observed party load', entity_type: 'aktiebolag', created_by: user.id,
    }))
    await checked(db.from('company_members').insert({ company_id: company, user_id: user.id, role: 'owner' }))
    await checked(db.from('user_preferences').upsert({ user_id: user.id, active_company_id: company, locale: 'en' }))
    await checked(db.from('company_settings').upsert({
      company_id: company, user_id: user.id, onboarding_complete: true, company_name: 'Synthetic observed benchmark',
    }))
    for (const year of [2025, 2026]) {
      await checked(db.from('fiscal_periods').insert({
        company_id: company, user_id: user.id, name: String(year),
        period_start: `${year}-01-01`, period_end: `${year}-12-31`,
      }))
    }
    save(fixture)
  }
  const company = await checked(db.from('companies').select('name,created_by').eq('id', fixture.company).single())
  if (company?.name !== 'SYNTHETIC observed party load' || company.created_by !== fixture.user) {
    throw new Error('The saved fixture must belong to this synthetic staging company')
  }
  const names = Array.from({ length: 1500 }, (_, i) => {
    let n = i, suffix = ''
    do {
      suffix = String.fromCharCode(97 + n % 26) + suffix
      n = Math.floor(n / 26) - 1
    } while (n >= 0)
    return `Supplier ${suffix} Services AB`
  })
  const accounts = ['1930', '2440', '2641', '3011', '4000', '4010', '6542', '8310']
  for (const [index, year] of [2025, 2026].entries()) {
    if (!fixture.jobs[index]) {
      const vouchers = Array.from({ length: 50000 }, (_, i) => {
        const date = new Date(Date.UTC(year, 0, 1 + i % 350)).toISOString().slice(0, 10).replaceAll('-', '')
        const description = `Levfakt ${names[i % names.length]}${i % 2 ? ` (${100000 + i})` : ''}`
        const lines = i % 10 === 0
          ? '#TRANS 1930 {} 100\n#TRANS 2440 {} -100'
          : i % 10 === 1
            ? '#TRANS 1930 {} 150\n#TRANS 3011 {} -150'
            : `#TRANS ${i % 3 ? '4000' : '4010'} {} 100.25\n#TRANS 6542 {} 19.75\n#TRANS 2641 {} 30\n#TRANS 2440 {} -150`
        return `#VER A ${i + 1} ${date} "${description}"\n{\n${lines}\n}`
      }).join('\n')
      const content = `#FLAGGA 0\n#PROGRAM "Observed benchmark" 1\n#SIETYP 4\n#FNAMN "Synthetic benchmark"\n#RAR 0 ${year}0101 ${year}1231\n`
        + accounts.map(a => `#KONTO ${a} "Synthetic ${a}"`).join('\n') + '\n' + vouchers
      const job = await submitSIEJob(db, fixture.company, fixture.user, content, accounts.map(a => ({
        sourceAccount: a, targetAccount: a, sourceName: 'Synthetic', targetName: 'Synthetic',
        confidence: 1, matchType: 'exact' as const, isOverride: false,
      })), {
        filename: `observed-${year}.se`, createFiscalPeriod: false,
        importOpeningBalances: false, importTransactions: true, updateAccountNames: false,
      })
      fixture.jobs[index] = job.id
      save(fixture)
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const job = await getSIEJob(db, fixture.company, fixture.jobs[index])
      console.log(JSON.stringify({ year, state: job?.job_state, chunks: job?.chunks_done, total: job?.chunks_total, error: job?.error_message }))
      if (job?.job_state === 'completed') break
      if (!job) throw new Error('Synthetic import disappeared')
      if (job.error_message) throw new Error(job.error_message)
      await runSIEWorker({ supabase: db, importId: fixture.jobs[index], budgetMs: 240000 })
    }
    const finished = await getSIEJob(db, fixture.company, fixture.jobs[index])
    if (finished?.job_state !== 'completed') throw new Error('Synthetic import has not completed; rerun to resume')
  }
  console.log('Synthetic 100000-entry fixture ready')
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
