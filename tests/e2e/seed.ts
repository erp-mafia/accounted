import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { appEnv, readRuntime, runtimeDir } from '../../scripts/e2e/runtime.mjs'
import { assertOwnedDatabase } from '../../scripts/e2e/stack.mjs'
import { buildDataset, FIXTURE_NAME, FIXTURE_VERSION, DOCUMENT_COUNT } from './dataset'
import { roundOre } from '../../src/lib/money'

interface Fixture {
  company: string
  user: string
  email: string
  password: string
  year: number
  jobs: Record<string, string>
  complete: boolean
  initialized: boolean
  version: number
}

/** Derive stable registry identifiers so interrupted fixture setup can resume safely. */
function fixtureId(company: string, key: string): string {
  const bytes = createHash('sha256').update(`${company}:${key}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Provision and validate the isolated synthetic company, then refresh its browser session. */
async function main() {
  const state = readRuntime()
  assertOwnedDatabase()
  if (!state.schemaReady) throw new Error('Prepare the isolated schema first')
  Object.assign(process.env, appEnv(state), { NODE_ENV: 'test' })
  const db = createClient(state.supabaseUrl, state.serviceKey, { auth: { persistSession: false } })
  const { submitSIEJob, getSIEJob } = await import('../../src/lib/import/sie-jobs')
  const { runSIEWorker } = await import('../../src/lib/import/sie-job-worker')
  const { BAS_REFERENCE } = await import('../../src/lib/bookkeeping/bas-reference')
  const { uploadDocument } = await import('../../src/lib/core/documents/document-service')
  const { fetchAllRows } = await import('../../src/lib/supabase/fetch-all')
  /** Return query data or fail fixture setup immediately on a database error. */
  async function checked<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
    const result = await query
    if (result.error) throw new Error(result.error.message)
    return result.data
  }
  const fixturePath = path.join(runtimeDir, 'fixture.json')
  const save = () => writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 })
  let fixture: Fixture
  if (existsSync(fixturePath)) {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
    if (fixture.version !== FIXTURE_VERSION) throw new Error('Synthetic fixture version changed. Run npm run test:e2e:reset.')
  } else {
    const email = 'browser@example.invalid'
    const password = `${randomBytes(24).toString('hex')}Aa1!`
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) {
      let reason = created.error?.message ?? 'Auth response omitted the user'
      for (const secret of [state.anonKey, state.serviceKey, state.encryptionKey, state.cronSecret, password]) {
        reason = reason.replaceAll(secret, '[redacted]')
      }
      throw new Error(`Synthetic user creation failed (${created.error?.code ?? 'unknown'}): ${reason}`)
    }
    fixture = {
      company: randomUUID(), user: created.data.user.id, email, password,
      year: new Date().getFullYear(), jobs: {}, complete: false, initialized: false, version: FIXTURE_VERSION,
    }
    save()
  }
  if (!fixture.initialized) {
    await checked(db.from('companies').upsert({
      id: fixture.company, name: FIXTURE_NAME, entity_type: 'aktiebolag', created_by: fixture.user,
    }, { onConflict: 'id', ignoreDuplicates: true }))
    await checked(db.from('company_members').upsert({ company_id: fixture.company, user_id: fixture.user, role: 'owner' }, {
      onConflict: 'company_id,user_id', ignoreDuplicates: true,
    }))
    await checked(db.from('user_preferences').upsert({ user_id: fixture.user, active_company_id: fixture.company, locale: 'sv' }))
    await checked(db.from('company_settings').upsert({
      company_id: fixture.company, user_id: fixture.user, company_name: FIXTURE_NAME,
      entity_type: 'aktiebolag', onboarding_complete: true, initial_setup_path: 'migration',
      initial_setup_completed_at: new Date().toISOString(), pays_salaries: true,
    }))
    const chart = BAS_REFERENCE.map(account => ({
      user_id: fixture.user, company_id: fixture.company,
      account_number: account.account_number, account_name: account.account_name,
      account_class: account.account_class, account_group: account.account_group,
      account_type: account.account_type, normal_balance: account.normal_balance,
      sru_code: account.sru_code, k2_excluded: account.k2_excluded,
      plan_type: 'full_bas', is_active: true, is_system_account: false,
    }))
    for (let offset = 0; offset < chart.length; offset += 500) {
      await checked(db.from('chart_of_accounts').upsert(chart.slice(offset, offset + 500), { onConflict: 'company_id,account_number' }))
    }
    await checked(db.from('customers').upsert(Array.from({ length: 6 }, (_, index) => ({
      id: fixtureId(fixture.company, `customer:${index}`),
      user_id: fixture.user, company_id: fixture.company, name: `Testkund ${String(index + 1).padStart(3, '0')} AB`,
      email: `customer-${index}@example.invalid`, country: 'SE',
    })), { onConflict: 'id', ignoreDuplicates: true }))
    await checked(db.from('suppliers').upsert(Array.from({ length: 50 }, (_, index) => ({
      id: fixtureId(fixture.company, `supplier:${index}`),
      user_id: fixture.user, company_id: fixture.company, name: `Testleverantor ${String(index + 1).padStart(3, '0')} AB`,
      email: `supplier-${index}@example.invalid`, country: 'SE',
    })), { onConflict: 'id', ignoreDuplicates: true }))
    await checked(db.from('articles').upsert(Array.from({ length: 100 }, (_, index) => ({
      id: fixtureId(fixture.company, `article:${index}`),
      user_id: fixture.user, company_id: fixture.company, article_number: `E2E-${index + 1}`,
      name: `Testtjanst ${String(index + 1).padStart(3, '0')}`, type: 'tjanst', price_excl_vat: 1000 + index * 10, vat_rate: 25,
    })), { onConflict: 'id', ignoreDuplicates: true }))
    fixture.initialized = true
    save()
  }
  const company = await checked(db.from('companies').select('name,created_by').eq('id', fixture.company).single())
  if (!company || company.name !== FIXTURE_NAME || company.created_by !== fixture.user) throw new Error('Synthetic fixture ownership mismatch')
  const dataset = buildDataset(fixture.year)
  if (!fixture.complete) {
    for (const { year, content } of dataset.years) {
      if (!fixture.jobs[year]) {
        await checked(db.from('fiscal_periods').upsert({
          user_id: fixture.user, company_id: fixture.company, name: String(year),
          period_start: `${year}-01-01`, period_end: `${year}-12-31`,
        }, { onConflict: 'company_id,period_start,period_end', ignoreDuplicates: true }))
        const job = await submitSIEJob(db, fixture.company, fixture.user, content, dataset.accounts.map(account => ({
          sourceAccount: account, targetAccount: account, sourceName: 'Synthetic', targetName: 'Synthetic',
          confidence: 1, matchType: 'exact' as const, isOverride: false,
        })), {
          filename: `synthetic-${year}.se`, createFiscalPeriod: false, importOpeningBalances: false,
          importTransactions: true, updateAccountNames: false, markImportedNoDocRequired: true,
        })
        fixture.jobs[year] = job.id
        save()
      }
      await runSIEWorker({ supabase: db, importId: fixture.jobs[year], budgetMs: 240000 })
      const job = await getSIEJob(db, fixture.company, fixture.jobs[year])
      if (job?.job_state !== 'completed') throw new Error(`Synthetic ${year} import did not complete: ${job?.error_message ?? job?.job_state}`)
      console.log(`Synthetic ledger ${year} ready`)
    }
    const entries = await fetchAllRows<{
      id: string; description: string; entry_date: string
      journal_entry_lines: { account_number: string; debit_amount: number; credit_amount: number }[]
    }>(({ from, to }) => db.from('journal_entries')
      .select('id,description,entry_date,journal_entry_lines(account_number,debit_amount,credit_amount)')
      .eq('company_id', fixture.company).order('id').range(from, to))
    const byDescription = new Map(entries.map(entry => [entry.description, entry.id]))
    const suppliers = await checked(db.from('suppliers').select('id').eq('company_id', fixture.company).order('name'))
    const customers = await checked(db.from('customers').select('id').eq('company_id', fixture.company).order('name'))
    if (!suppliers?.length || !customers?.length) throw new Error('Synthetic party registers are missing')
    const registryInvoices = dataset.years.flatMap(year => year.invoices)
    // Register historical invoice records against the vouchers already posted by
    // the engine. Seeding the register must not post those same events again.
    for (const kind of ['supplier', 'customer'] as const) {
      const invoices = registryInvoices.filter(invoice => invoice.kind === kind)
      const rows = invoices.map(invoice => ({
        id: fixtureId(fixture.company, `${kind}-invoice:${invoice.index}`), user_id: fixture.user, company_id: fixture.company,
        invoice_date: invoice.date, due_date: invoice.due, currency: 'SEK',
        subtotal: roundOre(invoice.amount / 1.25), subtotal_sek: roundOre(invoice.amount / 1.25),
        vat_amount: roundOre(invoice.amount - invoice.amount / 1.25), vat_amount_sek: roundOre(invoice.amount - invoice.amount / 1.25),
        total: invoice.amount, total_sek: invoice.amount, status: invoice.unpaid ? (kind === 'supplier' ? 'registered' : 'sent') : 'paid',
        paid_amount: invoice.unpaid ? 0 : invoice.amount,
        paid_at: invoice.unpaid ? null : `${invoice.date.slice(0, 8)}20T12:00:00Z`,
        ...(kind === 'supplier' ? {
          supplier_id: suppliers[invoice.index % suppliers.length].id, arrival_number: invoice.index + 1,
          supplier_invoice_number: `E2E-S-${invoice.index + 1}`, remaining_amount: invoice.unpaid ? invoice.amount : 0,
          registration_journal_entry_id: byDescription.get(invoice.registration),
          payment_journal_entry_id: invoice.payment ? byDescription.get(invoice.payment) : null,
        } : {
          customer_id: customers[invoice.index % customers.length].id, invoice_number: `E2E-C-${invoice.index + 1}`,
          journal_entry_id: byDescription.get(invoice.registration),
        }),
      }))
      await checked(db.from(kind === 'supplier' ? 'supplier_invoices' : 'invoices').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }))
      await checked(db.from(kind === 'supplier' ? 'supplier_invoice_items' : 'invoice_items').upsert(rows.map(row => ({
        id: fixtureId(fixture.company, `${kind}-invoice-item:${row.id}`),
        [kind === 'supplier' ? 'supplier_invoice_id' : 'invoice_id']: row.id,
        description: 'Synthetic consulting service', quantity: 1, unit: 'st', unit_price: row.subtotal,
        line_total: row.subtotal, vat_rate: kind === 'supplier' ? 0.25 : 25, vat_amount: row.vat_amount, sort_order: 0,
        ...(kind === 'supplier' ? { account_number: '5420' } : {}),
      })), { onConflict: 'id', ignoreDuplicates: true }))
    }
    const bankEntries = entries.filter(entry => entry.journal_entry_lines.some(line => line.account_number === '1930'))
      .sort((left, right) => left.entry_date.localeCompare(right.entry_date) || left.id.localeCompare(right.id)).slice(-500)
    await checked(db.from('transactions').upsert(bankEntries.map((entry, index) => {
      const bankLine = entry.journal_entry_lines.find(line => line.account_number === '1930')!
      return {
        id: fixtureId(fixture.company, `transaction:${entry.id}`),
        company_id: fixture.company, user_id: fixture.user, date: entry.entry_date,
        description: `Synthetic bank transaction ${index + 1}`, amount: bankLine.debit_amount - bankLine.credit_amount,
        currency: 'SEK', is_business: true, journal_entry_id: entry.id,
      }
    }), { onConflict: 'id', ignoreDuplicates: true }))
    const pdf = await PDFDocument.create()
    pdf.setCreationDate(new Date('2020-01-01T00:00:00Z'))
    pdf.setModificationDate(new Date('2020-01-01T00:00:00Z'))
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 200]).drawText('Synthetic E2E attachment. No real financial information.', { x: 20, y: 100, size: 10, font })
    const bytes = await pdf.save()
    // Keep concurrency bounded, while exercising the real document archive and
    // Storage service rather than inserting metadata with nonexistent files.
    for (let offset = 0; offset < DOCUMENT_COUNT; offset += 8) {
      await Promise.all(entries.slice(offset, Math.min(offset + 8, DOCUMENT_COUNT)).map((entry, index) => uploadDocument(
        db, fixture.user, fixture.company,
        { name: `synthetic-${offset + index + 1}.pdf`, buffer: Uint8Array.from(bytes).buffer, type: 'application/pdf' },
        { upload_source: 'api', journal_entry_id: entry.id, idempotency_key: entry.id, extractionOwner: 'none' },
      )))
    }
  }
  for (const [table, expected] of [
    ['fiscal_periods', 10], ['journal_entries', dataset.total],
    ['chart_of_accounts', new Set([...BAS_REFERENCE.map(account => account.account_number), ...dataset.accounts]).size],
    ['customers', 6], ['suppliers', 50], ['invoices', 50], ['supplier_invoices', 450],
    ['articles', 100], ['transactions', 500], ['document_attachments', DOCUMENT_COUNT],
  ] as const) {
    const result = await db.from(table).select('id', { count: 'exact', head: true }).eq('company_id', fixture.company)
    if (result.error || result.count !== expected) throw new Error(`Synthetic ${table} count mismatch. Expected ${expected}, received ${result.count}`)
  }
  fixture.complete = true
  save()
  const cookies: { name: string; value: string }[] = []
  const browserClient = createServerClient(state.supabaseUrl, state.anonKey, {
    cookies: { getAll: () => [], setAll: values => { cookies.push(...values) } },
  })
  const login = await browserClient.auth.signInWithPassword({ email: fixture.email, password: fixture.password })
  if (login.error) throw new Error('Synthetic browser login failed')
  writeFileSync(path.join(runtimeDir, 'auth.json'), JSON.stringify({ cookies: cookies.map(cookie => ({
    name: cookie.name, value: cookie.value, domain: '127.0.0.1', path: '/', expires: -1,
    httpOnly: false, secure: false, sameSite: 'Lax',
  })), origins: [] }), { mode: 0o600 })
  console.log(`Synthetic fixture ready: 10 years, ${dataset.total} vouchers, 500 invoices, ${DOCUMENT_COUNT} PDF attachments`)
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
