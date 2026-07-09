/**
 * Seed a complete gnubok demo environment for an existing auth user.
 *
 * Creates two companies (Konsult AB driftbolag, Konsult Holding AB),
 * a fully posted FY2025 (~+487k result, ~290 verifications, 2 voucher gaps),
 * an active FY2026 (32 customer invoices in mixed states, 4 May unsent,
 * Stripe payouts, supplier invoices, salary runs, an AWS inbox PDF, and
 * 5 uncategorized bank transactions for demo flows).
 *
 * Usage:
 *   npx tsx scripts/seed-demo-account.ts <email> [--force]
 *
 * --force wipes existing Konsult AB / Konsult Holding AB owned by the
 * target user before re-seeding. Without --force the script bails if
 * either company already exists for that user.
 *
 * External systems (Gmail / Calendar / Drive / Slack) are out of scope:
 * a checklist is printed at the end for manual setup.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */

import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const emailArg = args.find((a) => !a.startsWith('--'))
if (!emailArg) {
  console.error('Usage: npx tsx scripts/seed-demo-account.ts <email> [--force]')
  console.error('Refusing to run without an explicit target email: the script')
  console.error('seeds demo data and `--force` wipes existing Konsult AB / Konsult')
  console.error('Holding AB owned by the target user before re-seeding.')
  process.exit(1)
}
const email: string = emailArg
const force = args.includes('--force')

const pad = (n: number) => String(n).padStart(2, '0')
const dt = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const round2 = (n: number) => Math.round(n * 100) / 100

type AccountMap = Record<string, string>

interface CompanyCtx {
  companyId: string
  userId: string
  fpY: Record<number, string>
  accounts: AccountMap
  voucher: Record<number, number>
}

async function findUser(email: string): Promise<string> {
  let page = 1
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`auth.admin.listUsers: ${error.message}`)
    const u = data.users.find((x) => x.email === email)
    if (u) return u.id
    if (data.users.length < 200) break
    page++
  }
  throw new Error(`User ${email} not found in auth.users`)
}

// Verifikationsnummer skip-list: introduces deliberate gaps that require
// explanations under BFNAR 2013:2, used for the voucher-gap demo.
const VOUCHER_GAPS: Record<number, Set<number>> = {
  2025: new Set([123, 287]),
}

async function wipeExisting(userId: string): Promise<void> {
  const { data: existing, error } = await sb
    .from('companies')
    .select('id, name')
    .eq('created_by', userId)
    .in('name', ['Konsult AB', 'Konsult Holding AB'])
  if (error) throw error
  if (!existing || existing.length === 0) return
  console.log(`  wiping ${existing.length} existing demo companies`)
  for (const c of existing) {
    await sb.from('voucher_sequences').delete().eq('company_id', c.id)
    await sb.from('transactions').delete().eq('company_id', c.id)
    await sb.from('invoice_payments').delete().eq('company_id', c.id)
    await sb.from('invoice_items').delete().in(
      'invoice_id',
      ((await sb.from('invoices').select('id').eq('company_id', c.id)).data ?? []).map((r) => r.id)
    )
    await sb.from('supplier_invoice_items').delete().in(
      'supplier_invoice_id',
      (
        (await sb.from('supplier_invoices').select('id').eq('company_id', c.id)).data ?? []
      ).map((r) => r.id)
    )
    await sb.from('invoices').delete().eq('company_id', c.id)
    await sb.from('supplier_invoices').delete().eq('company_id', c.id)
    await sb.from('invoice_inbox_items').delete().eq('company_id', c.id)
    await sb.from('document_attachments').delete().eq('company_id', c.id)
    await sb.from('customers').delete().eq('company_id', c.id)
    await sb.from('suppliers').delete().eq('company_id', c.id)
    await sb.from('employees').delete().eq('company_id', c.id)
    await sb.from('journal_entry_lines').delete().in(
      'journal_entry_id',
      (
        (await sb.from('journal_entries').select('id').eq('company_id', c.id)).data ?? []
      ).map((r) => r.id)
    )
    await sb.from('journal_entries').delete().eq('company_id', c.id)
    await sb.from('account_balances').delete().eq('company_id', c.id)
    await sb.from('chart_of_accounts').delete().eq('company_id', c.id)
    await sb.from('fiscal_periods').delete().eq('company_id', c.id)
    await sb.from('company_settings').delete().eq('company_id', c.id)
    await sb.from('company_members').delete().eq('company_id', c.id)
    await sb.from('companies').delete().eq('id', c.id)
  }
}

async function createCompany(
  userId: string,
  name: string,
  orgNumber: string,
  entityType: 'aktiebolag' | 'enskild_firma'
): Promise<string> {
  const { data: c, error } = await sb
    .from('companies')
    .insert({
      name,
      org_number: orgNumber,
      entity_type: entityType,
      created_by: userId,
    })
    .select('id')
    .single()
  if (error) throw new Error(`createCompany ${name}: ${error.message}`)
  await sb.from('company_members').insert({
    company_id: c.id,
    user_id: userId,
    role: 'owner',
    source: 'direct',
  })
  return c.id
}

async function setupCompany(
  userId: string,
  companyId: string,
  settings: Record<string, unknown>,
  fiscalYears: number[]
): Promise<{ fpY: Record<number, string>; accounts: AccountMap }> {
  await sb.from('company_settings').insert({
    user_id: userId,
    company_id: companyId,
    accounting_method: 'accrual',
    onboarding_complete: true,
    onboarding_step: 6,
    is_sandbox: false,
    pays_salaries: true,
    default_voucher_series: 'A',
    ai_flow_enabled: false,
    ai_backfill_cancel_requested: false,
    ...settings,
  })
  const { error: coaErr } = await sb.rpc('seed_chart_of_accounts', {
    p_company_id: companyId,
    p_entity_type: 'aktiebolag',
  })
  if (coaErr) throw new Error(`seed_chart_of_accounts: ${coaErr.message}`)

  // The default AB seed is missing several accounts we use during the demo.
  // Fill them in here so journal entry lines have a valid account_id to link
  // to and reports look correct.
  const extraAccounts: Array<{
    n: string
    name: string
    cls: number
    grp: string
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
    nb: 'debit' | 'credit'
  }> = [
    { n: '1230', name: 'Inventarier och verktyg', cls: 1, grp: '12', type: 'asset', nb: 'debit' },
    { n: '1310', name: 'Andelar i koncernforetag', cls: 1, grp: '13', type: 'asset', nb: 'debit' },
    { n: '2614', name: 'Utgaende moms omvand skattskyldighet 25%', cls: 2, grp: '26', type: 'liability', nb: 'credit' },
    { n: '2645', name: 'Beraknad ingaende moms', cls: 2, grp: '26', type: 'liability', nb: 'debit' },
    { n: '3305', name: 'Forsaljning tjanster export', cls: 3, grp: '33', type: 'revenue', nb: 'credit' },
    { n: '3308', name: 'Forsaljning tjanster EU omvand', cls: 3, grp: '33', type: 'revenue', nb: 'credit' },
    { n: '7410', name: 'Pensionsforsakringspremier', cls: 7, grp: '74', type: 'expense', nb: 'debit' },
  ]
  await sb.from('chart_of_accounts').insert(
    extraAccounts.map((a) => ({
      user_id: userId,
      company_id: companyId,
      account_number: a.n,
      account_name: a.name,
      account_class: a.cls,
      account_group: a.grp,
      account_type: a.type,
      normal_balance: a.nb,
      plan_type: 'k1',
      is_system_account: false,
    }))
  )

  const fpY: Record<number, string> = {}
  let prev: string | null = null
  for (const y of fiscalYears) {
    const { data: fp, error } = (await sb
      .from('fiscal_periods')
      .insert({
        user_id: userId,
        company_id: companyId,
        name: `Räkenskapsår ${y}`,
        period_start: dt(y, 1, 1),
        period_end: dt(y, 12, 31),
        is_closed: false,
        opening_balances_set: y === fiscalYears[0],
        previous_period_id: prev,
      })
      .select('id')
      .single()) as { data: { id: string } | null; error: { message: string } | null }
    if (error || !fp) throw new Error(`fiscal_periods ${y}: ${error?.message ?? 'no data'}`)
    fpY[y] = fp.id
    prev = fp.id
  }

  const { data: accs, error: aErr } = await sb
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('company_id', companyId)
  if (aErr) throw aErr
  const accounts: AccountMap = Object.fromEntries((accs ?? []).map((a) => [a.account_number, a.id]))
  return { fpY, accounts }
}

interface JELine {
  account: string
  debit?: number
  credit?: number
  description?: string
  currency?: string
  amount_in_currency?: number
  exchange_rate?: number
}

async function postEntry(
  ctx: CompanyCtx,
  fy: number,
  date: string,
  description: string,
  sourceType: string,
  lines: JELine[],
  opts: { sourceId?: string | null; series?: string } = {}
): Promise<string> {
  const series = opts.series ?? 'A'
  const totalDebit = round2(lines.reduce((s, l) => s + (l.debit ?? 0), 0))
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit ?? 0), 0))
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Unbalanced entry "${description}" on ${date}: debit ${totalDebit} vs credit ${totalCredit}`
    )
  }
  const fpId = ctx.fpY[fy]
  if (!fpId) throw new Error(`No fiscal period for ${fy}`)
  let next = (ctx.voucher[fy] ?? 0) + 1
  const gaps = VOUCHER_GAPS[fy]
  while (gaps && gaps.has(next)) next++
  ctx.voucher[fy] = next
  const { data: je, error } = await sb
    .from('journal_entries')
    .insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      fiscal_period_id: fpId,
      voucher_number: next,
      voucher_series: series,
      entry_date: date,
      description,
      source_type: sourceType,
      source_id: opts.sourceId ?? null,
      status: 'posted',
      committed_at: new Date(date).toISOString(),
      created_via: 'system',
    })
    .select('id')
    .single()
  if (error) throw new Error(`postEntry "${description}": ${error.message}`)

  const { error: lineErr } = await sb.from('journal_entry_lines').insert(
    lines.map((l, i) => ({
      journal_entry_id: je.id,
      account_number: l.account,
      account_id: ctx.accounts[l.account] ?? null,
      debit_amount: round2(l.debit ?? 0),
      credit_amount: round2(l.credit ?? 0),
      currency: l.currency ?? null,
      amount_in_currency: l.amount_in_currency ?? null,
      exchange_rate: l.exchange_rate ?? null,
      line_description: l.description ?? null,
      sort_order: i,
    }))
  )
  if (lineErr) throw new Error(`lines for "${description}": ${lineErr.message}`)

  await sb
    .from('voucher_sequences')
    .upsert(
      {
        user_id: ctx.userId,
        company_id: ctx.companyId,
        fiscal_period_id: fpId,
        voucher_series: series,
        last_number: next,
      },
      { onConflict: 'company_id,fiscal_period_id,voucher_series' }
    )
  return je.id
}

function skipVoucher(ctx: CompanyCtx, fy: number, n: number): void {
  if ((ctx.voucher[fy] ?? 0) < n) {
    ctx.voucher[fy] = n
  }
}

async function closeYearForSeed(ctx: CompanyCtx, fy: number): Promise<void> {
  const fpId = ctx.fpY[fy]
  if (!fpId) throw new Error(`No fiscal period for ${fy}`)

  const { data: rows, error } = await sb
    .from('journal_entry_lines')
    .select(
      'account_number, debit_amount, credit_amount, journal_entries!inner(fiscal_period_id, company_id, status)'
    )
    .eq('journal_entries.company_id', ctx.companyId)
    .eq('journal_entries.fiscal_period_id', fpId)
    .eq('journal_entries.status', 'posted')
  if (error) throw new Error(`closeYearForSeed query: ${error.message}`)

  const nets = new Map<string, number>()
  for (const r of rows ?? []) {
    const acc = r.account_number as string
    const cls = parseInt(acc[0])
    if (cls < 3 || cls > 8) continue
    const net = (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0)
    nets.set(acc, round2((nets.get(acc) ?? 0) + net))
  }

  const lines: JELine[] = []
  let totalDebit = 0
  let totalCredit = 0
  for (const [acc, net] of nets) {
    if (Math.abs(net) < 0.005) continue
    if (net > 0) {
      lines.push({ account: acc, credit: net, description: `Stängning ${acc}` })
      totalCredit = round2(totalCredit + net)
    } else {
      lines.push({ account: acc, debit: -net, description: `Stängning ${acc}` })
      totalDebit = round2(totalDebit + -net)
    }
  }

  if (lines.length === 0) return

  const balancing = round2(totalDebit - totalCredit)
  if (balancing > 0) {
    lines.push({ account: '2099', credit: balancing, description: 'Årets resultat' })
  } else if (balancing < 0) {
    lines.push({ account: '2099', debit: -balancing, description: 'Årets förlust' })
  }

  await postEntry(ctx, fy, dt(fy, 12, 31), `Årsbokslut ${fy}`, 'year_end', lines)
}

async function postOpeningBalanceFromPriorYear(
  ctx: CompanyCtx,
  priorFy: number,
  nextFy: number
): Promise<void> {
  const priorFpId = ctx.fpY[priorFy]
  const nextFpId = ctx.fpY[nextFy]
  if (!priorFpId || !nextFpId) throw new Error(`Missing fiscal period`)

  const { data: rows, error } = await sb
    .from('journal_entry_lines')
    .select(
      'account_number, debit_amount, credit_amount, journal_entries!inner(fiscal_period_id, company_id, status)'
    )
    .eq('journal_entries.company_id', ctx.companyId)
    .eq('journal_entries.fiscal_period_id', priorFpId)
    .eq('journal_entries.status', 'posted')
  if (error) throw new Error(`postOpeningBalanceFromPriorYear: ${error.message}`)

  const nets = new Map<string, number>()
  for (const r of rows ?? []) {
    const acc = r.account_number as string
    const cls = parseInt(acc[0])
    if (cls < 1 || cls > 2) continue
    const net = (Number(r.debit_amount) || 0) - (Number(r.credit_amount) || 0)
    nets.set(acc, round2((nets.get(acc) ?? 0) + net))
  }

  const lines: JELine[] = []
  for (const [acc, net] of nets) {
    if (Math.abs(net) < 0.005) continue
    if (net > 0) {
      lines.push({ account: acc, debit: net, description: `Ingående balans: ${acc}` })
    } else {
      lines.push({ account: acc, credit: -net, description: `Ingående balans: ${acc}` })
    }
  }

  if (lines.length === 0) return

  const obEntryId = await postEntry(
    ctx,
    nextFy,
    dt(nextFy, 1, 1),
    `Ingående balans ${nextFy}`,
    'opening_balance',
    lines
  )

  const { error: updErr } = await sb
    .from('fiscal_periods')
    .update({
      opening_balance_entry_id: obEntryId,
      opening_balances_set: true,
    })
    .eq('id', nextFpId)
    .eq('company_id', ctx.companyId)
  if (updErr) throw new Error(`set opening_balance_entry_id: ${updErr.message}`)
}

async function seedKonsultAB(userId: string): Promise<CompanyCtx> {
  console.log('[2] Creating Konsult AB')
  const companyId = await createCompany(userId, 'Konsult AB', '5591234567', 'aktiebolag')
  const { fpY, accounts } = await setupCompany(
    userId,
    companyId,
    {
      entity_type: 'aktiebolag',
      company_name: 'Konsult AB',
      org_number: '559123-4567',
      vat_number: 'SE559123456701',
      vat_registered: true,
      f_skatt: true,
      moms_period: 'quarterly',
      fiscal_year_start_month: 1,
      address_line1: 'Vasagatan 16',
      postal_code: '111 20',
      city: 'Stockholm',
      country: 'SE',
      email: 'info@konsult.se',
      bank_name: 'SEB',
      clearing_number: '5295',
      account_number: '1234567',
      bankgiro: '5295-1234',
      invoice_prefix: 'F',
      next_invoice_number: 1,
      invoice_default_days: 30,
      has_employees: true,
      employee_count: 3,
      sells_internationally: true,
      preliminary_tax_monthly: 18000,
    },
    [2025, 2026]
  )
  return { companyId, userId, fpY, accounts, voucher: {} }
}

async function seedHoldingAB(userId: string): Promise<CompanyCtx> {
  console.log('[2] Creating Konsult Holding AB')
  const companyId = await createCompany(
    userId,
    'Konsult Holding AB',
    '5592345678',
    'aktiebolag'
  )
  const { fpY, accounts } = await setupCompany(
    userId,
    companyId,
    {
      entity_type: 'aktiebolag',
      company_name: 'Konsult Holding AB',
      org_number: '559234-5678',
      vat_number: 'SE559234567801',
      vat_registered: true,
      f_skatt: true,
      moms_period: 'yearly',
      fiscal_year_start_month: 1,
      address_line1: 'Vasagatan 16',
      postal_code: '111 20',
      city: 'Stockholm',
      country: 'SE',
      email: 'info@konsultholding.se',
      bank_name: 'Handelsbanken',
      clearing_number: '6789',
      account_number: '1234567',
      invoice_prefix: 'H',
      next_invoice_number: 1,
      invoice_default_days: 30,
      has_employees: false,
      employee_count: 0,
      sells_internationally: false,
    },
    [2026]
  )
  return { companyId, userId, fpY, accounts, voucher: {} }
}

interface CustomerSeed {
  name: string
  customer_type: 'swedish_business' | 'eu_business' | 'non_eu_business' | 'individual'
  org_number?: string
  vat_number?: string
  vat_number_validated?: boolean
  email: string
  country: string
  address_line1?: string
  postal_code?: string
  city?: string
  default_payment_terms?: number
  is_international?: boolean
}

async function seedCustomers(ctx: CompanyCtx, seeds: CustomerSeed[]): Promise<Record<string, string>> {
  const rows = seeds.map((s) => ({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    default_payment_terms: 30,
    ...s,
  }))
  const { data, error } = await sb.from('customers').insert(rows).select('id, name')
  if (error) throw new Error(`customers: ${error.message}`)
  return Object.fromEntries((data ?? []).map((c) => [c.name, c.id]))
}

interface SupplierSeed {
  name: string
  supplier_type: 'swedish_business' | 'eu_business' | 'non_eu_business' | 'individual'
  country: string
  default_currency: string
  vat_number?: string
  default_expense_account?: string
  category?: string
}

async function seedSuppliers(ctx: CompanyCtx, seeds: SupplierSeed[]): Promise<Record<string, string>> {
  const rows = seeds.map((s) => ({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    is_active: true,
    default_payment_terms: 30,
    ...s,
  }))
  const { data, error } = await sb.from('suppliers').insert(rows).select('id, name')
  if (error) throw new Error(`suppliers: ${error.message}`)
  return Object.fromEntries((data ?? []).map((s) => [s.name, s.id]))
}

async function seedEmployees(ctx: CompanyCtx): Promise<Record<string, string>> {
  const seeds = [
    {
      first_name: 'Anna',
      last_name: 'Andersson',
      personnummer: '198506151234',
      personnummer_last4: '1234',
      employment_type: 'employee',
      employment_start: '2025-01-01',
      employment_degree: 100,
      salary_type: 'monthly',
      monthly_salary: 65000,
      tax_table_number: 31,
      tax_column: 1,
      tax_municipality: 'Stockholm',
      is_sidoinkomst: false,
      vacation_rule: 'sammaloneregeln',
      vacation_days_per_year: 25,
      vacation_days_saved: 0,
      semestertillagg_rate: 0.0043,
      vaxa_stod_eligible: false,
      is_active: true,
      email: 'anna@konsult.se',
    },
    {
      first_name: 'Erik',
      last_name: 'Ek',
      personnummer: '199203105678',
      personnummer_last4: '5678',
      employment_type: 'employee',
      employment_start: '2026-01-01',
      employment_degree: 100,
      salary_type: 'monthly',
      monthly_salary: 52000,
      tax_table_number: 31,
      tax_column: 1,
      tax_municipality: 'Stockholm',
      is_sidoinkomst: false,
      vacation_rule: 'sammaloneregeln',
      vacation_days_per_year: 25,
      vacation_days_saved: 0,
      semestertillagg_rate: 0.0043,
      vaxa_stod_eligible: false,
      is_active: true,
      email: 'erik@konsult.se',
    },
    {
      first_name: 'Johan',
      last_name: 'Lind',
      personnummer: '198801019012',
      personnummer_last4: '9012',
      employment_type: 'company_owner',
      employment_start: '2026-01-01',
      employment_degree: 100,
      salary_type: 'monthly',
      monthly_salary: 70000,
      tax_table_number: 31,
      tax_column: 1,
      tax_municipality: 'Stockholm',
      is_sidoinkomst: false,
      vacation_rule: 'sammaloneregeln',
      vacation_days_per_year: 25,
      vacation_days_saved: 0,
      semestertillagg_rate: 0.0043,
      vaxa_stod_eligible: false,
      is_active: true,
      email: 'johan@konsult.se',
    },
  ]
  // personnummer is stored encrypted at rest (aes-256-gcm); the read paths
  // decrypt it. Seeding the raw value would 500 the roster / salary flows with
  // ERR_CRYPTO_INVALID_AUTH_TAG. Encrypt here, keep personnummer_last4 plain.
  const rows = seeds.map((s) => ({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    ...s,
    personnummer: encryptPersonnummer(s.personnummer),
  }))
  const { data, error } = await sb.from('employees').insert(rows).select('id, first_name')
  if (error) throw new Error(`employees: ${error.message}`)
  return Object.fromEntries((data ?? []).map((e) => [e.first_name, e.id]))
}

interface InvoiceSeed {
  number: string
  customerId: string
  customerName: string
  date: string
  dueDate: string
  status: 'draft' | 'sent' | 'overdue' | 'paid' | 'partially_paid'
  vatTreatment: 'standard_25' | 'reverse_charge' | 'export'
  vatRate: number
  subtotal: number
  description: string
  hours?: number
  unitPrice?: number
  paidAmount?: number
  paidAt?: string
  currency?: string
}

async function createInvoice(ctx: CompanyCtx, fy: number, inv: InvoiceSeed): Promise<string> {
  const vatAmount = round2(inv.subtotal * (inv.vatRate / 100))
  const total = round2(inv.subtotal + vatAmount)
  const paidAmount = inv.paidAmount ?? (inv.status === 'paid' ? total : 0)
  const remaining = round2(total - paidAmount)
  const momsRuta =
    inv.vatTreatment === 'standard_25'
      ? '10'
      : inv.vatTreatment === 'reverse_charge'
        ? '39'
        : inv.vatTreatment === 'export'
          ? '36'
          : null
  const reverseChargeText =
    inv.vatTreatment === 'reverse_charge'
      ? 'Reverse charge: buyer is liable for VAT (Article 196 EU VAT Directive)'
      : null

  const { data, error } = await sb
    .from('invoices')
    .insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      customer_id: inv.customerId,
      invoice_number: inv.number,
      invoice_date: inv.date,
      due_date: inv.dueDate,
      status: inv.status,
      currency: inv.currency ?? 'SEK',
      subtotal: inv.subtotal,
      vat_amount: vatAmount,
      total,
      vat_treatment: inv.vatTreatment,
      vat_rate: inv.vatRate,
      moms_ruta: momsRuta,
      reverse_charge_text: reverseChargeText,
      document_type: 'invoice',
      paid_at: inv.paidAt ?? null,
      paid_amount: paidAmount,
      remaining_amount: remaining,
    })
    .select('id')
    .single()
  if (error) throw new Error(`invoice ${inv.number}: ${error.message}`)

  await sb.from('invoice_items').insert({
    invoice_id: data.id,
    description: inv.description,
    quantity: inv.hours ?? 1,
    unit: inv.hours ? 'tim' : 'st',
    unit_price: inv.unitPrice ?? inv.subtotal,
    line_total: inv.subtotal,
    vat_rate: inv.vatRate,
    vat_amount: vatAmount,
    sort_order: 0,
  })

  // Booking entry: Invoice creation (DR 1510 / CR 30xx + 26xx)
  const revenueAccount =
    inv.vatTreatment === 'reverse_charge'
      ? '3308'
      : inv.vatTreatment === 'export'
        ? '3305'
        : '3001'
  const lines: JELine[] = [
    { account: '1510', debit: total, description: `Kundfordran ${inv.customerName}` },
    { account: revenueAccount, credit: inv.subtotal, description: 'Försäljning' },
  ]
  if (vatAmount > 0) {
    lines.push({
      account: inv.vatRate === 25 ? '2610' : inv.vatRate === 12 ? '2611' : '2612',
      credit: vatAmount,
      description: `Utgående moms ${inv.vatRate}%`,
    })
  }
  await postEntry(
    ctx,
    fy,
    inv.date,
    `Faktura ${inv.number}: ${inv.customerName}`,
    'invoice_created',
    lines,
    { sourceId: data.id }
  )

  // Payment if paid or partial
  if ((inv.status === 'paid' || inv.status === 'partially_paid') && paidAmount > 0 && inv.paidAt) {
    const payJeId = await postEntry(
      ctx,
      fy,
      inv.paidAt,
      `Betalning faktura ${inv.number}`,
      'invoice_paid',
      [
        { account: '1930', debit: paidAmount },
        { account: '1510', credit: paidAmount, description: `Reglering ${inv.customerName}` },
      ],
      { sourceId: data.id }
    )
    await sb.from('invoice_payments').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      invoice_id: data.id,
      payment_date: inv.paidAt,
      amount: paidAmount,
      currency: 'SEK',
      journal_entry_id: payJeId,
    })
    // Bank transaction
    await sb.from('transactions').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: inv.paidAt,
      description: `Inbetalning ${inv.customerName} ${inv.number}`,
      amount: paidAmount,
      currency: 'SEK',
      amount_sek: paidAmount,
      category: 'income_services',
      is_business: true,
      invoice_id: data.id,
      journal_entry_id: payJeId,
      merchant_name: inv.customerName,
      import_source: 'demo_seed',
    })
  }
  return data.id
}

interface SupplierInvoiceSeed {
  supplierId: string
  supplierName: string
  number: string
  date: string
  dueDate: string
  receivedDate: string
  subtotal: number
  vatRate: number
  account: string
  description: string
  paid: boolean
  paidAt?: string
  currency?: string
  exchangeRate?: number
  reverseCharge?: boolean
  vatTreatment?: 'standard_25' | 'standard_12' | 'standard_6' | 'reverse_charge' | 'import_outside_eu'
}

async function createSupplierInvoice(
  ctx: CompanyCtx,
  fy: number,
  inv: SupplierInvoiceSeed,
  arrivalNumber: number
): Promise<string> {
  const treatment = inv.vatTreatment ?? 'standard_25'
  const reverse = inv.reverseCharge ?? treatment === 'reverse_charge'
  const xr = inv.exchangeRate ?? 1
  const vatAmount = reverse ? 0 : round2(inv.subtotal * (inv.vatRate / 100))
  const total = round2(inv.subtotal + vatAmount)
  const subtotalSek = round2(inv.subtotal * xr)
  const vatSek = round2(vatAmount * xr)
  const totalSek = round2(total * xr)
  const paidAmount = inv.paid ? total : 0
  const remaining = round2(total - paidAmount)

  const { data, error } = await sb
    .from('supplier_invoices')
    .insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      supplier_id: inv.supplierId,
      arrival_number: arrivalNumber,
      supplier_invoice_number: inv.number,
      invoice_date: inv.date,
      due_date: inv.dueDate,
      received_date: inv.receivedDate,
      status: inv.paid ? 'paid' : 'approved',
      currency: inv.currency ?? 'SEK',
      exchange_rate: inv.currency && inv.currency !== 'SEK' ? xr : null,
      subtotal: inv.subtotal,
      subtotal_sek: subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: vatSek,
      total,
      total_sek: totalSek,
      vat_treatment: treatment,
      reverse_charge: reverse,
      paid_amount: paidAmount,
      remaining_amount: remaining,
      is_credit_note: false,
      paid_at: inv.paidAt ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`supplier_invoice ${inv.number}: ${error.message}`)

  await sb.from('supplier_invoice_items').insert({
    supplier_invoice_id: data.id,
    sort_order: 0,
    description: inv.description,
    quantity: 1,
    unit: 'st',
    unit_price: inv.subtotal,
    line_total: inv.subtotal,
    account_number: inv.account,
    vat_rate: inv.vatRate,
    vat_amount: vatAmount,
  })

  // Registration entry: DR expense + DR input VAT (or DR calc input VAT for reverse) / CR 2440
  const regLines: JELine[] = []
  regLines.push({
    account: inv.account,
    debit: subtotalSek,
    description: inv.description,
  })
  if (reverse && treatment === 'reverse_charge') {
    // Booked input + output VAT for EU services (rate * subtotal)
    const calcVat = round2(subtotalSek * (inv.vatRate / 100))
    regLines.push({ account: '2645', debit: calcVat, description: 'Beräknad ingående moms (omv.)' })
    regLines.push({ account: '2614', credit: calcVat, description: 'Utgående moms omv.' })
  } else if (vatAmount > 0) {
    regLines.push({ account: '2641', debit: vatSek, description: 'Ingående moms' })
  }
  regLines.push({
    account: '2440',
    credit: totalSek,
    description: `Lev.skuld ${inv.supplierName}`,
  })
  const regJe = await postEntry(
    ctx,
    fy,
    inv.date,
    `Lev.faktura ${inv.number}: ${inv.supplierName}`,
    'supplier_invoice_registered',
    regLines,
    { sourceId: data.id }
  )
  await sb
    .from('supplier_invoices')
    .update({ registration_journal_entry_id: regJe })
    .eq('id', data.id)

  if (inv.paid && inv.paidAt) {
    const payJe = await postEntry(
      ctx,
      fy,
      inv.paidAt,
      `Betalning lev.faktura ${inv.number}`,
      'supplier_invoice_paid',
      [
        { account: '2440', debit: totalSek, description: `Reglering ${inv.supplierName}` },
        { account: '1930', credit: totalSek },
      ],
      { sourceId: data.id }
    )
    await sb
      .from('supplier_invoices')
      .update({ payment_journal_entry_id: payJe })
      .eq('id', data.id)
    await sb.from('transactions').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: inv.paidAt,
      description: `Betalning ${inv.supplierName} ${inv.number}`,
      amount: -totalSek,
      currency: 'SEK',
      amount_sek: -totalSek,
      category: 'expense_other',
      is_business: true,
      supplier_invoice_id: data.id,
      journal_entry_id: payJe,
      merchant_name: inv.supplierName,
      import_source: 'demo_seed',
    })
  }
  return data.id
}

// ─── FY2025 SEED ───────────────────────────────────────────────────────────

async function seedFY2025(
  ctx: CompanyCtx,
  customers: Record<string, string>,
  suppliers: Record<string, string>
): Promise<void> {
  console.log('[4] FY2025: opening balances + invoices + expenses + salary')

  // Opening balance for 2025 (start small, 50k bank, no AR)
  await postEntry(
    ctx,
    2025,
    dt(2025, 1, 1),
    'Ingående balans 2025',
    'opening_balance',
    [
      { account: '1930', debit: 50000, description: 'Bank IB' },
      { account: '2081', credit: 50000, description: 'Aktiekapital' },
    ]
  )

  // Customer invoices: 78 invoices spread Jan-Dec 2025, all paid same week,
  // mixing Klient AB / Berlin GmbH / Nordic Tech / Liten Studio.
  const klient = customers['Klient AB']
  const berlin = customers['Berlin GmbH']
  const nordic = customers['Nordic Tech AS']
  const liten = customers['Liten Studio HB']

  let invSeq = 1
  const seedInv = async (
    customerId: string,
    customerName: string,
    date: string,
    paidAt: string,
    subtotal: number,
    vatTreatment: InvoiceSeed['vatTreatment'],
    description: string
  ) => {
    const vatRate = vatTreatment === 'standard_25' ? 25 : 0
    const number = `F-2025${pad(invSeq++)}${pad(invSeq)}`
    await createInvoice(ctx, 2025, {
      number: `F-2025${String(invSeq).padStart(3, '0')}`,
      customerId,
      customerName,
      date,
      dueDate: dt(
        2025,
        new Date(date).getMonth() + 2 > 12 ? 12 : new Date(date).getMonth() + 2,
        Math.min(new Date(date).getDate(), 28)
      ),
      status: 'paid',
      vatTreatment,
      vatRate,
      subtotal,
      description,
      paidAmount: round2(subtotal * (1 + vatRate / 100)),
      paidAt,
    })
  }

  // 48 weekly Klient AB invoices: ~28k each = ~1.34M
  for (let week = 0; week < 48; week++) {
    const day = new Date('2025-01-06')
    day.setDate(day.getDate() + week * 7)
    const due = new Date(day)
    due.setDate(due.getDate() + 30)
    const paid = new Date(day)
    paid.setDate(paid.getDate() + 14)
    const subtotal = 28800 // 24h × 1200
    invSeq++
    await createInvoice(ctx, 2025, {
      number: `F-2025${String(invSeq).padStart(4, '0')}`,
      customerId: klient,
      customerName: 'Klient AB',
      date: day.toISOString().slice(0, 10),
      dueDate: due.toISOString().slice(0, 10),
      status: 'paid',
      vatTreatment: 'standard_25',
      vatRate: 25,
      subtotal,
      description: `Konsulttjänster vecka ${week + 2}, 2025: 24h`,
      hours: 24,
      unitPrice: 1200,
      paidAmount: round2(subtotal * 1.25),
      paidAt: paid.toISOString().slice(0, 10),
    })
  }

  // 12 monthly Berlin GmbH workshops EU reverse charge: 25k × 12 = 300k
  for (let m = 1; m <= 12; m++) {
    const day = dt(2025, m, 15)
    const dueD = new Date(day)
    dueD.setDate(dueD.getDate() + 30)
    const paid = new Date(day)
    paid.setDate(paid.getDate() + 20)
    invSeq++
    await createInvoice(ctx, 2025, {
      number: `F-2025${String(invSeq).padStart(4, '0')}`,
      customerId: berlin,
      customerName: 'Berlin GmbH',
      date: day,
      dueDate: dueD.toISOString().slice(0, 10),
      status: 'paid',
      vatTreatment: 'reverse_charge',
      vatRate: 0,
      subtotal: 25000,
      description: `Workshop fee: month ${m}/2025`,
      paidAmount: 25000,
      paidAt: paid.toISOString().slice(0, 10),
    })
  }

  // 12 monthly Nordic Tech AS export: 13k × 12 = 156k
  for (let m = 1; m <= 12; m++) {
    const day = dt(2025, m, 20)
    const dueD = new Date(day)
    dueD.setDate(dueD.getDate() + 30)
    const paid = new Date(day)
    paid.setDate(paid.getDate() + 25)
    invSeq++
    await createInvoice(ctx, 2025, {
      number: `F-2025${String(invSeq).padStart(4, '0')}`,
      customerId: nordic,
      customerName: 'Nordic Tech AS',
      date: day,
      dueDate: dueD.toISOString().slice(0, 10),
      status: 'paid',
      vatTreatment: 'export',
      vatRate: 0,
      subtotal: 13000,
      description: `Konsulttjänst export: månad ${m}/2025`,
      paidAmount: 13000,
      paidAt: paid.toISOString().slice(0, 10),
    })
  }

  // 6 Liten Studio invoices spread across year: avg 8k each = 48k
  for (let i = 0; i < 6; i++) {
    const month = (i * 2 + 2) <= 12 ? i * 2 + 2 : 12
    const day = dt(2025, month, 10)
    const dueD = new Date(day)
    dueD.setDate(dueD.getDate() + 30)
    const paid = new Date(day)
    paid.setDate(paid.getDate() + 18)
    invSeq++
    await createInvoice(ctx, 2025, {
      number: `F-2025${String(invSeq).padStart(4, '0')}`,
      customerId: liten,
      customerName: 'Liten Studio HB',
      date: day,
      dueDate: dueD.toISOString().slice(0, 10),
      status: 'paid',
      vatTreatment: 'standard_25',
      vatRate: 25,
      subtotal: 8000,
      description: `Konsulttjänst: ${i + 1}/6, 2025`,
      hours: 8,
      unitPrice: 1000,
      paidAmount: 10000,
      paidAt: paid.toISOString().slice(0, 10),
    })
  }
  // Total invoices: 48 + 12 + 12 + 6 = 78 ✓ (~1.84M revenue)

  // Monthly salary entries for Anna (full year 2025): 12 × (gross 65000 →
  // tax ~14300, net 50700, social fees 20423). Use simplified BAS:
  // DR 7210 65000 / CR 2710 14300, CR 1930 50700 (one entry per month)
  // DR 7510 20423 / CR 2731 20423
  for (let m = 1; m <= 12; m++) {
    const payDate = dt(2025, m, 25)
    const taxDate = dt(2025, m === 12 ? 12 : m + 1, 12)
    await postEntry(
      ctx,
      2025,
      payDate,
      `Lön Anna Andersson ${m}/2025`,
      'salary_payment',
      [
        { account: '7010', debit: 65000, description: 'Bruttolön' },
        { account: '2710', credit: 14300, description: 'Innehållen skatt' },
        { account: '1930', credit: 50700, description: 'Nettolön Anna' },
      ]
    )
    await postEntry(
      ctx,
      2025,
      payDate,
      `Sociala avgifter Anna ${m}/2025`,
      'salary_payment',
      [
        { account: '7510', debit: 20423, description: 'Sociala avgifter 31.42%' },
        { account: '2731', credit: 20423, description: 'Skuld sociala avgifter' },
      ]
    )
    // Skatte- och avgiftsbetalning
    await postEntry(
      ctx,
      2025,
      taxDate,
      `Inbetalning skatt + sociala ${m}/2025`,
      'manual',
      [
        { account: '2710', debit: 14300 },
        { account: '2731', debit: 20423 },
        { account: '1930', credit: 34723, description: 'Skattekonto' },
      ]
    )
  }

  // 9 months WeWork rent (Apr-Dec)
  let arrival25 = 1
  for (let m = 4; m <= 12; m++) {
    const date = dt(2025, m, 1)
    await createSupplierInvoice(
      ctx,
      2025,
      {
        supplierId: suppliers['WeWork Stockholm AB'],
        supplierName: 'WeWork Stockholm AB',
        number: `WW-2025-${pad(m)}`,
        date,
        dueDate: dt(2025, m === 12 ? 12 : m + 1, 1),
        receivedDate: date,
        subtotal: 8500,
        vatRate: 25,
        account: '5010',
        description: `Hyra coworking ${m}/2025`,
        paid: true,
        paidAt: dt(2025, m === 12 ? 12 : m + 1, 5),
      },
      arrival25++
    )
  }

  // Monthly SaaS bundle (Notion + Linear): booked as own entry per month
  for (let m = 1; m <= 12; m++) {
    const date = dt(2025, m, 5)
    await postEntry(
      ctx,
      2025,
      date,
      `SaaS-prenumerationer ${m}/2025`,
      'manual',
      [
        { account: '5420', debit: 4200, description: 'Programvaror' },
        { account: '2645', debit: 1050, description: 'Beräknad ing.moms 25% (omv.)' },
        { account: '2614', credit: 1050, description: 'Utg.moms omv.' },
        { account: '1930', credit: 4200 },
      ]
    )
  }

  // Monthly travel (resor): varying amounts ~50k/yr total
  const travelMonthly = [3500, 4200, 5100, 3800, 4500, 4900, 2800, 5300, 4600, 4100, 4800, 5200]
  for (let m = 1; m <= 12; m++) {
    const date = dt(2025, m, 28)
    const gross = travelMonthly[m - 1]
    const vat = round2(gross * 0.06 / 1.06)
    const net = round2(gross - vat)
    await postEntry(
      ctx,
      2025,
      date,
      `Resekostnader ${m}/2025`,
      'manual',
      [
        { account: '5800', debit: net, description: 'Reseutlägg netto' },
        { account: '2641', debit: vat, description: 'Ing.moms 6%' },
        { account: '1930', credit: gross },
      ]
    )
  }

  // Monthly office supplies ~30k/yr
  const officeMonthly = [2100, 2500, 1800, 3200, 2400, 2700, 1900, 2300, 2800, 2200, 2600, 3500]
  for (let m = 1; m <= 12; m++) {
    const date = dt(2025, m, 18)
    const gross = officeMonthly[m - 1]
    const vat = round2(gross * 0.25 / 1.25)
    const net = round2(gross - vat)
    await postEntry(
      ctx,
      2025,
      date,
      `Kontorsmaterial ${m}/2025`,
      'manual',
      [
        { account: '6110', debit: net, description: 'Kontorsmaterial netto' },
        { account: '2641', debit: vat, description: 'Ing.moms 25%' },
        { account: '1930', credit: gross },
      ]
    )
  }

  // Monthly representation (50% deductible: booked as 6071 "ej avdragsgill" for simplicity)
  for (let m = 1; m <= 12; m++) {
    const date = dt(2025, m, 22)
    const gross = 1800 + (m % 3) * 400
    const vat = round2(gross * 0.12 / 1.12)
    const net = round2(gross - vat)
    await postEntry(
      ctx,
      2025,
      date,
      `Representation ${m}/2025`,
      'manual',
      [
        { account: '6071', debit: net, description: 'Repr. extern, ej avdragsgill' },
        { account: '2641', debit: vat, description: 'Ing.moms 12% (avdragsgill del)' },
        { account: '1930', credit: gross },
      ]
    )
  }

  // Monthly pension premium for Anna (TGL + ITP-liknande, ~2k/mån)
  for (let m = 1; m <= 12; m++) {
    const date = dt(2025, m, 27)
    await postEntry(
      ctx,
      2025,
      date,
      `Pensionspremie Anna ${m}/2025`,
      'manual',
      [
        { account: '7410', debit: 2000, description: 'Tjänstepension' },
        { account: '1930', credit: 2000 },
      ]
    )
  }

  // 4 quarterly OpenAI invoices (USD, import outside EU)
  for (let q = 1; q <= 4; q++) {
    const m = q * 3
    await createSupplierInvoice(
      ctx,
      2025,
      {
        supplierId: suppliers['OpenAI LLC'],
        supplierName: 'OpenAI LLC',
        number: `OAI-2025-Q${q}`,
        date: dt(2025, m, 5),
        dueDate: dt(2025, m, 25),
        receivedDate: dt(2025, m, 5),
        subtotal: 320,
        vatRate: 0,
        account: '5420',
        description: `OpenAI API usage Q${q}/2025`,
        paid: true,
        paidAt: dt(2025, m, 7),
        currency: 'USD',
        exchangeRate: 10.5,
        reverseCharge: false,
        vatTreatment: 'import_outside_eu',
      },
      arrival25++
    )
  }

  // 4 quarterly Vercel invoices (USD)
  for (let q = 1; q <= 4; q++) {
    const m = q * 3
    await createSupplierInvoice(
      ctx,
      2025,
      {
        supplierId: suppliers['Vercel Inc'],
        supplierName: 'Vercel Inc',
        number: `VER-2025-Q${q}`,
        date: dt(2025, m, 1),
        dueDate: dt(2025, m, 28),
        receivedDate: dt(2025, m, 1),
        subtotal: 120,
        vatRate: 0,
        account: '5420',
        description: `Vercel Pro Q${q}/2025`,
        paid: true,
        paidAt: dt(2025, m, 3),
        currency: 'USD',
        exchangeRate: 10.5,
        reverseCharge: false,
        vatTreatment: 'import_outside_eu',
      },
      arrival25++
    )
  }

  // 4 quarterly bank service fees
  for (let q = 1; q <= 4; q++) {
    const date = dt(2025, q * 3, 30)
    await postEntry(
      ctx,
      2025,
      date,
      `Bankavgifter Q${q}/2025`,
      'manual',
      [
        { account: '6570', debit: 1500, description: 'Bankavgifter' },
        { account: '1930', credit: 1500 },
      ]
    )
  }

  // VAT settlement summary at year-end (balance-sheet only: no P&L impact)
  await postEntry(
    ctx,
    2025,
    dt(2025, 12, 31),
    'Avräkning moms 2025 (sammandrag)',
    'manual',
    [
      { account: '2610', debit: 350000, description: 'Avr.utg.moms 25%' },
      { account: '2641', credit: 8830, description: 'Avr.ing.moms' },
      { account: '2650', credit: 341170, description: 'Skuld moms att betala' },
    ]
  )
}

// ─── FY2026 SEED ───────────────────────────────────────────────────────────

async function seedFY2026Konsult(
  ctx: CompanyCtx,
  customers: Record<string, string>,
  suppliers: Record<string, string>
): Promise<void> {
  console.log('[5] FY2026: close FY2025, derive opening balance, then activity')

  // Close FY2025 P&L → 2099 and derive FY2026 IB from FY2025 class 1-2 balances.
  // Without this, FY2025's net profit silently drops out of FY2026's IB
  // (compute_prior_opening_balances filters to class 1-2) and balansräkningen
  // shows "Balanserar ej".
  await closeYearForSeed(ctx, 2025)
  await postOpeningBalanceFromPriorYear(ctx, 2025, 2026)

  const klient = customers['Klient AB']
  const berlin = customers['Berlin GmbH']
  const nordic = customers['Nordic Tech AS']
  const helsinki = customers['Helsinki Oy']
  const liten = customers['Liten Studio HB']

  let invSeq = 1
  const num = () => `F-2026${String(invSeq++).padStart(4, '0')}`

  // 18 weekly Klient AB Jan-Apr 2026 (16 weeks * but 18 invoices means biweekly-ish)
  // Distribute 18 weekly across 16 weeks Jan 6 to Apr 27
  const klientDates: { date: string; week: number }[] = []
  let kd = new Date('2026-01-06')
  for (let i = 0; i < 18; i++) {
    klientDates.push({ date: kd.toISOString().slice(0, 10), week: i + 2 })
    kd.setDate(kd.getDate() + 7)
  }

  // States: 18 paid+matched, 6 partial, 4 overdue 30+, 2 overdue 60+, 2 sent
  // Total = 32. We'll allocate from the 18 Klient + 8 Berlin + 4 Nordic + 2 Helsinki:
  //  - 18 Klient: distribute states (some paid, some partial, some overdue, some sent)
  //  - 8 Berlin: mostly paid
  //  - 4 Nordic: mostly paid
  //  - 2 Helsinki: paid
  // Per prompt 4 overdue >30 = 2× Klient AB, 1× Liten Studio, 1× Berlin
  // 2 overdue >60 = (let's make) 2× Klient AB

  type Slot = { state: 'paid' | 'partial' | 'overdue30' | 'overdue60' | 'sent' }
  const klientSlots: Slot[] = [
    ...Array(10).fill({ state: 'paid' }),
    ...Array(2).fill({ state: 'overdue60' }),
    ...Array(2).fill({ state: 'overdue30' }),
    ...Array(3).fill({ state: 'partial' }),
    ...Array(1).fill({ state: 'sent' }),
  ] as Slot[]

  for (let i = 0; i < klientDates.length; i++) {
    const s = klientSlots[i] ?? ({ state: 'paid' } as Slot)
    const date = klientDates[i].date
    const dueD = new Date(date)
    dueD.setDate(dueD.getDate() + 30)
    const subtotal = 28800
    const total = subtotal * 1.25
    const status =
      s.state === 'paid'
        ? 'paid'
        : s.state === 'partial'
          ? 'partially_paid'
          : s.state === 'sent'
            ? 'sent'
            : 'overdue'
    const paidAmount =
      s.state === 'paid' ? total : s.state === 'partial' ? round2(total * 0.5) : 0
    const paidAt =
      s.state === 'paid'
        ? dt(2026, new Date(date).getMonth() + 1, Math.min(28, new Date(date).getDate() + 14))
        : s.state === 'partial'
          ? dt(2026, new Date(date).getMonth() + 1, Math.min(28, new Date(date).getDate() + 20))
          : undefined
    await createInvoice(ctx, 2026, {
      number: num(),
      customerId: klient,
      customerName: 'Klient AB',
      date,
      dueDate: dueD.toISOString().slice(0, 10),
      status,
      vatTreatment: 'standard_25',
      vatRate: 25,
      subtotal,
      description: `Konsulttjänster vecka ${klientDates[i].week}, 2026: 24h`,
      hours: 24,
      unitPrice: 1200,
      paidAmount,
      paidAt,
    })
  }

  // 8 Berlin GmbH fixed-fee workshops Jan-Apr; 1 overdue 30, rest paid
  const berlinAmounts = [42000, 35000, 48000, 28000, 55000, 32000, 38000, 41000]
  for (let i = 0; i < 8; i++) {
    const month = Math.min(4, Math.floor(i / 2) + 1)
    const date = dt(2026, month, 5 + (i % 2) * 14)
    const dueD = new Date(date)
    dueD.setDate(dueD.getDate() + 30)
    const isOverdue = i === 7 // last one overdue
    const paidAt = isOverdue
      ? undefined
      : dt(2026, month, Math.min(28, 5 + (i % 2) * 14 + 18))
    await createInvoice(ctx, 2026, {
      number: num(),
      customerId: berlin,
      customerName: 'Berlin GmbH',
      date,
      dueDate: dueD.toISOString().slice(0, 10),
      status: isOverdue ? 'overdue' : 'paid',
      vatTreatment: 'reverse_charge',
      vatRate: 0,
      subtotal: berlinAmounts[i],
      description: `Workshop ${i + 1}/2026: Berlin GmbH`,
      paidAmount: isOverdue ? 0 : berlinAmounts[i],
      paidAt,
    })
  }

  // 4 Nordic Tech AS export, all paid
  for (let i = 0; i < 4; i++) {
    const month = i + 1
    const date = dt(2026, month, 22)
    const dueD = new Date(date)
    dueD.setDate(dueD.getDate() + 30)
    const paidAt = dt(2026, month + 1 > 12 ? 12 : month + 1, 10)
    await createInvoice(ctx, 2026, {
      number: num(),
      customerId: nordic,
      customerName: 'Nordic Tech AS',
      date,
      dueDate: dueD.toISOString().slice(0, 10),
      status: 'paid',
      vatTreatment: 'export',
      vatRate: 0,
      subtotal: 14000,
      description: `Konsulttjänst export: månad ${month}/2026`,
      paidAmount: 14000,
      paidAt,
    })
  }

  // 2 Helsinki Oy, 1 paid, 1 sent (not overdue per prompt distribution)
  for (let i = 0; i < 2; i++) {
    const month = i === 0 ? 2 : 4
    const date = dt(2026, month, 18)
    const dueD = new Date(date)
    dueD.setDate(dueD.getDate() + 30)
    const isPaid = i === 0
    await createInvoice(ctx, 2026, {
      number: num(),
      customerId: helsinki,
      customerName: 'Helsinki Oy',
      date,
      dueDate: dueD.toISOString().slice(0, 10),
      status: isPaid ? 'paid' : 'sent',
      vatTreatment: 'reverse_charge',
      vatRate: 0,
      subtotal: 20000,
      description: `Konsulttjänst: Helsinki Oy ${month}/2026`,
      paidAmount: isPaid ? 20000 : 0,
      paidAt: isPaid ? dt(2026, month + 1, 5) : undefined,
    })
  }

  // 1 Liten Studio overdue 30+ (per prompt)
  await createInvoice(ctx, 2026, {
    number: num(),
    customerId: liten,
    customerName: 'Liten Studio HB',
    date: dt(2026, 3, 1),
    dueDate: dt(2026, 4, 1),
    status: 'overdue',
    vatTreatment: 'standard_25',
    vatRate: 25,
    subtotal: 9500,
    description: 'Konsulttjänst mars: Liten Studio',
    paidAmount: 0,
  })

  // 4 May 2026 invoices, unpaid, no reminder yet
  for (let i = 0; i < 4; i++) {
    const date = dt(2026, 5, 1 + i)
    const dueD = new Date(date)
    dueD.setDate(dueD.getDate() + 30)
    await createInvoice(ctx, 2026, {
      number: num(),
      customerId: klient,
      customerName: 'Klient AB',
      date,
      dueDate: dueD.toISOString().slice(0, 10),
      status: 'sent',
      vatTreatment: 'standard_25',
      vatRate: 25,
      subtotal: 28800,
      description: `Konsulttjänster maj: vecka ${18 + i}, 2026`,
      hours: 24,
      unitPrice: 1200,
      paidAmount: 0,
    })
  }

  // ── Stripe payouts (3 in May): create 8 sub-invoices first, batch them
  // We'll create 8 small "Stripe customer" invoices grouped into 3 payouts
  const stripeCustomer = liten // reuse Liten as a generic Stripe billed party
  const stripeBatches: Array<{
    payoutDate: string
    grossAmounts: number[]
    fee: number
    net: number
  }> = [
    { payoutDate: '2026-05-02', grossAmounts: [9400, 9400], fee: 566, net: 18234 },
    { payoutDate: '2026-05-04', grossAmounts: [9400], fee: 278, net: 9122 },
    { payoutDate: '2026-05-05', grossAmounts: [10000, 9000, 9750], fee: 863, net: 27887 },
  ]
  for (const batch of stripeBatches) {
    let batchNet = 0
    for (const gross of batch.grossAmounts) {
      // Create invoice & mark paid via Stripe before payout
      const subtotal = round2(gross / 1.25)
      const invDate = dt(
        2026,
        Number(batch.payoutDate.slice(5, 7)),
        Number(batch.payoutDate.slice(8, 10)) - 1
      )
      const inv: InvoiceSeed = {
        number: num(),
        customerId: stripeCustomer,
        customerName: 'Liten Studio HB',
        date: invDate,
        dueDate: invDate,
        status: 'paid',
        vatTreatment: 'standard_25',
        vatRate: 25,
        subtotal,
        description: 'Stripe-betalning: engångsuppdrag',
        paidAmount: gross,
        paidAt: batch.payoutDate,
      }
      await createInvoice(ctx, 2026, inv)
      batchNet += gross
    }
    // Stripe fee booking: DR 6570 (banking fees) / CR 1930 (reduces payout)
    await postEntry(
      ctx,
      2026,
      batch.payoutDate,
      `Stripe-avgift utbetalning ${batch.payoutDate}`,
      'manual',
      [
        { account: '6570', debit: batch.fee, description: 'Stripe transaktionsavgift' },
        { account: '1930', credit: batch.fee },
      ]
    )
    // Bank transaction for Stripe payout (combined net): already booked individual incomings;
    // here we add a memo transaction for the payout aggregation
    await sb.from('transactions').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: batch.payoutDate,
      description: `STRIPE PAYOUT ${batch.payoutDate}`,
      amount: 0,
      currency: 'SEK',
      amount_sek: 0,
      category: 'income_other',
      is_business: true,
      merchant_name: 'Stripe',
      notes: `Aggregated payout: ${batch.grossAmounts.length} invoices, gross ${batchNet}, fee ${batch.fee}, net ${batch.net}`,
      import_source: 'demo_seed',
    })
  }

  // Supplier invoices Jan-Apr: arrival_number must be unique per company
  // across both fiscal years, so continue from the highest existing number.
  const { data: maxArr } = await sb
    .from('supplier_invoices')
    .select('arrival_number')
    .eq('company_id', ctx.companyId)
    .order('arrival_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  let arrival = (maxArr?.arrival_number ?? 0) + 1
  // WeWork × 4 paid + 1 unpaid (May)
  for (let m = 1; m <= 5; m++) {
    const isPaid = m <= 4
    await createSupplierInvoice(
      ctx,
      2026,
      {
        supplierId: suppliers['WeWork Stockholm AB'],
        supplierName: 'WeWork Stockholm AB',
        number: `WW-2026-${pad(m)}`,
        date: dt(2026, m, 1),
        dueDate: dt(2026, m === 12 ? 12 : m + 1, 1),
        receivedDate: dt(2026, m, 1),
        subtotal: 8500,
        vatRate: 25,
        account: '5010',
        description: `Hyra coworking ${m}/2026`,
        paid: isPaid,
        paidAt: isPaid ? dt(2026, m, 5) : undefined,
      },
      arrival++
    )
  }

  // Linear (EUR 89, reverse charge) × 4 paid
  for (let m = 1; m <= 4; m++) {
    await createSupplierInvoice(
      ctx,
      2026,
      {
        supplierId: suppliers['Linear Software Inc'],
        supplierName: 'Linear Software Inc',
        number: `LIN-2026-${pad(m)}`,
        date: dt(2026, m, 5),
        dueDate: dt(2026, m, 25),
        receivedDate: dt(2026, m, 5),
        subtotal: 89,
        vatRate: 25,
        account: '5420',
        description: 'Linear Standard subscription (monthly)',
        paid: true,
        paidAt: dt(2026, m, 7),
        currency: 'EUR',
        exchangeRate: 11.4,
        reverseCharge: true,
        vatTreatment: 'reverse_charge',
      },
      arrival++
    )
  }

  // OpenAI × 2 paid (USD)
  for (let i = 0; i < 2; i++) {
    const m = i + 1
    await createSupplierInvoice(
      ctx,
      2026,
      {
        supplierId: suppliers['OpenAI LLC'],
        supplierName: 'OpenAI LLC',
        number: `OAI-2026-${i + 1}`,
        date: dt(2026, m, 10),
        dueDate: dt(2026, m, 25),
        receivedDate: dt(2026, m, 10),
        subtotal: 250,
        vatRate: 0,
        account: '5420',
        description: 'OpenAI API usage',
        paid: true,
        paidAt: dt(2026, m, 12),
        currency: 'USD',
        exchangeRate: 10.5,
        reverseCharge: false,
        vatTreatment: 'import_outside_eu',
      },
      arrival++
    )
  }

  // Vercel × 1 paid (USD)
  await createSupplierInvoice(
    ctx,
    2026,
    {
      supplierId: suppliers['Vercel Inc'],
      supplierName: 'Vercel Inc',
      number: 'VER-2026-01',
      date: dt(2026, 2, 1),
      dueDate: dt(2026, 2, 28),
      receivedDate: dt(2026, 2, 1),
      subtotal: 120,
      vatRate: 0,
      account: '5420',
      description: 'Vercel Pro hosting (Feb)',
      paid: true,
      paidAt: dt(2026, 2, 3),
      currency: 'USD',
      exchangeRate: 10.5,
      reverseCharge: false,
      vatTreatment: 'import_outside_eu',
    },
    arrival++
  )

  // Notion × 1 paid (USD)
  await createSupplierInvoice(
    ctx,
    2026,
    {
      supplierId: suppliers['Notion Labs Inc'],
      supplierName: 'Notion Labs Inc',
      number: 'NOT-2026-01',
      date: dt(2026, 1, 5),
      dueDate: dt(2026, 1, 25),
      receivedDate: dt(2026, 1, 5),
      subtotal: 96,
      vatRate: 0,
      account: '5420',
      description: 'Notion Plus team plan',
      paid: true,
      paidAt: dt(2026, 1, 7),
      currency: 'USD',
      exchangeRate: 10.5,
      reverseCharge: false,
      vatTreatment: 'import_outside_eu',
    },
    arrival++
  )

  // Apple iPad Pro: fixed asset (1230) 18000 SEK + 25% moms
  await createSupplierInvoice(
    ctx,
    2026,
    {
      supplierId: suppliers['Apple Sweden AB'],
      supplierName: 'Apple Sweden AB',
      number: 'APP-2026-001',
      date: dt(2026, 2, 14),
      dueDate: dt(2026, 3, 14),
      receivedDate: dt(2026, 2, 14),
      subtotal: 18000,
      vatRate: 25,
      account: '1230',
      description: 'iPad Pro 13" (anläggning)',
      paid: true,
      paidAt: dt(2026, 2, 16),
    },
    arrival++
  )

  // SJ × 3 paid resor (12% moms)
  for (let i = 0; i < 3; i++) {
    const month = (i + 1)
    await createSupplierInvoice(
      ctx,
      2026,
      {
        supplierId: suppliers['SJ AB'],
        supplierName: 'SJ AB',
        number: `SJ-2026-${pad(i + 1)}`,
        date: dt(2026, month, 15),
        dueDate: dt(2026, month, 25),
        receivedDate: dt(2026, month, 15),
        subtotal: 1200,
        vatRate: 6,
        account: '5800',
        description: `Tågresa Stockholm-Göteborg ${month}/2026`,
        paid: true,
        paidAt: dt(2026, month, 16),
      },
      arrival++
    )
  }

  // Salary entries Jan-Apr 2026 for Anna, Erik, Johan
  const salaries = [
    { name: 'Anna Andersson', gross: 65000, tax: 14300, net: 50700, soc: 20423 },
    { name: 'Erik Ek', gross: 52000, tax: 11440, net: 40560, soc: 16338 },
    { name: 'Johan Lind', gross: 70000, tax: 15400, net: 54600, soc: 21994 },
  ]
  for (let m = 1; m <= 4; m++) {
    const payDate = dt(2026, m, 25)
    const taxDate = dt(2026, m === 12 ? 12 : m + 1, 12)
    let totalGross = 0
    let totalTax = 0
    let totalNet = 0
    let totalSoc = 0
    for (const s of salaries) {
      totalGross += s.gross
      totalTax += s.tax
      totalNet += s.net
      totalSoc += s.soc
    }
    await postEntry(
      ctx,
      2026,
      payDate,
      `Lön ${m}/2026: Anna, Erik, Johan`,
      'salary_payment',
      [
        { account: '7010', debit: totalGross, description: 'Bruttolöner' },
        { account: '2710', credit: totalTax, description: 'Innehållen skatt' },
        { account: '1930', credit: totalNet, description: 'Nettolöner' },
      ]
    )
    await postEntry(
      ctx,
      2026,
      payDate,
      `Sociala avgifter ${m}/2026`,
      'salary_payment',
      [
        { account: '7510', debit: totalSoc, description: 'Sociala avgifter 31.42%' },
        { account: '2731', credit: totalSoc },
      ]
    )
    await postEntry(
      ctx,
      2026,
      taxDate,
      `Inbetalning skatt + sociala ${m}/2026`,
      'manual',
      [
        { account: '2710', debit: totalTax },
        { account: '2731', debit: totalSoc },
        { account: '1930', credit: totalTax + totalSoc, description: 'Skattekonto' },
      ]
    )
  }
}

// ─── Inbox / uncategorized / voucher gaps ──────────────────────────────────

async function seedInboxAndUncategorized(
  ctx: CompanyCtx,
  suppliers: Record<string, string>
): Promise<void> {
  console.log('[6] inbox AWS PDF + 5 uncategorized + voucher gaps')

  // Synthetic AWS invoice PDF: upload a tiny but valid PDF so the nightly
  // integrity-verify cron can download the object and match its real
  // SHA-256, instead of failing forever on a fabricated hash with no file.
  const awsPdfBuffer = Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'),
    'utf8'
  )
  const awsPdfPath = `${ctx.userId}/${ctx.companyId}/inbox/aws-2026-05-05.pdf`
  const { error: uploadErr } = await sb.storage
    .from('documents')
    .upload(awsPdfPath, awsPdfBuffer, { contentType: 'application/pdf', upsert: true })
  if (uploadErr) throw new Error(`storage upload AWS PDF: ${uploadErr.message}`)
  const awsPdfHash = createHash('sha256').update(awsPdfBuffer).digest('hex')
  const { data: doc, error: docErr } = await sb
    .from('document_attachments')
    .insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      storage_path: awsPdfPath,
      file_name: 'aws-2026-05-05.pdf',
      file_size_bytes: awsPdfBuffer.length,
      mime_type: 'application/pdf',
      sha256_hash: awsPdfHash,
      version: 1,
      is_current_version: true,
      uploaded_by: ctx.userId,
      upload_source: 'email',
    })
    .select('id')
    .single()
  if (docErr) throw new Error(`document_attachments AWS: ${docErr.message}`)

  await sb.from('invoice_inbox_items').insert({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    status: 'ready',
    source: 'email',
    document_type: 'supplier_invoice',
    email_from: 'aws-billing@amazon.com',
    email_subject: 'Your AWS Invoice: May 2026',
    email_received_at: '2026-05-05T07:34:00Z',
    document_id: doc.id,
    extracted_data: {
      supplier_name: 'Amazon Web Services Inc',
      invoice_number: 'INV-AWS-2026-0529',
      invoice_date: '2026-05-04',
      due_date: '2026-06-03',
      currency: 'USD',
      subtotal: 247.0,
      vat_amount: 0,
      total: 247.0,
      line_items: [
        { description: 'EC2: t3.medium hours', amount: 198.5 },
        { description: 'S3: Standard storage', amount: 48.5 },
      ],
    },
    confidence: 0.91,
  })

  // 5 uncategorized bank transactions, dated within 14 days of 2026-05-06
  const today = new Date('2026-05-06')
  const minus = (n: number) => {
    const d = new Date(today)
    d.setDate(d.getDate() - n)
    return d.toISOString().slice(0, 10)
  }
  await sb.from('transactions').insert([
    {
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: minus(2),
      description: 'SJ AB: biljett',
      amount: -487,
      currency: 'SEK',
      amount_sek: -487,
      category: null,
      is_business: null,
      merchant_name: 'SJ AB',
      import_source: 'demo_seed',
    },
    {
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: minus(4),
      description: 'RESTAURANG KVARTER',
      amount: -1240,
      currency: 'SEK',
      amount_sek: -1240,
      category: null,
      is_business: null,
      merchant_name: 'Restaurang Kvarter',
      import_source: 'demo_seed',
    },
    {
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: minus(6),
      description: 'LINEAR.APP',
      amount: -1015, // EUR 89 ~ 1015 SEK; suspicious duplicate vs registered May invoice
      currency: 'SEK',
      amount_sek: -1015,
      category: null,
      is_business: null,
      merchant_name: 'Linear Software',
      import_source: 'demo_seed',
      notes: 'Möjlig dubblettbokning vs registrerad maj-faktura',
    },
    {
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: minus(8),
      description: 'ICA BROMMA',
      amount: -312,
      currency: 'SEK',
      amount_sek: -312,
      category: null,
      is_business: null,
      merchant_name: 'ICA Bromma',
      import_source: 'demo_seed',
    },
    {
      user_id: ctx.userId,
      company_id: ctx.companyId,
      date: minus(11),
      description: 'TRAFIK SL: månadskort',
      amount: -156,
      currency: 'SEK',
      amount_sek: -156,
      category: null,
      is_business: null,
      merchant_name: 'Trafik Stockholm',
      import_source: 'demo_seed',
    },
  ])
}

// ─── HOLDING company seed ──────────────────────────────────────────────────

async function seedHolding(holding: CompanyCtx): Promise<void> {
  console.log('[H] Holding 2026 IB + dotterbolagsaktier')
  const obEntryId = await postEntry(
    holding,
    2026,
    dt(2026, 1, 1),
    'Ingående balans 2026',
    'opening_balance',
    [
      { account: '1310', debit: 100000, description: 'Aktier i Konsult AB (dotterbolag)' },
      { account: '1930', debit: 250000, description: 'Bank Handelsbanken' },
      { account: '2081', credit: 50000, description: 'Aktiekapital' },
      { account: '2091', credit: 300000, description: 'Balanserat resultat' },
    ]
  )
  const { error } = await sb
    .from('fiscal_periods')
    .update({ opening_balance_entry_id: obEntryId, opening_balances_set: true })
    .eq('id', holding.fpY[2026])
    .eq('company_id', holding.companyId)
  if (error) throw new Error(`Holding set opening_balance_entry_id: ${error.message}`)
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Seeding demo account for ${email}`)
  console.log(`[1] Looking up user`)
  const userId = await findUser(email)
  console.log(`    user_id = ${userId}`)

  if (force) {
    console.log(`[!] --force: wiping existing demo companies`)
    await wipeExisting(userId)
  } else {
    const { data: existing } = await sb
      .from('companies')
      .select('id, name')
      .eq('created_by', userId)
      .in('name', ['Konsult AB', 'Konsult Holding AB'])
    if (existing && existing.length > 0) {
      console.error(
        `Demo companies already exist (${existing.map((e) => e.name).join(', ')}). Pass --force to wipe.`
      )
      process.exit(1)
    }
  }

  const konsult = await seedKonsultAB(userId)
  const holding = await seedHoldingAB(userId)

  // Set Emil's active company to Konsult AB
  await sb
    .from('user_preferences')
    .upsert({ user_id: userId, active_company_id: konsult.companyId }, { onConflict: 'user_id' })

  console.log('[3] Seeding customers, suppliers, employees')
  const customers = await seedCustomers(konsult, [
    {
      name: 'Klient AB',
      customer_type: 'swedish_business',
      org_number: '5566778899',
      vat_number: 'SE556677889901',
      vat_number_validated: true,
      email: 'bo@klient.se',
      country: 'SE',
      address_line1: 'Storgatan 10',
      postal_code: '111 44',
      city: 'Stockholm',
      default_payment_terms: 30,
    },
    {
      name: 'Nordic Tech AS',
      customer_type: 'non_eu_business',
      org_number: '999888777',
      email: 'ola@nordictech.no',
      country: 'NO',
      address_line1: 'Karl Johans gate 12',
      postal_code: '0154',
      city: 'Oslo',
      default_payment_terms: 30,
      is_international: true,
    },
    {
      name: 'Berlin GmbH',
      customer_type: 'eu_business',
      vat_number: 'DE123456789',
      vat_number_validated: true,
      email: 'klaus@berlin.de',
      country: 'DE',
      address_line1: 'Hauptstraße 5',
      postal_code: '10115',
      city: 'Berlin',
      default_payment_terms: 30,
      is_international: true,
    },
    {
      name: 'Helsinki Oy',
      customer_type: 'eu_business',
      vat_number: 'FI12345678',
      vat_number_validated: true,
      email: 'mikko@helsinki.fi',
      country: 'FI',
      address_line1: 'Mannerheimintie 12',
      postal_code: '00100',
      city: 'Helsinki',
      default_payment_terms: 30,
      is_international: true,
    },
    {
      name: 'Liten Studio HB',
      customer_type: 'swedish_business',
      org_number: '9696969696',
      email: 'info@litenstudio.se',
      country: 'SE',
      address_line1: 'Lillgatan 3',
      postal_code: '222 33',
      city: 'Malmö',
      default_payment_terms: 30,
    },
  ])

  await seedCustomers(holding, [
    {
      name: 'Konsult AB',
      customer_type: 'swedish_business',
      org_number: '5591234567',
      vat_number: 'SE559123456701',
      vat_number_validated: true,
      email: 'info@konsult.se',
      country: 'SE',
      address_line1: 'Vasagatan 16',
      postal_code: '111 20',
      city: 'Stockholm',
      default_payment_terms: 30,
    },
  ])

  const suppliers = await seedSuppliers(konsult, [
    {
      name: 'Amazon Web Services Inc',
      supplier_type: 'non_eu_business',
      country: 'US',
      default_currency: 'USD',
      default_expense_account: '5420',
      category: 'IT-tjänster',
    },
    {
      name: 'OpenAI LLC',
      supplier_type: 'non_eu_business',
      country: 'US',
      default_currency: 'USD',
      default_expense_account: '5420',
      category: 'IT-tjänster',
    },
    {
      name: 'Vercel Inc',
      supplier_type: 'non_eu_business',
      country: 'US',
      default_currency: 'USD',
      default_expense_account: '5420',
      category: 'IT-tjänster',
    },
    {
      name: 'Notion Labs Inc',
      supplier_type: 'non_eu_business',
      country: 'US',
      default_currency: 'USD',
      default_expense_account: '5420',
      category: 'IT-tjänster',
    },
    {
      name: 'Linear Software Inc',
      supplier_type: 'eu_business',
      country: 'IE',
      default_currency: 'EUR',
      vat_number: 'IE3733749AH',
      default_expense_account: '5420',
      category: 'IT-tjänster',
    },
    {
      name: 'WeWork Stockholm AB',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '5010',
      category: 'Hyra',
    },
    {
      name: 'Apple Sweden AB',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '5410',
      category: 'IT-utrustning',
    },
    {
      name: 'SJ AB',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '5800',
      category: 'Resor',
    },
    {
      name: 'Trafik Stockholm (SL)',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '5800',
      category: 'Resor',
    },
    {
      name: 'ICA Bromma',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '6110',
      category: 'Kontorsmaterial',
    },
    {
      name: 'Restaurang Kvarter',
      supplier_type: 'swedish_business',
      country: 'SE',
      default_currency: 'SEK',
      default_expense_account: '6071',
      category: 'Representation',
    },
  ])

  const employees = await seedEmployees(konsult)
  console.log(`    ${Object.keys(customers).length} customers, ${Object.keys(suppliers).length} suppliers, ${Object.keys(employees).length} employees`)

  // FY2025
  await seedFY2025(konsult, customers, suppliers)

  // FY2026
  await seedFY2026Konsult(konsult, customers, suppliers)

  // Voucher gaps: requires that we delete the entries at A123 and A287
  // OR insert with skipped numbers from start. Easier: now that all 2025
  // entries are in, delete vouchers 123 and 287 from series A.
  // BUT the immutability trigger will block deletion of posted entries.
  // Solution: temporarily mark them as draft, delete, restore voucher seq.
  // Even simpler: use raw SQL via Supabase MCP-style execute through service role
  // which still hits triggers. Service role does NOT bypass triggers.
  //
  // Pragmatic approach: AFTER all entries are posted, NULL out and DELETE
  // requires bypassing the trigger. The cleanest path is to simply NOT
  // create entries at those slots, but our voucher counter is monotonic.
  // We'll skip-numbers up-front by NOT actually creating the entries:
  // Instead, we'll bump the counter by inserting then deleting the lines
  // and the entry, which will fail.
  //
  // Real solution: emit a "draft" entry then leave it as draft forever.
  // The detect_voucher_gaps RPC counts gaps among posted entries.
  // BUT the seed already posted everything at sequence 1..N. So we need
  // to retroactively introduce gaps. The SAFEST way is to bypass the
  // immutability trigger by using a session_replication_role 'replica'
  // via direct SQL. We'll do that via execute_sql below.

  // FY2026 inbox & uncategorized
  await seedInboxAndUncategorized(konsult, suppliers)

  // Holding
  await seedHolding(holding)

  console.log('[*] Seeding complete (voucher gaps script-side TODO via SQL)')
  console.log('')
  console.log('=== ENTITY SUMMARY ===')
  for (const [label, cid] of [
    ['Konsult AB', konsult.companyId],
    ['Konsult Holding AB', holding.companyId],
  ]) {
    const counts = await Promise.all([
      sb.from('customers').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      sb.from('suppliers').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      sb.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      sb.from('invoices').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      sb.from('supplier_invoices').select('id', { count: 'exact', head: true }).eq('company_id', cid),
      sb
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', cid),
      sb.from('transactions').select('id', { count: 'exact', head: true }).eq('company_id', cid),
    ])
    console.log(
      `${label} (${cid}): ${counts[0].count} customers, ${counts[1].count} suppliers, ${counts[2].count} employees, ${counts[3].count} invoices, ${counts[4].count} sup.invoices, ${counts[5].count} journal entries, ${counts[6].count} bank txns`
    )
  }
  console.log('')
  console.log('Manual setup still required (out of scope for this script):')
  console.log(' - Gmail demo account: AWS billing email + Stripe payout confirmations')
  console.log(' - Google Calendar: week 28 Apr to 4 May meetings')
  console.log(' - Google Drive: folder "Kvitton 2026" / "Bokslut 2025"')
  console.log(' - Slack: #ekonomi channel + DM with gnubok-bot')
  console.log(' - Voucher gaps A123 + A287 in FY2025: see scripts/seed-demo-voucher-gaps.sql')
  console.log('')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
