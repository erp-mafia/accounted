import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { truncateIp } from '@/lib/api/v1/with-api-v1'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import { buildSandboxCustomers } from './customers'
import { buildSandboxPendingOperations } from './pending-operations'
import { buildSandboxArticles } from './articles'
import { buildSandboxVatDeadline } from './vat-deadline'
import {
  buildSandboxLedgerHistory,
  SANDBOX_LEDGER_ACCOUNT_NUMBERS,
} from './ledger-history'
import {
  buildSandboxEmployees,
  buildSandboxSalaryLineItems,
  buildSandboxSalaryRunEmployees,
  buildSandboxSalaryRuns,
  mapSandboxEmployeeIds,
  resolveSandboxSalaryPeriods,
  SANDBOX_RUN_TOTALS,
  SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER,
} from './salary'
import {
  buildSandboxSalaryVouchers,
  SANDBOX_SALARY_ACCOUNT_NUMBERS,
} from './salary-vouchers'

// Anonymous sign-in is enabled in all environments so visitors can try the
// product; a per-/24 cap on the seed endpoint keeps a single network from
// spinning up arbitrary sandbox companies. Idempotent for legit users, so 5/h
// covers retries; an attacker has to rotate /24s to scale abuse.
const RATE_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000 }

/**
 * POST /api/sandbox/seed
 * Seeds demo data for an anonymous sandbox user.
 * Only callable by anonymous users (is_anonymous === true).
 */
export async function POST(request: Request) {
  // Per-request logger so seed-failure entries are correlatable in the SIEM.
  // Cannot reuse withRouteContext here: it requires an active company, but
  // the sandbox seed runs *before* a company exists for the user.
  const requestId = `req_${crypto.randomUUID()}`
  const log = createLogger('sandbox:seed', { requestId })

  const fwd = request.headers.get('x-forwarded-for')
  const rawIp = fwd ? fwd.split(',')[0]?.trim() : request.headers.get('x-real-ip') ?? undefined
  // Fall back to a shared 'unknown' bucket when the proxy doesn't surface a
  // client IP: keeps the limit enforced under a misconfigured deploy rather
  // than failing open. Truncated /24 elsewhere is the normal path.
  const ipIdentifier = truncateIp(rawIp || undefined) ?? 'unknown'
  if (rawIp && ipIdentifier === 'unknown') {
    log.warn('unparseable forwarded-for header on sandbox seed', { headerLength: rawIp.length })
  }

  const rl = await checkRateLimit({
    prefix: 'sandbox:seed',
    identifier: ipIdentifier,
    ...RATE_LIMIT,
  })
  if (!rl.ok) return rl.response!

  // Can't use withRouteContext (see above, no company yet), so call requireAuth
  // directly: the documented stopgap that still enforces MFA. A no-op for the
  // anonymous users this route serves (they have no second factor), but keeps
  // the route on the same auth path as the rest of the API.
  //
  // GDPR Art.32 compensating controls for this anonymous, low-auth write path:
  // (1) anonymous-only: authenticated users are rejected below (403); (2) the
  // /24 rate limit above (5/h); (3) all seeded data is synthetic demo content
  // (fabricated names, example.com emails, documentation-reserved org numbers),
  // not real personal data; (4) writes are scoped to the caller's own freshly
  // created sandbox company, RLS-isolated from every other tenant.
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  if (!user.is_anonymous) {
    return NextResponse.json(
      { error: 'Sandbox is only available for anonymous users', requestId },
      { status: 403 },
    )
  }

  // Anonymous users start with no company. Create one before seeding.
  // If a previous seed attempt already created a company for this user, reuse it
  // (idempotency).
  let companyId = await getActiveCompanyId(supabase, user.id)

  if (!companyId) {
    const { data: newCompanyId, error: companyError } = await supabase.rpc(
      'create_company_with_owner',
      {
        p_name: 'Sandlådan Konsult',
        p_entity_type: 'enskild_firma',
      }
    )

    if (companyError || !newCompanyId) {
      log.error('failed to create sandbox company', { error: companyError, userId: user.id })
      return NextResponse.json(
        { error: 'Failed to create sandbox company', requestId },
        { status: 500 }
      )
    }

    companyId = newCompanyId as string
  }

  // Idempotency: if the core seed already ran (company_settings exists), skip
  // the bulk insert path. We still TOP UP the newer surfaces (agent_profile,
  // suppliers, asset, pending operations) afterwards so an old sandbox session
  // (created before those were added to the seed) picks them up on the next
  // call instead of being stuck without a verified assistant.
  const { data: existing } = await supabase
    .from('company_settings')
    .select('id')
    .eq('company_id', companyId)
    .maybeSingle()

  if (existing) {
    try {
      await topUpSandboxAdditions(supabase, companyId)
      return NextResponse.json({ seeded: false, topped_up: true })
    } catch (err) {
      log.error('failed to top up sandbox additions', { error: err, userId: user.id, companyId })
      return NextResponse.json({ seeded: false, topped_up: false })
    }
  }

  try {
    const userId = user.id

    // 1. Update profile (auto-created by auth trigger)
    await supabase
      .from('profiles')
      .update({ full_name: 'Demo Användare' })
      .eq('id', userId)

    // 2. Create company settings
    const { error: settingsError } = await supabase
      .from('company_settings')
      .insert({
        user_id: userId,
        company_id: companyId,
        entity_type: 'enskild_firma',
        company_name: 'Sandlådan Konsult',
        org_number: '199001011234',
        address_line1: 'Demovägen 1',
        postal_code: '111 22',
        city: 'Stockholm',
        country: 'SE',
        f_skatt: true,
        vat_registered: true,
        vat_number: 'SE199001011234',
        moms_period: 'quarterly',
        fiscal_year_start_month: 1,
        accounting_method: 'accrual',
        invoice_prefix: 'F',
        next_invoice_number: 5,
        next_delivery_note_number: 1,
        next_quote_number: 1,
        invoice_default_days: 30,
        // Sender bank details: the pain.001 debtor for the betalfil demo.
        // Example IBAN from the Swedish IBAN documentation range; BIC derives
        // from it being an SEB-style example. Demo-only values.
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESS',
        bankgiro: '991-2346',
        onboarding_step: 6,
        onboarding_complete: true,
        initial_setup_path: 'fresh',
        initial_setup_completed_at: new Date().toISOString(),
        initial_setup_dismissed_at: new Date().toISOString(),
        is_sandbox: true,
        // Dimensions demo: the register/pickers render out of the box.
        dimensions_enabled: true,
        // Payroll demo. `pays_salaries` is the UI gate DashboardNav reads to
        // decide whether Löner and Anställda appear at all (an enskild firma
        // is not an employer by default), and `employer_registered` is the
        // AGI gate. An EF may absolutely employ staff; what it may not do is
        // put its OWNER on payroll, which is why both seeded employees carry
        // employment_type 'employee' rather than 'company_owner'.
        pays_salaries: true,
        employer_registered: true,
      })

    if (settingsError) throw settingsError

    // 3. Seed chart of accounts via RPC
    const { error: coaError } = await supabase.rpc('seed_chart_of_accounts', {
      p_company_id: companyId,
      p_entity_type: 'enskild_firma',
    })
    if (coaError) throw coaError

    // 3b. Seed demo dimensions (kostnadsställe/projekt). ensure_company_dimensions
    // lazily creates the system dims 1/6; two values per dim give the register,
    // pickers, and the dimension-tagged journal lines below something to show.
    const { error: dimsRpcError } = await supabase.rpc('ensure_company_dimensions', {
      p_company_id: companyId,
    })
    if (dimsRpcError) throw dimsRpcError

    const { data: demoDims, error: demoDimsError } = await supabase
      .from('dimensions')
      .select('id, sie_dim_no')
      .eq('company_id', companyId)
      .in('sie_dim_no', [1, 6])
    if (demoDimsError) throw demoDimsError

    const dimIdByNo = Object.fromEntries(
      (demoDims ?? []).map(d => [d.sie_dim_no as number, d.id as string])
    ) as Record<number, string>

    if (dimIdByNo[1] && dimIdByNo[6]) {
      const seededDimensionCodes = ['BUTIK', 'WEBB', 'P001', 'P002']
      const { error: dimValuesError } = await supabase
        .from('dimension_values')
        .insert([
          { company_id: companyId, dimension_id: dimIdByNo[1], code: 'BUTIK', name: 'Butiken' },
          { company_id: companyId, dimension_id: dimIdByNo[1], code: 'WEBB', name: 'Webbshoppen' },
          { company_id: companyId, dimension_id: dimIdByNo[6], code: 'P001', name: 'Projekt Björk' },
          { company_id: companyId, dimension_id: dimIdByNo[6], code: 'P002', name: 'Projekt Alm' },
        ])
      if (dimValuesError) throw dimValuesError
      log.info('seeded sandbox dimension values', { companyId, codes: seededDimensionCodes })
    }

    // 4. Create fiscal period (current year)
    const currentYear = new Date().getFullYear()
    const { data: fiscalPeriod, error: fpError } = await supabase
      .from('fiscal_periods')
      .insert({
        user_id: userId,
        company_id: companyId,
        name: `Räkenskapsår ${currentYear}`,
        period_start: `${currentYear}-01-01`,
        period_end: `${currentYear}-12-31`,
      })
      .select('id')
      .single()

    if (fpError) throw fpError

    // 5. Create customers
    const { data: customers, error: custError } = await supabase
      .from('customers')
      .insert(buildSandboxCustomers(userId, companyId))
      .select('id, name')

    if (custError) throw custError

    const customerMap = Object.fromEntries(customers.map(c => [c.name, c.id]))

    // 6. Create invoices
    const today = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

    const thirtyDaysAgo = new Date(today)
    thirtyDaysAgo.setDate(today.getDate() - 30)
    const fifteenDaysAgo = new Date(today)
    fifteenDaysAgo.setDate(today.getDate() - 15)
    const thirtyDaysFromNow = new Date(today)
    thirtyDaysFromNow.setDate(today.getDate() + 30)
    const fiveDaysAgo = new Date(today)
    fiveDaysAgo.setDate(today.getDate() - 5)

    const { data: invoices, error: invError } = await supabase
      .from('invoices')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Björk & Partner AB'],
          invoice_number: 'F-2026001',
          invoice_date: toDateStr(thirtyDaysAgo),
          due_date: toDateStr(today),
          status: 'paid',
          subtotal: 15000,
          vat_amount: 3750,
          total: 18750,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
          paid_at: toDateStr(fifteenDaysAgo),
          paid_amount: 18750,
          remaining_amount: 0,
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Schmidt GmbH'],
          invoice_number: 'F-2026002',
          invoice_date: toDateStr(fifteenDaysAgo),
          due_date: toDateStr(thirtyDaysFromNow),
          status: 'sent',
          subtotal: 20000,
          vat_amount: 0,
          total: 20000,
          remaining_amount: 20000,
          paid_amount: 0,
          vat_treatment: 'reverse_charge',
          vat_rate: 0,
          reverse_charge_text: 'Reverse charge: buyer is liable for VAT',
          document_type: 'invoice',
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Anna Lindström'],
          invoice_number: 'F-2026003',
          invoice_date: toDateStr(thirtyDaysAgo),
          due_date: toDateStr(fiveDaysAgo),
          status: 'overdue',
          subtotal: 5000,
          vat_amount: 1250,
          total: 6250,
          remaining_amount: 6250,
          paid_amount: 0,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
        },
        {
          user_id: userId,
          company_id: companyId,
          customer_id: customerMap['Björk & Partner AB'],
          invoice_number: 'F-2026004',
          invoice_date: toDateStr(today),
          due_date: toDateStr(thirtyDaysFromNow),
          status: 'draft',
          subtotal: 8000,
          vat_amount: 2000,
          total: 10000,
          // PostgREST normalises a bulk insert to the union of keys: every row in
          // this batch carries both columns so none arrives as NULL.
          remaining_amount: 10000,
          paid_amount: 0,
          vat_treatment: 'standard_25',
          vat_rate: 25,
          moms_ruta: '10',
          document_type: 'invoice',
        },
      ])
      .select('id, invoice_number')

    if (invError) throw invError

    const invoiceMap = Object.fromEntries(invoices.map(i => [i.invoice_number, i.id]))

    // 7. Create invoice items
    const { error: itemsError } = await supabase
      .from('invoice_items')
      .insert([
        {
          invoice_id: invoiceMap['F-2026001'],
          description: 'Webbutveckling, mars 2026',
          quantity: 30,
          unit: 'tim',
          unit_price: 500,
          line_total: 15000,
          vat_rate: 25,
        },
        {
          invoice_id: invoiceMap['F-2026002'],
          description: 'IT-konsulting, internationellt projekt',
          quantity: 40,
          unit: 'tim',
          unit_price: 500,
          line_total: 20000,
          vat_rate: 0,
        },
        {
          invoice_id: invoiceMap['F-2026003'],
          description: 'Hemsida & grafisk profil',
          quantity: 1,
          unit: 'st',
          unit_price: 5000,
          line_total: 5000,
          vat_rate: 25,
        },
        {
          invoice_id: invoiceMap['F-2026004'],
          description: 'Systemunderhåll april 2026',
          quantity: 16,
          unit: 'tim',
          unit_price: 500,
          line_total: 8000,
          vat_rate: 25,
        },
      ])

    if (itemsError) throw itemsError

    // 8. Resolve account IDs for journal entries.
    //
    // seed_chart_of_accounts lays down the K1 subset, and its 7xxx personnel
    // block is gated on p_entity_type = 'aktiebolag'. The sandbox company is an
    // enskild firma, so none of the payroll accounts exist yet, and neither do
    // the semesterlöneskuld pair. Create the missing ones from the BAS 2026
    // reference first, exactly as ensureSalaryAccountsExist does before the
    // real booking path posts a salary run.
    const neededAccounts = [
      ...new Set([
        ...SANDBOX_LEDGER_ACCOUNT_NUMBERS,
        ...SANDBOX_SALARY_ACCOUNT_NUMBERS,
        '1510',
        '1930',
        '2611',
        '3001',
        // The 6 % article (a printed book) derives 3003/2631 at invoice-line
        // time; neither is in the K1 chart, so invoicing it would post to an
        // account the company does not have.
        '2631',
        '3003',
      ]),
    ]

    const { data: existingAccounts, error: existingAccountsError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .in('account_number', neededAccounts)
    if (existingAccountsError) throw existingAccountsError

    const existingAccountNumbers = new Set(
      (existingAccounts ?? []).map(a => a.account_number as string)
    )
    const missingAccounts = neededAccounts
      .filter(n => !existingAccountNumbers.has(n))
      .map(accountNumber => {
        const ref = getBASReference(accountNumber)
        // An account with no BAS 2026 reference would have to be invented here.
        // Better to fail the seed than to write a chart row with guessed
        // class/type/normal_balance that every report would then trust.
        if (!ref) {
          throw new Error(`Sandbox seed: no BAS reference for account ${accountNumber}`)
        }
        return {
          user_id: userId,
          company_id: companyId,
          account_number: accountNumber,
          account_name: ref.account_name,
          account_class: ref.account_class,
          account_group: ref.account_group,
          account_type: ref.account_type,
          normal_balance: ref.normal_balance,
          sru_code: ref.sru_code,
          k2_excluded: ref.k2_excluded,
          plan_type: 'full_bas',
          is_active: true,
          is_system_account: false,
        }
      })

    if (missingAccounts.length > 0) {
      const { error: missingAccountsError } = await supabase
        .from('chart_of_accounts')
        .insert(missingAccounts)
      if (missingAccountsError) throw missingAccountsError
    }

    // Errors are fatal here, not tolerable: a failed read would leave
    // accountMap empty and silently write account_id: null onto every
    // ledger-history and salary voucher line, producing a sandbox whose
    // vouchers reference no account at all.
    const { data: accounts, error: accountsError } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .in('account_number', neededAccounts)
    if (accountsError) throw accountsError

    const accountMap = Object.fromEntries(
      (accounts ?? []).map(a => [a.account_number, a.id])
    )

    // 9. Year-to-date ledger history (January through last month).
    //
    // Without it the company has two verifikat and every report is a flat
    // line: Resultatrapport, Balansrapport, Nyckeltal and Momsrapport all read
    // as broken rather than empty.
    //
    // Seeded BEFORE the invoice and payroll vouchers below on purpose.
    // next_voucher_number hands out numbers in call order, so seeding January
    // last would have produced A-1 dated in July followed by A-3 dated in
    // January: a gap-free sequence that runs backwards through the year, which
    // is not what BFNAR 2013:2 means by a chronological verifikationsserie.
    const ledgerHistory = buildSandboxLedgerHistory({
      userId,
      companyId,
      fiscalPeriodId: fiscalPeriod.id,
      today,
      accountMap,
    })

    // One RPC per voucher: next_voucher_number is a counter table with a row
    // lock (not MAX+1), so sequential calls are safe and gap-free. The two
    // writes are batched rather than run per entry, which is what turns ~130
    // round trips into ~45 for a seed that runs on every sandbox visit.
    const historyVoucherNumbers: number[] = []
    for (const historyEntry of ledgerHistory.entries) {
      const { data: historyVoucherNumber, error: historyVoucherError } = await supabase.rpc(
        'next_voucher_number',
        {
          p_company_id: companyId,
          p_fiscal_period_id: fiscalPeriod.id,
          p_series: historyEntry.voucher_series,
        },
      )
      if (historyVoucherError) throw historyVoucherError
      historyVoucherNumbers.push(historyVoucherNumber as number)
    }

    // Inserted as draft and posted after the lines land: PostgREST autocommits
    // each request, and check_balance_on_posted_insert (migration
    // 20260806130000) rejects a posted header whose transaction carries no
    // lines. The draft-to-posted UPDATE below fires check_balance_on_post
    // against the finished verifikat instead.
    //
    // committed_at note: this route runs under the requester's authenticated
    // client, and set_committed_at() (migration 20260806160000) preserves a
    // preset committed_at only for trusted roles, so any backdated
    // committed_at supplied here is overwritten with now() at posting. That
    // is deliberate: an end-user role must never control the audit timestamp,
    // and sandbox companies are disposable.
    const { data: insertedHistoryEntries, error: historyEntryError } = await supabase
      .from('journal_entries')
      .insert(
        ledgerHistory.entries.map((historyEntry, index) => ({
          ...historyEntry,
          voucher_number: historyVoucherNumbers[index],
          status: 'draft',
        })),
      )
      .select('id, voucher_number')
    if (historyEntryError) throw historyEntryError

    // Match on voucher_number, not on array position: PostgREST does not
    // promise the returned rows come back in insertion order, and
    // (company_id, fiscal_period_id, voucher_series, voucher_number) is unique.
    const historyIdByVoucher = new Map(
      (insertedHistoryEntries ?? []).map(row => [row.voucher_number as number, row.id as string]),
    )

    const historyEntryIds = historyVoucherNumbers.map(voucherNumber => {
      const entryId = historyIdByVoucher.get(voucherNumber)
      if (!entryId) {
        throw new Error(`Sandbox seed: ledger history voucher ${voucherNumber} was not inserted`)
      }
      return entryId
    })

    const { error: historyLinesError } = await supabase
      .from('journal_entry_lines')
      .insert(
        ledgerHistory.linesByEntryIndex.flatMap((lines, index) =>
          lines.map(line => ({ ...line, journal_entry_id: historyEntryIds[index] })),
        ),
      )
    if (historyLinesError) throw historyLinesError

    const { error: historyPostError } = await supabase
      .from('journal_entries')
      .update({ status: 'posted' })
      .in('id', historyEntryIds)
      .eq('company_id', companyId)
    if (historyPostError) throw historyPostError

    // The history is the company's books from before it arrived in Accounted:
    // its kvitton live in the previous system's binder, not here. Left
    // unflagged, every one of these vouchers would land on Hem as "Verifikat
    // utan underlag" and the demo's first screen would read as a compliance
    // mess. Marking them exempt is the same move the SIE-import opt-in makes
    // for exactly the same reason, through the same sanctioned sidecar table
    // (journal_entry_no_doc_required), so the verifikat themselves stay
    // immutable per BFL.
    await markEntriesNoDocRequired(
      supabase,
      companyId,
      userId,
      historyEntryIds,
      'Historisk bokföring: underlag arkiverade i det tidigare systemet.',
    )

    // 10. Invoice vouchers (inserted directly, not via engine, to avoid event emission)
    const { data: voucherNum1 } = await supabase.rpc('next_voucher_number', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriod.id,
      p_series: 'A',
    })

    const { data: je1, error: je1Error } = await supabase
      .from('journal_entries')
      .insert({
        user_id: userId,
        company_id: companyId,
        fiscal_period_id: fiscalPeriod.id,
        voucher_number: voucherNum1 ?? 1,
        voucher_series: 'A',
        entry_date: toDateStr(thirtyDaysAgo),
        description: 'Faktura F-2026001, Björk & Partner AB',
        source_type: 'invoice_created',
        source_id: invoiceMap['F-2026001'],
        // Draft until the lines exist; see the ledger-history comment above.
        status: 'draft',
        committed_at: toDateStr(thirtyDaysAgo),
      })
      .select('id')
      .single()

    if (je1Error) throw je1Error

    const { data: voucherNum2 } = await supabase.rpc('next_voucher_number', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriod.id,
      p_series: 'A',
    })

    const { data: je2, error: je2Error } = await supabase
      .from('journal_entries')
      .insert({
        user_id: userId,
        company_id: companyId,
        fiscal_period_id: fiscalPeriod.id,
        voucher_number: voucherNum2 ?? 2,
        voucher_series: 'A',
        entry_date: toDateStr(fifteenDaysAgo),
        description: 'Betalning faktura F-2026001, Björk & Partner AB',
        source_type: 'invoice_paid',
        source_id: invoiceMap['F-2026001'],
        // Draft until the lines exist; see the ledger-history comment above.
        status: 'draft',
        committed_at: toDateStr(fifteenDaysAgo),
      })
      .select('id')
      .single()

    if (je2Error) throw je2Error

    // 10. Create journal entry lines. The P&L line carries demo dimensions
    // ({"1":"BUTIK","6":"P001"}) so the register's "antal taggade rader",
    // voucher-detail badges, and the dimension P&L report light up in the
    // sandbox. cost_center/project are GENERATED from the bag since the PR9
    // cutover: writing them explicitly would error.
    const revenueDims = { '1': 'BUTIK', '6': 'P001' }
    const { error: jelError } = await supabase
      .from('journal_entry_lines')
      .insert([
        // JE1: Invoice creation, Debit AR, Credit Revenue + VAT
        // NB: `dimensions` must be set explicitly on EVERY row: same PostgREST
        // bulk-insert normalization as paid_amount below: omitting it on some
        // rows while one row sets it sends null (violating NOT NULL) instead
        // of falling through to the schema default '{}'.
        {
          journal_entry_id: je1.id,
          account_number: '1510',
          account_id: accountMap['1510'] ?? null,
          debit_amount: 18750,
          credit_amount: 0,
          sort_order: 0,
          dimensions: {},
        },
        {
          journal_entry_id: je1.id,
          account_number: '3001',
          account_id: accountMap['3001'] ?? null,
          debit_amount: 0,
          credit_amount: 15000,
          sort_order: 1,
          dimensions: revenueDims,
        },
        {
          journal_entry_id: je1.id,
          account_number: '2611',
          account_id: accountMap['2611'] ?? null,
          debit_amount: 0,
          credit_amount: 3750,
          sort_order: 2,
          dimensions: {},
        },
        // JE2: Invoice payment, Debit Bank, Credit AR
        {
          journal_entry_id: je2.id,
          account_number: '1930',
          account_id: accountMap['1930'] ?? null,
          debit_amount: 18750,
          credit_amount: 0,
          sort_order: 0,
          dimensions: {},
        },
        {
          journal_entry_id: je2.id,
          account_number: '1510',
          account_id: accountMap['1510'] ?? null,
          debit_amount: 0,
          credit_amount: 18750,
          sort_order: 1,
          dimensions: {},
        },
      ])

    if (jelError) throw jelError

    const { error: invoicePostError } = await supabase
      .from('journal_entries')
      .update({ status: 'posted' })
      .in('id', [je1.id, je2.id])
      .eq('company_id', companyId)
    if (invoicePostError) throw invoicePostError

    // 11. Create transactions
    const { data: txRows, error: txError } = await supabase
      .from('transactions')
      .insert([
        // Categorized expenses
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(thirtyDaysAgo),
          description: 'CLAS OHLSON STOCKHOLM',
          amount: -450,
          category: 'expense_office',
          is_business: true,
          merchant_name: 'Clas Ohlson',
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fifteenDaysAgo),
          description: 'GITHUB INC',
          amount: -999,
          category: 'expense_software',
          is_business: true,
          merchant_name: 'GitHub',
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'SJ BILJETT',
          // > 4 000 kr categorized business expense with no attached underlag,
          // so gnubok_vat_close_check surfaces a non-empty blocker list.
          // (BFL 5 kap 6-7§ require every affärshändelse to be documented with
          // underlag; the 4 000 kr cut-off is the tool's own high-value
          // heuristic, not a statutory threshold.)
          amount: -4500,
          category: 'expense_travel',
          is_business: true,
          merchant_name: 'SJ',
        },
        // Income matched to paid invoice
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fifteenDaysAgo),
          description: 'BJÖRK & PARTNER AB BETALNING F-2026001',
          amount: 18750,
          category: 'income_services',
          is_business: true,
          invoice_id: invoiceMap['F-2026001'],
          journal_entry_id: je2.id,
          merchant_name: 'Björk & Partner AB',
        },
        // Private transaction
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'PRIVAT INSÄTTNING',
          amount: 5000,
          category: 'private',
          is_business: false,
        },
        // Uncategorized transactions
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(fiveDaysAgo),
          description: 'SWISH BETALNING 0701234567',
          amount: -350,
          category: 'uncategorized',
          is_business: null,
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(today),
          description: 'INSÄTTNING BANKGIRO',
          amount: 1200,
          category: 'uncategorized',
          is_business: null,
        },
        {
          user_id: userId,
          company_id: companyId,
          date: toDateStr(today),
          description: 'KORTBETALNING RESTAURANG',
          amount: -680,
          category: 'uncategorized',
          is_business: null,
        },
      ])
      .select('id, description')

    if (txError) throw txError

    // Lookup so the pre-staged categorize_transaction operation below can
    // reference a real, uncategorized transaction by id (descriptions are
    // unique in this seed set).
    const txMap = Object.fromEntries(
      (txRows ?? []).map(t => [t.description as string, t.id as string])
    )

    // 12. Create deadlines
    const momsDeadline = buildSandboxVatDeadline(today)

    const { error: dlError } = await supabase
      .from('deadlines')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          title: momsDeadline.title,
          due_date: momsDeadline.dueDate,
          deadline_type: 'tax',
          priority: 'important',
          // Current generator types: the bare 'moms'/'inkomstdeklaration'
          // types were retired and seeding them recreates legacy rows the
          // cleanup migration removed.
          tax_deadline_type: 'moms_quarterly',
          tax_period: momsDeadline.period,
          source: 'system',
          status: 'upcoming',
          linked_report_type: 'vat',
        },
        {
          user_id: userId,
          company_id: companyId,
          title: `Inkomstdeklaration ${currentYear - 1}`,
          due_date: `${currentYear}-05-02`,
          deadline_type: 'tax',
          priority: 'critical',
          // Sandbox companies are enskild firma (see p_entity_type above).
          tax_deadline_type: 'inkomstdeklaration_ef',
          tax_period: `${currentYear - 1}`,
          source: 'system',
          status: 'upcoming',
        },
      ])

    if (dlError) throw dlError

    // 13. Seed suppliers + one registered supplier invoice + one paid one.
    // Supplier invoices are arguably the second-most-used surface after
    // bank transactions; without them the /suppliers and /supplier-invoices
    // pages render the empty state and the demo loses a big chunk of the
    // accounts-payable story.
    // Supplier names use the "Demo" prefix and the documentation-reserved
    // 5559... org-number range so the seeded rows cannot be confused with
    // production data should they ever leak into a real environment.
    const { data: suppliers, error: supError } = await supabase
      .from('suppliers')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          name: 'Demo Telekom AB',
          supplier_type: 'swedish_business',
          org_number: '5559000001',
          vat_number: 'SE555900000101',
          email: 'demo+telekom@example.com',
          // Luhn-valid (Bankgirot check digit): the betalfil flow validates
          // payee numbers, so demo suppliers must carry numbers that pass.
          bankgiro: '5559-0004',
          address_line1: 'Demovägen 10',
          postal_code: '111 22',
          city: 'Stockholm',
          country: 'SE',
          default_payment_terms: 30,
        },
        {
          user_id: userId,
          company_id: companyId,
          name: 'Demokafé AB',
          supplier_type: 'swedish_business',
          org_number: '5559000002',
          vat_number: 'SE555900000201',
          bankgiro: '5559-0012',
          address_line1: 'Demovägen 11',
          postal_code: '111 22',
          city: 'Stockholm',
          country: 'SE',
          default_payment_terms: 15,
        },
      ])
      .select('id, name')

    if (supError) throw supError
    const supplierMap = Object.fromEntries(suppliers.map(s => [s.name, s.id]))

    // Supplier invoice #1, Telia, paid 15 days ago (mobile + bredband, 25% VAT).
    const sevenDaysFromNow = new Date(today)
    sevenDaysFromNow.setDate(today.getDate() + 7)

    // Hardcode 1 and 2: get_next_arrival_number is MAX+1 against the same
    // table we're about to insert into, so calling it twice before the first
    // insert lands gives the same value for both rows and violates the
    // (company_id, arrival_number) unique index. The company is brand new
    // here, so 1 and 2 are guaranteed to be free.
    const { data: supInvoices, error: supInvError } = await supabase
      .from('supplier_invoices')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          supplier_id: supplierMap['Demo Telekom AB'],
          arrival_number: 1,
          supplier_invoice_number: '4711-2026-03',
          invoice_date: toDateStr(thirtyDaysAgo),
          due_date: toDateStr(today),
          received_date: toDateStr(thirtyDaysAgo),
          status: 'paid',
          currency: 'SEK',
          subtotal: 480,
          vat_amount: 120,
          total: 600,
          payment_reference: '47112026031',
          paid_at: toDateStr(fifteenDaysAgo),
          paid_amount: 600,
          // Same normalization rule as paid_amount below: the other row in
          // this bulk insert sets remaining_amount, so this one must too.
          remaining_amount: 0,
        },
        {
          user_id: userId,
          company_id: companyId,
          supplier_id: supplierMap['Demokafé AB'],
          arrival_number: 2,
          supplier_invoice_number: '88245',
          invoice_date: toDateStr(fiveDaysAgo),
          due_date: toDateStr(sevenDaysFromNow),
          received_date: toDateStr(fiveDaysAgo),
          status: 'registered',
          currency: 'SEK',
          subtotal: 240,
          vat_amount: 28.80,
          total: 268.80,
          // Luhn-valid OCR so the betalfil preview demos the structured
          // reference path instead of the invoice-number fallback.
          payment_reference: '882456',
          // Must be set explicitly: PostgREST normalizes columns across
          // rows in a bulk insert, so omitting paid_amount here while the
          // first row sets it sends null instead of falling through to the
          // schema default (0), violating the NOT NULL constraint.
          paid_amount: 0,
          // No trigger derives this; without it the unpaid demo invoice
          // shows "0 kr kvar att betala" and cannot join a betalfil.
          remaining_amount: 268.80,
        },
      ])
      .select('id, supplier_invoice_number')

    if (supInvError) throw supInvError
    const supInvoiceMap = Object.fromEntries(
      supInvoices.map(s => [s.supplier_invoice_number, s.id])
    )

    // Supplier invoice line items. Note: supplier_invoice_items.vat_rate is
    // stored as a decimal (0.25 = 25%); invoice_items.vat_rate above uses
    // integer percent (25). Two different conventions inherited from earlier
    // migrations: don't try to "fix" it here.
    const { error: supItemsError } = await supabase
      .from('supplier_invoice_items')
      .insert([
        {
          supplier_invoice_id: supInvoiceMap['4711-2026-03'],
          description: 'Mobil + bredband, mars',
          quantity: 1,
          unit_price: 480,
          line_total: 480,
          vat_rate: 0.25,
          vat_amount: 120,
          account_number: '6212',
        },
        {
          supplier_invoice_id: supInvoiceMap['88245'],
          description: 'Kundmöte Demokafé (representation)',
          quantity: 1,
          unit_price: 240,
          line_total: 240,
          vat_rate: 0.12,
          vat_amount: 28.80,
          account_number: '5810',
        },
      ])

    if (supItemsError) throw supItemsError

    // 14. Add one fully-depreciable asset (laptop) so /assets shows
    // something other than a Package empty state. Acquired 18 months ago,
    // 60-month linear depreciation. Cost set above the 2026
    // förbrukningsinventarier threshold (half prisbasbelopp ≈ 29 600 SEK)
    // so the demo unambiguously illustrates capitalization rather than
    // direct expensing.
    const eighteenMonthsAgo = new Date(today)
    eighteenMonthsAgo.setMonth(today.getMonth() - 18)
    const { error: assetError } = await supabase
      .from('assets')
      .insert({
        user_id: userId,
        company_id: companyId,
        name: 'Demo-laptop',
        category: 'computer',
        acquisition_date: toDateStr(eighteenMonthsAgo),
        acquisition_cost: 35000,
        salvage_value: 0,
        useful_life_months: 60,
        depreciation_method: 'linear',
        bas_asset_account: '1250',
        bas_accumulated_account: '1259',
        bas_expense_account: '7831',
        notes: 'Demo-tillgång: visar planenlig avskrivning över 5 år.',
      })

    if (assetError) throw assetError

    // 15. Pre-built, verified agent_profile so the assistant chrome (FAB,
    // /chat surface, agent identity in nav) renders without firing a
    // composer run. The chat itself is server-gated by guardSandbox().
    // Delegated to ensureSandboxAgentProfile so the persona lives in one
    // place (this seed, the dashboard/chat layout backfill, and the seed
    // top-up path all use the same helper).
    await ensureSandboxAgentProfile(supabase, companyId)

    // 16. Inbox item backing the pre-staged supplier-invoice approval below.
    // commitCreateSupplierInvoiceFromInbox does an idempotency + FK lookup
    // against invoice_inbox_items by inbox_item_id before it creates anything,
    // so the "Godkänn" path can only succeed if a real inbox row exists.
    // status is constrained to 'received' | 'processing' | 'error' (migration
    // 20260813213000); seeded rows are always 'received'.
    const { data: inboxRow, error: inboxError } = await supabase
      .from('invoice_inbox_items')
      .insert({
        user_id: userId,
        company_id: companyId,
        status: 'received',
        source: 'upload',
        matched_supplier_id: supplierMap['Demokafé AB'],
        extracted_data: {
          supplier: { name: 'Demokafé AB' },
          invoice: {
            invoiceNumber: 'INKOMMANDE-2026-001',
            invoiceDate: toDateStr(fiveDaysAgo),
            dueDate: toDateStr(sevenDaysFromNow),
            currency: 'SEK',
            vatTreatment: 'reduced_12',
          },
          totals: { subtotal: 240, vat: 28.80, total: 268.80 },
          lineItems: [
            {
              description: 'Kundmöte Demokafé (representation)',
              quantity: 1,
              unit: 'st',
              unit_price: 240,
              line_total: 240,
              account_number: '5810',
              vat_rate: 12,
              vat_amount: 28.80,
            },
          ],
        },
      })
      .select('id')
      .single()

    if (inboxError) throw inboxError

    // 17. Pre-staged pending_operations so /pending isn't empty. Both the
    // executor-complete params and the per-type preview_data shapes live in
    // ./pending-operations, where they are unit-testable.
    const { error: pendOpsError } = await supabase
      .from('pending_operations')
      .insert(
        buildSandboxPendingOperations({
          userId,
          companyId,
          inboxItemId: inboxRow.id,
          supplierId: supplierMap['Demokafé AB'],
          invoiceDate: toDateStr(fiveDaysAgo),
          dueDate: toDateStr(sevenDaysFromNow),
          transactionId: txMap['INSÄTTNING BANKGIRO'],
        }),
      )

    if (pendOpsError) throw pendOpsError

    // 18. Artikelregister, so /articles shows reusable invoice-line presets
    // instead of the Package empty state.
    const { error: articlesError } = await supabase
      .from('articles')
      .insert(buildSandboxArticles({ userId, companyId }))

    if (articlesError) throw articlesError

    // 20. Payroll. An enskild firma may employ staff (it just may not put its
    // own owner on payroll), so the demo runs two employees through one booked
    // and one open lönekörning.
    const { data: employeeRows, error: employeesError } = await supabase
      .from('employees')
      .insert(
        buildSandboxEmployees({
          userId,
          companyId,
          today,
          // employees.personnummer stores AES-256-GCM ciphertext; the builder
          // stays pure by taking the cipher as an argument.
          encrypt: encryptPersonnummer,
        }),
      )
      .select('id, last_name')

    if (employeesError) throw employeesError
    const { annaEmployeeId, erikEmployeeId } = mapSandboxEmployeeIds(employeeRows)

    const { data: salaryRunRows, error: salaryRunsError } = await supabase
      .from('salary_runs')
      .insert(buildSandboxSalaryRuns({ userId, companyId, today }))
      .select('id, status')

    if (salaryRunsError) throw salaryRunsError

    const bookedRun = salaryRunRows.find(r => r.status === 'booked')
    const draftRun = salaryRunRows.find(r => r.status === 'draft')
    if (!bookedRun || !draftRun) {
      throw new Error('Sandbox seed: expected one booked and one draft salary run')
    }

    const { data: runEmployeeRows, error: runEmployeesError } = await supabase
      .from('salary_run_employees')
      .insert(
        buildSandboxSalaryRunEmployees({
          companyId,
          today,
          bookedRunId: bookedRun.id,
          draftRunId: draftRun.id,
          annaEmployeeId,
          erikEmployeeId,
        }),
      )
      .select('id, employee_id')

    if (runEmployeesError) throw runEmployeesError

    const { error: salaryLineItemsError } = await supabase
      .from('salary_line_items')
      .insert(
        buildSandboxSalaryLineItems({
          companyId,
          annaEmployeeId,
          erikEmployeeId,
          runEmployees: runEmployeeRows,
        }),
      )

    if (salaryLineItemsError) throw salaryLineItemsError

    // 21. Verifikat for the BOOKED run. A run in status 'booked' that posted
    // nothing would be a lie: the real path (bookPaidSalaryRun) always writes
    // these through the engine before advancing the status. The seed inserts
    // journal rows directly to avoid event emission, so ./salary-vouchers
    // mirrors the engine's account structure instead.
    const bookedPeriod = resolveSandboxSalaryPeriods(today).booked
    const salaryVouchers = buildSandboxSalaryVouchers({
      userId,
      companyId,
      fiscalPeriodId: fiscalPeriod.id,
      salaryRunId: bookedRun.id,
      paymentDate: bookedPeriod.paymentDate,
      periodYear: bookedPeriod.year,
      periodMonth: bookedPeriod.month,
      totalGross: SANDBOX_RUN_TOTALS.total_gross,
      totalTax: SANDBOX_RUN_TOTALS.total_tax,
      totalNet: SANDBOX_RUN_TOTALS.total_net,
      totalAvgifter: SANDBOX_RUN_TOTALS.total_avgifter,
      totalVacationAccrual: SANDBOX_RUN_TOTALS.total_vacation_accrual,
      // salary_runs has no column for avgifter on the vacation accrual (it is
      // a per-employee figure), so ./salary exports the sum of the same
      // figures the salary_run_employees rows were written from.
      totalVacationAvgifter: SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER,
    })

    const runEntryLinks: Record<string, string> = {}
    for (const voucher of salaryVouchers) {
      const { data: salaryVoucherNumber, error: salaryVoucherError } = await supabase.rpc(
        'next_voucher_number',
        {
          p_company_id: companyId,
          p_fiscal_period_id: fiscalPeriod.id,
          p_series: voucher.entry.voucher_series,
        },
      )
      // A posted verifikat with no voucher number is a hole in the
      // verifikationsserie (BFNAR 2013:2), so a failed counter read has to stop
      // the seed rather than insert one.
      if (salaryVoucherError) throw salaryVoucherError
      if (salaryVoucherNumber == null) {
        throw new Error('Sandbox seed: next_voucher_number returned no number for a salary voucher')
      }

      const { data: insertedSalaryEntry, error: salaryEntryError } = await supabase
        .from('journal_entries')
        // Draft until the lines exist; see the ledger-history comment above.
        .insert({ ...voucher.entry, voucher_number: salaryVoucherNumber, status: 'draft' })
        .select('id')
        .single()
      if (salaryEntryError) throw salaryEntryError

      const { error: salaryEntryLinesError } = await supabase
        .from('journal_entry_lines')
        .insert(
          voucher.lines.map(line => ({
            ...line,
            account_id: accountMap[line.account_number] ?? null,
            journal_entry_id: insertedSalaryEntry.id,
          })),
        )
      if (salaryEntryLinesError) throw salaryEntryLinesError

      runEntryLinks[voucher.runColumn] = insertedSalaryEntry.id
    }

    const { error: salaryPostError } = await supabase
      .from('journal_entries')
      .update({ status: 'posted' })
      .in('id', Object.values(runEntryLinks))
      .eq('company_id', companyId)
    if (salaryPostError) throw salaryPostError

    const { error: linkRunError } = await supabase
      .from('salary_runs')
      .update(runEntryLinks)
      .eq('id', bookedRun.id)
      .eq('company_id', companyId)

    if (linkRunError) throw linkRunError

    return NextResponse.json({ seeded: true })
  } catch (err) {
    log.error('failed to seed sandbox data', { error: err, userId: user.id, companyId })
    return NextResponse.json(
      { error: 'Failed to seed sandbox data', requestId },
      { status: 500 }
    )
  }
}

/**
 * Idempotent top-up for sandboxes that pre-date the agent_profile addition
 * to the seed. Re-running the seed on those older sandboxes short-circuits
 * at the company_settings idempotency check above, so they never get the
 * agent_profile without this hook. Delegates to ensureSandboxAgentProfile
 * so the profile data stays in exactly one place.
 *
 * Deliberately NOT extended to the payroll and ledger-history additions: those
 * are one correlated dataset (a chart of accounts, a year of vouchers, a
 * roster, two runs and their verifikat) that cannot be half-applied coherently,
 * and a partial top-up would produce a booked lönekörning whose verifikat
 * numbering interleaves with vouchers that already exist. Sandboxes are deleted
 * after 24 hours, so the window where this matters closes on its own; a visitor
 * who wants the payroll demo starts a new sandbox.
 */
async function topUpSandboxAdditions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  await ensureSandboxAgentProfile(supabase, companyId)
}
