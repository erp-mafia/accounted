import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { truncateIp } from '@/lib/api/v1/with-api-v1'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'

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
        invoice_default_days: 30,
        onboarding_step: 6,
        onboarding_complete: true,
        is_sandbox: true,
        // Dimensions demo: the register/pickers render out of the box.
        dimensions_enabled: true,
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
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          name: 'Björk & Partner AB',
          customer_type: 'swedish_business',
          email: 'faktura@bjorkpartner.se',
          org_number: '5566778899',
          vat_number: 'SE556677889901',
          vat_number_validated: true,
          address_line1: 'Storgatan 10',
          postal_code: '111 44',
          city: 'Stockholm',
          country: 'SE',
          default_payment_terms: 30,
        },
        {
          user_id: userId,
          company_id: companyId,
          name: 'Schmidt GmbH',
          customer_type: 'eu_business',
          email: 'billing@schmidt.de',
          org_number: 'HRB 12345',
          vat_number: 'DE123456789',
          vat_number_validated: true,
          address_line1: 'Hauptstraße 5',
          postal_code: '10115',
          city: 'Berlin',
          country: 'DE',
          default_payment_terms: 30,
        },
        {
          user_id: userId,
          company_id: companyId,
          name: 'Anna Lindström',
          customer_type: 'individual',
          email: 'anna.lindstrom@example.com',
          address_line1: 'Lillgatan 3',
          postal_code: '222 33',
          city: 'Malmö',
          country: 'SE',
          default_payment_terms: 30,
        },
      ])
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

    // 8. Resolve account IDs for journal entries
    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('id, account_number')
      .eq('company_id', companyId)
      .in('account_number', ['1510', '1930', '2611', '3001'])

    const accountMap = Object.fromEntries(
      (accounts ?? []).map(a => [a.account_number, a.id])
    )

    // 9. Create journal entries (inserted directly, not via engine, to avoid event emission)
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
        status: 'posted',
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
        status: 'posted',
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
    const momsDeadline = new Date(today)
    momsDeadline.setMonth(momsDeadline.getMonth() + 2)
    momsDeadline.setDate(12)

    const { error: dlError } = await supabase
      .from('deadlines')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          title: 'Momsdeklaration Q1 2026',
          due_date: toDateStr(momsDeadline),
          deadline_type: 'tax',
          priority: 'important',
          tax_deadline_type: 'moms',
          tax_period: `${currentYear}-Q1`,
          source: 'system',
          status: 'upcoming',
          linked_report_type: 'vat',
        },
        {
          user_id: userId,
          company_id: companyId,
          title: 'Inkomstdeklaration 2025',
          due_date: `${currentYear}-05-02`,
          deadline_type: 'tax',
          priority: 'critical',
          tax_deadline_type: 'inkomstdeklaration',
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
          bankgiro: '5559-0001',
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
          bankgiro: '5559-0002',
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
          // Must be set explicitly: PostgREST normalizes columns across
          // rows in a bulk insert, so omitting paid_amount here while the
          // first row sets it sends null instead of falling through to the
          // schema default (0), violating the NOT NULL constraint.
          paid_amount: 0,
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
    // status is constrained to 'received' | 'error' (migration 20260504180000).
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

    // 17. Pre-staged pending_operations so /pending isn't empty.
    // These are the kind of operation the AI agent would stage; pre-seeded
    // here so the user can see the approval queue UI (preview, period
    // status, risk level) without having to invoke the disabled AI. Each
    // params blob must be executor-complete: the commit executors in
    // lib/pending-operations/commit.ts validate required fields on "Godkänn",
    // so a display-only preview with a hollow params object fails to save.
    // actor_type='agent_chat' + risk_level on the row itself is required by
    // pending_operations_chat_insert (the only RLS policy that lets a
    // user-scoped client INSERT into this table).
    const { error: pendOpsError } = await supabase
      .from('pending_operations')
      .insert([
        {
          user_id: userId,
          company_id: companyId,
          operation_type: 'create_supplier_invoice_from_inbox',
          status: 'pending',
          actor_type: 'agent_chat',
          risk_level: 'low',
          // Uses a distinct supplier_invoice_number so approving this
          // pending operation creates a NEW supplier_invoices row instead
          // of colliding with the Demokafé '88245' already booked above
          // (BFL 5 kap: each affärshändelse must be recorded exactly once).
          title: 'Registrera leverantörsfaktura, Demokafé (representation, nytt underlag)',
          // Mirrors what gnubok_create_supplier_invoice_from_inbox would stage:
          // every field commitCreateSupplierInvoiceFromInbox requires
          // (inbox_item_id, supplier_id, supplier_invoice_number, invoice_date,
          // finite subtotal/vat_amount/total, and a non-empty items array).
          params: {
            inbox_item_id: inboxRow.id,
            supplier_id: supplierMap['Demokafé AB'],
            document_id: null,
            supplier_invoice_number: 'INKOMMANDE-2026-001',
            invoice_date: toDateStr(fiveDaysAgo),
            due_date: toDateStr(sevenDaysFromNow),
            currency: 'SEK',
            exchange_rate: null,
            vat_treatment: 'reduced_12',
            subtotal: 240,
            vat_amount: 28.80,
            total: 268.80,
            notes: 'Representation, kundmöte (demo)',
            items: [
              {
                line_number: 1,
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
          preview_data: {
            // Representation @ 12% VAT (café meal), 240 SEK excl. VAT for
            // a single attendee. The avdragsrätt cap is 25% × 300 SEK ×
            // antal_personer = 75 SEK / person (ML 8 kap. 9 §); since the
            // VAT here is 28.80 SEK the full amount is deductible and the
            // cost lands in 5810: no split needed.
            preview_lines: [
              { account: '5810', description: 'Representation (12% moms, ≤ 75 SEK moms/pers)', debit: 240, credit: 0 },
              { account: '2641', description: 'Ingående moms', debit: 28.80, credit: 0 },
              { account: '2440', description: 'Leverantörsskulder', debit: 0, credit: 268.80 },
            ],
          },
        },
        {
          user_id: userId,
          company_id: companyId,
          operation_type: 'categorize_transaction',
          status: 'pending',
          actor_type: 'agent_chat',
          risk_level: 'low',
          title: 'Bokför insättning, bankgiro',
          // commitCategorizeTransaction needs a real uncategorized
          // transaction_id + a category that resolves to an account mapping.
          // income_services → 3001 (Försäljning tjänster 25%), matching the
          // preview's 1930 / 2611 / 3001 split for the 1 200 kr deposit.
          params: {
            transaction_id: txMap['INSÄTTNING BANKGIRO'],
            category: 'income_services',
            vat_treatment: 'standard_25',
          },
          preview_data: {
            preview_lines: [
              { account: '1930', description: 'Företagskonto', debit: 1200, credit: 0 },
              { account: '2611', description: 'Utgående moms 25%', debit: 0, credit: 240 },
              { account: '3001', description: 'Försäljning 25% moms', debit: 0, credit: 960 },
            ],
          },
        },
      ])

    if (pendOpsError) throw pendOpsError

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
 */
async function topUpSandboxAdditions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  await ensureSandboxAgentProfile(supabase, companyId)
}
