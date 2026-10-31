/**
 * Plays the simulated company's events into a real database through the doors a
 * customer's agent uses (./doors.ts). Where the answer key holds an amount the
 * event needs (a tax payment, the year's bolagsskatt) the build pays the key's
 * figure, as a company pays what it worked out, so a report that disagrees shows
 * up as a balance that does not clear.
 *
 * The one door that is not an MCP tool is registering a supplier invoice: that
 * is createSupplierInvoice, the function behind the dashboard and v1 routes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createCompanyCore } from '@/lib/company/create-company'
import { CompanySetupSchema, planCompanySetup } from '@/lib/company/onboarding-input'
import { createLogger } from '@/lib/logger'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'
import { monthKey, vatKey, type AnswerKey } from './answer-key'
import { installSimClock, setSimDay } from './clock'
import { SimDoors } from './doors'
import { SIM_COMPANY, type SimEvent, type SimPlan } from './generate'

/** What the tests need to find the company again. */
export interface SimState {
  seed: number
  scale: SimPlan['scale']
  companyId: string
  userId: string
  /** Fiscal period id by year. */
  fiscalPeriods: Record<number, string>
  /** Salary run id, keyed '2024-01'. */
  salaryRuns: Record<string, string>
  /** Events played. */
  events: number
  /** The day the build was told to stop on, null for the whole company. */
  until: string | null
  seconds: number
}

/**
 * Payroll figures ship as migrations from 2026, the first year customers run
 * payroll here. The company's 2024 and 2025 need their own rows: the year's
 * prisbasbelopp and inkomstbasbelopp on 2026's otherwise unchanged statutory rates.
 */
const EARLIER_PAYROLL_YEARS = [
  { config_year: 2024, prisbasbelopp: 57_300, inkomstbasbelopp: 76_200 },
  { config_year: 2025, prisbasbelopp: 58_800, inkomstbasbelopp: 80_600 },
]

/** What the board writes and answers in the årsredovisning; the figures come from the books. */
const ANNUAL_REPORT_TEXTS = {
  description: 'Bolaget bedriver konsultverksamhet inom IT och verksamhetsutveckling från Stockholm.',
  important_events: 'Inga väsentliga händelser har inträffat under räkenskapsåret.',
  resultatdisposition: 'Styrelsen föreslår att fritt eget kapital balanseras i ny räkning.',
  long_term_debt_over_five_years_confirmed: true,
  securities_pledged_confirmed: true,
  contingent_liabilities_confirmed: true,
  parent_company_confirmed: true,
}
const ANNUAL_REPORT_ANSWERS = {
  is_public_limited_company: false,
  is_in_liquidation: false,
  securities_traded_on_regulated_market: false,
  is_parent_company: false,
  narrative_confirmed: true,
  k2_assessment_confirmed: true,
}

async function ensurePayrollYears(supabase: SupabaseClient): Promise<void> {
  const { data: current, error } = await supabase.from('salary_payroll_config').select('*').eq('config_year', 2026).single()
  if (error) throw new Error(`no 2026 payroll figures: ${error.message}`)
  const { id: _id, created_at: _created, updated_at: _updated, ...figures } = current as Record<string, unknown>
  const { error: upsertError } = await supabase
    .from('salary_payroll_config')
    .upsert(EARLIER_PAYROLL_YEARS.map((year) => ({ ...figures, ...year })), { onConflict: 'config_year' })
  if (upsertError) throw new Error(`could not add earlier payroll years: ${upsertError.message}`)
}

async function createCompany(supabase: SupabaseClient, userId: string): Promise<string> {
  const setup = CompanySetupSchema.parse({
    name: SIM_COMPANY.name,
    entity_type: 'aktiebolag',
    org_number: SIM_COMPANY.orgNumber,
    vat_registered: true,
    moms_period: 'quarterly',
    accounting_method: 'accrual',
    f_skatt: true,
    first_fiscal_year: { start: '2024-01-01', end: '2024-12-31' },
    address_line1: SIM_COMPANY.address.line1,
    postal_code: SIM_COMPANY.address.postalCode,
    city: SIM_COMPANY.address.city,
  })
  const plan = planCompanySetup(setup)
  if (!plan.ok) throw new Error(`company setup refused: ${plan.error}`)
  const created = await createCompanyCore(supabase, plan.input, () =>
    supabase.rpc('create_company_for_user', {
      p_user_id: userId,
      p_name: setup.name,
      p_entity_type: setup.entity_type,
      p_team_id: null,
    }),
  )
  if (created.error !== undefined) throw new Error(`creating the company failed: ${created.error}`)
  return created.companyId
}

/**
 * Two genuine payments can look alike, and the duplicate guards then ask a
 * person. The event is the person's answer here: it happened, so it is confirmed.
 */
async function confirmingDuplicate<T>(attempt: () => Promise<T>, confirmed: (refusal: string) => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof Error) || !/double booking|dubbelbok|dubblettbok|dubbelbetalning/i.test(error.message)) throw error
    return confirmed(error.message)
  }
}

export interface BuildOptions {
  supabase: SupabaseClient
  userId: string
  /** Stop after this date, to look at a company partway through its life. */
  until?: string
  onProgress?: (line: string) => void
}

export async function buildSimCompany(plan: SimPlan, key: AnswerKey, options: BuildOptions): Promise<SimState> {
  const { supabase, userId, until, onProgress } = options
  const started = performance.now()
  installSimClock()
  setSimDay(SIM_COMPANY.firstDay)
  await ensurePayrollYears(supabase)
  const companyId = await createCompany(supabase, userId)
  const doors = new SimDoors(supabase, companyId, userId)
  const log = createLogger('sim')

  await doors.write('gnubok_update_company_settings', {
    bankgiro: SIM_COMPANY.bankgiro,
    registered_office: SIM_COMPANY.address.city,
    contact_person: SIM_COMPANY.contact.name,
    email: SIM_COMPANY.contact.email,
    phone: SIM_COMPANY.contact.phone,
  })

  const customers = new Map<string, string>()
  for (const customer of plan.customers) {
    const created = await doors.write('gnubok_create_customer', {
      name: customer.name,
      customer_type: customer.type,
      country: customer.country,
      vat_number: customer.vatNumber,
      email: `${customer.key}@kund.example`,
      address: 'Simuleringsvägen 2',
      postal_code: '11122',
      city: 'Simuleringsstad',
    })
    customers.set(customer.key, created.customer_id)
  }
  const suppliers = new Map<string, string>()
  for (const supplier of plan.suppliers) {
    const created = await doors.write('gnubok_create_supplier', {
      name: supplier.name,
      supplier_type: supplier.type,
      country: supplier.country,
      vat_number: supplier.vatNumber,
    })
    suppliers.set(supplier.key, created.supplier_id)
  }
  const employees = new Map<string, string>()
  for (const employee of plan.employees) {
    const created = await doors.write('gnubok_create_employee', {
      first_name: employee.firstName,
      last_name: employee.lastName,
      personnummer: employee.personnummer,
      employment_type: employee.owner ? 'company_owner' : 'employee',
      employment_start: employee.start,
      salary_type: 'monthly',
      monthly_salary: employee.salary[Number(employee.start.slice(0, 4))],
      tax_table_number: employee.taxTable,
      tax_column: 1,
      tax_municipality: employee.taxTable === 30 ? 'Stockholm' : 'Uppsala',
      f_skatt_status: 'a_skatt',
      vacation_rule: employee.owner ? 'none' : 'procentregeln',
    })
    employees.set(employee.key, created.employee_id)
  }

  const { periods } = await doors.call('gnubok_list_fiscal_periods')
  const fiscalPeriods: Record<number, string> = { 2024: periods[0].id }
  const salaryRuns: Record<string, string> = {}
  const invoices = new Map<string, string>()
  const supplierInvoices = new Map<string, { id: string; gross: number }>()

  const bankRow = async (date: string, amount: number, description: string): Promise<string> => {
    const stagedRows = await doors.call('gnubok_create_transactions', {
      transactions: [{ date, amount, description, ledger_account: '1930' }],
    })
    const committed = await doors.approve('gnubok_create_transactions', stagedRows.operations[0].operation_id)
    return committed.transaction_id
  }
  const voucher = (date: string, description: string, lines: Array<Record<string, unknown>>) =>
    doors.write('gnubok_create_voucher', { entry_date: date, description, lines })
  /** Every krona on 1930 has its bank row, so the bank and the ledger can be compared to the öre. */
  const bankVoucher = async (date: string, description: string, amount: number, otherLines: Array<Record<string, unknown>>) => {
    const bankLine = amount > 0 ? { debit_amount: amount } : { credit_amount: -amount }
    const posted = await voucher(date, description, [...otherLines, { account_number: '1930', ...bankLine }])
    await linkBankRow(date, amount, description, posted.journal_entry_id)
    return posted
  }
  const linkBankRow = async (date: string, amount: number, description: string, journalEntryId: string) => {
    const transactionId = await bankRow(date, amount, description)
    const link = { tx_ids: [transactionId], existing_journal_entry_id: journalEntryId }
    await confirmingDuplicate(
      () => doors.write('gnubok_bulk_book_transactions', link),
      () => doors.write('gnubok_bulk_book_transactions', { ...link, force: true }),
    )
  }

  async function play(event: SimEvent): Promise<void> {
    switch (event.type) {
      case 'share_capital':
        await bankVoucher(event.date, 'Inbetalt aktiekapital', event.amount, [
          { account_number: '2081', credit_amount: event.amount },
        ])
        return
      case 'open_fiscal_year': {
        const created = await doors.write('gnubok_create_fiscal_period', {
          name: `Räkenskapsår ${event.year}`,
          period_start: `${event.year}-01-01`,
          period_end: `${event.year}-12-31`,
        })
        fiscalPeriods[event.year] = created.fiscal_period.id
        return
      }
      case 'sale': {
        const invoice = await doors.write('gnubok_create_invoice', {
          customer_id: customers.get(event.customer),
          invoice_date: event.date,
          due_date: event.dueDate,
          items: event.lines.map((line) => ({
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unit_price: line.unitPrice,
            vat_rate: line.vatRate,
          })),
        })
        await doors.write('gnubok_mark_invoice_as_sent', { invoice_id: invoice.invoice_id })
        invoices.set(event.id, invoice.invoice_id)
        return
      }
      case 'sale_payment': {
        const invoiceId = invoices.get(event.saleId)
        const { data: invoice } = await supabase.from('invoices').select('total, invoice_number').eq('id', invoiceId).single()
        const text = `Inbetalning faktura ${invoice?.invoice_number}`
        if (event.viaBankRow) {
          const transactionId = await bankRow(event.date, Number(invoice?.total), text)
          const match = { transaction_id: transactionId, invoice_id: invoiceId }
          await confirmingDuplicate(
            () => doors.write('gnubok_match_transaction_to_invoice', match),
            (refusal) =>
              doors.write('gnubok_match_transaction_to_invoice', {
                ...match,
                force: true,
                expected_journal_entry_id: /journal_entry_id="([^"]+)"/.exec(refusal)?.[1],
              }),
          )
          return
        }
        const payment = { invoice_id: invoiceId, payment_date: event.date }
        const paid = await confirmingDuplicate(
          () => doors.write('gnubok_mark_invoice_as_paid', payment),
          () => doors.write('gnubok_mark_invoice_as_paid', { ...payment, allow_duplicate: true }),
        )
        await linkBankRow(event.date, Number(invoice?.total), text, paid.journal_entry_id)
        return
      }
      case 'credit_note':
        await doors.write('gnubok_credit_invoice', { invoice_id: invoices.get(event.saleId), reason: 'Felaktig fakturering' })
        return
      case 'purchase': {
        const body = CreateSupplierInvoiceSchema.parse({
          supplier_id: suppliers.get(event.supplier),
          supplier_invoice_number: event.number,
          invoice_date: event.date,
          due_date: event.dueDate,
          ...(event.supplier === 'cloud-ie' ? { reverse_charge: true, vat_treatment: 'reverse_charge' } : {}),
          items: event.lines.map((line) => ({
            description: line.description,
            quantity: 1,
            unit_price: line.net,
            account_number: line.account,
            vat_rate: line.vatRate / 100,
          })),
        })
        const created = await createSupplierInvoice({ supabase, companyId, userId, log }, body)
        if (!created.ok || created.dryRun) {
          throw new Error(`supplier invoice ${event.id} refused: ${JSON.stringify(created).slice(0, 500)}`)
        }
        supplierInvoices.set(event.id, { id: created.invoice.id, gross: Number(created.invoice.total) })
        return
      }
      case 'purchase_payment': {
        const invoice = supplierInvoices.get(event.purchaseId)!
        const posted = await bankVoucher(event.date, `Betalning leverantörsfaktura ${event.purchaseId}`, -invoice.gross, [
          { account_number: '2440', debit_amount: invoice.gross },
        ])
        await doors.write('gnubok_link_supplier_invoice_to_voucher', {
          supplier_invoice_id: invoice.id,
          journal_entry_id: posted.journal_entry_id,
        })
        return
      }
      case 'asset':
        await doors.write('gnubok_create_asset', {
          name: event.name,
          category: 'equipment',
          acquisition_date: event.date,
          acquisition_cost: event.cost,
          useful_life_months: event.usefulLifeMonths,
        })
        return
      case 'card_cost': {
        const gross = event.net + (event.net * event.vatRate) / 100
        const transactionId = await bankRow(event.date, -gross, event.text)
        const categorized = {
          transaction_id: transactionId,
          category: event.category,
          ...(event.account ? { account_override: event.account } : {}),
          vat_treatment: event.vatRate === 12 ? 'reduced_12' : 'standard_25',
          notes: event.text,
        }
        await confirmingDuplicate(
          () => doors.write('gnubok_categorize_transaction', categorized),
          () => doors.write('gnubok_categorize_transaction', { ...categorized, allow_duplicate: true }),
        )
        return
      }
      case 'bank_fee': {
        const transactionId = await bankRow(event.date, -event.amount, 'Bankavgift')
        const categorized = { transaction_id: transactionId, category: 'expense_bank_fees' }
        await confirmingDuplicate(
          () => doors.write('gnubok_categorize_transaction', categorized),
          () => doors.write('gnubok_categorize_transaction', { ...categorized, allow_duplicate: true }),
        )
        return
      }
      case 'salary_change':
        await doors.write('gnubok_update_employee', {
          employee_id: employees.get(event.employee),
          monthly_salary: event.monthlySalary,
        })
        return
      case 'payroll': {
        const run = await doors.write('gnubok_create_salary_run', {
          period_year: event.year,
          period_month: event.month,
          payment_date: event.date,
        })
        const runId = run.salary_run_id ?? run.id
        await doors.call('gnubok_calculate_salary_run', { salary_run_id: runId })
        const booked = await doors.write('gnubok_book_salary_run', { salary_run_id: runId })
        await doors.write('gnubok_generate_agi', { salary_run_id: runId })
        const month = key.payroll[monthKey(event.year, event.month)]
        await linkBankRow(event.date, -month.totalNet, `Löner ${monthKey(event.year, event.month)}`, booked.journal_entry_ids[0])
        salaryRuns[monthKey(event.year, event.month)] = runId
        return
      }
      case 'payroll_taxes_paid': {
        const month = key.payroll[monthKey(event.year, event.month)]
        await bankVoucher(event.date, `Skatt och avgifter ${event.year}-${event.month}`, -month.payable, [
          { account_number: '2710', debit_amount: month.totalTax },
          { account_number: '2731', debit_amount: month.filedAvgifter },
        ])
        return
      }
      case 'vat_settlement':
        await doors.write('gnubok_book_vat_settlement', {
          period_type: 'quarterly',
          year: event.year,
          period: event.quarter,
        })
        return
      case 'vat_paid': {
        const { filedNet } = key.vat[vatKey(event.year, event.quarter)]
        await bankVoucher(event.date, `Moms ${event.year} kvartal ${event.quarter}`, -filedNet, [
          { account_number: '2650', debit_amount: filedNet },
        ])
        return
      }
      case 'depreciation':
        await doors.write('gnubok_post_annual_depreciation', { fiscal_period_id: fiscalPeriods[event.year] })
        return
      case 'corporate_tax': {
        const tax = key.corporateTax[event.year]
        await voucher(event.date, `Bolagsskatt ${event.year}`, [
          { account_number: '8910', debit_amount: tax },
          { account_number: '2512', credit_amount: tax },
        ])
        return
      }
      case 'year_end':
        await doors.write('gnubok_run_year_end', { fiscal_period_id: fiscalPeriods[event.year] })
        return
      case 'annual_report': {
        const fiscal_period_id = fiscalPeriods[event.year]
        await doors.write('gnubok_update_arsredovisning_narrative', {
          fiscal_period_id,
          ...ANNUAL_REPORT_TEXTS,
        })
        await doors.write('gnubok_update_arsredovisning_compliance', { fiscal_period_id, ...ANNUAL_REPORT_ANSWERS })
        return
      }
      case 'corporate_tax_paid': {
        const tax = key.corporateTax[event.year]
        await bankVoucher(event.date, `Slutlig skatt ${event.year}`, -tax, [
          { account_number: '2512', debit_amount: tax },
        ])
        return
      }
    }
  }

  let played = 0
  for (const event of plan.events) {
    if (until && event.date > until) break
    setSimDay(event.date)
    try {
      await play(event)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${event.date} ${event.type}: ${message}\n${JSON.stringify(event)}`, { cause: error })
    }
    played += 1
    if (played % 100 === 0) onProgress?.(`${played} of ${plan.events.length} events, at ${event.date}`)
  }

  return {
    seed: plan.seed,
    scale: plan.scale,
    companyId,
    userId,
    fiscalPeriods,
    salaryRuns,
    events: played,
    until: until ?? null,
    seconds: Math.round((performance.now() - started) / 1000),
  }
}
