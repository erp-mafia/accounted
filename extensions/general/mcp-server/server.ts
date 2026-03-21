import { NextResponse } from 'next/server'
import {
  extractBearerToken,
  validateApiKey,
  createServiceClientNoCookies,
} from '@/lib/auth/api-keys'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { eventBus } from '@/lib/events/bus'
import { getVatRules, getAvailableVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  calculateGrossMargin,
  calculateCashPosition,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
} from '@/lib/reports/kpi'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
// ensureInitialized() is called by the extension router (ext/[...path]/route.ts)
// which dispatches to this handler — no duplicate call needed here.
import type { Transaction, TransactionCategory, EntityType, VatTreatment, Invoice, Currency } from '@/types'

// ── JSON-RPC types ───────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── MCP Tool definition ──────────────────────────────────────

interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
  execute: (
    args: Record<string, unknown>,
    userId: string,
    supabase: SupabaseClient
  ) => Promise<unknown>
}

// ── Shared constants ─────────────────────────────────────────

const VALID_CATEGORIES = [
  'income_services', 'income_products', 'income_other',
  'expense_equipment', 'expense_software', 'expense_travel', 'expense_office',
  'expense_marketing', 'expense_professional_services', 'expense_education',
  'expense_representation', 'expense_consumables', 'expense_vehicle',
  'expense_telecom', 'expense_bank_fees', 'expense_card_fees',
  'expense_currency_exchange', 'expense_other', 'private',
] as const

const VALID_VAT_TREATMENTS = [
  'standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt',
] as const

// ── Tools ────────────────────────────────────────────────────

const tools: McpTool[] = [
  {
    name: 'gnubok_list_uncategorized_transactions',
    description:
      'List bank transactions that have not been categorized (no journal entry yet). ' +
      'Use this to see what needs bookkeeping attention.\n\n' +
      'Args:\n' +
      '  - limit (number, optional): Max results, 1–100 (default: 20)\n' +
      '  - offset (number, optional): Skip first N results for pagination (default: 0)\n\n' +
      'Returns JSON:\n' +
      '  { transactions: [{ id, date, description, amount, currency, merchant_name, reference }],\n' +
      '    count: number, total_count: number, has_more: boolean, next_offset?: number }\n\n' +
      'Examples:\n' +
      '  - "Show my uncategorized transactions" → call with no args\n' +
      '  - "Show next 50" → call with limit=50\n' +
      '  - "Show page 2" → call with offset=20\n\n' +
      'Error: Returns error text if the database query fails.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return, 1–100 (default 20)',
        },
        offset: {
          type: 'number',
          description: 'Number of results to skip for pagination (default 0)',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
      const offset = Math.max(0, Number(args.offset) || 0)

      // Get total count
      const { count: totalCount, error: countError } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('journal_entry_id', null)

      if (countError) throw new Error(`Database error: ${countError.message}`)

      const { data, error } = await supabase
        .from('transactions')
        .select(
          'id, date, description, amount, currency, merchant_name, reference, is_business, category'
        )
        .eq('user_id', userId)
        .is('journal_entry_id', null)
        .order('date', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) throw new Error(`Database error: ${error.message}`)

      const total = totalCount ?? 0
      const hasMore = total > offset + (data?.length ?? 0)

      return {
        transactions: data,
        count: data?.length ?? 0,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + (data?.length ?? 0) } : {}),
      }
    },
  },

  {
    name: 'gnubok_categorize_transaction',
    description:
      'Categorize a bank transaction and create the corresponding double-entry journal entry. ' +
      'This books the transaction in the accounting ledger using Swedish BAS accounts.\n\n' +
      'Args:\n' +
      '  - transaction_id (string, required): UUID of the transaction from gnubok_list_uncategorized_transactions\n' +
      '  - category (string, required): One of: ' + VALID_CATEGORIES.join(', ') + '\n' +
      '  - vat_treatment (string, optional): One of: ' + VALID_VAT_TREATMENTS.join(', ') + '. ' +
      'Defaults to standard_25 for business expenses.\n\n' +
      'Returns JSON:\n' +
      '  { success: boolean, journal_entry_created: boolean, journal_entry_id?: string,\n' +
      '    category: string, debit_account: string, credit_account: string }\n\n' +
      'Examples:\n' +
      '  - "Book that as office supplies, 25% VAT" → category="expense_office"\n' +
      '  - "Mark as private" → category="private" (no journal entry created for private)\n' +
      '  - "Book as consulting income" → category="income_services"\n\n' +
      'Errors:\n' +
      '  - "Transaction not found" if the ID is invalid or belongs to another user\n' +
      '  - "Transaction already has a journal entry" if already categorized\n' +
      '  - "Invalid account mapping" if the category/entity type combination has no mapping',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: {
          type: 'string',
          description: 'UUID of the transaction to categorize',
        },
        category: {
          type: 'string',
          description: 'Transaction category',
          enum: [...VALID_CATEGORIES],
        },
        vat_treatment: {
          type: 'string',
          description: 'VAT treatment override',
          enum: [...VALID_VAT_TREATMENTS],
        },
      },
      required: ['transaction_id', 'category'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const txId = args.transaction_id as string
      const category = args.category as TransactionCategory
      const vatTreatment = args.vat_treatment as VatTreatment | undefined

      // Validate category
      if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
        throw new Error(
          `Invalid category "${category}". Valid categories: ${VALID_CATEGORIES.join(', ')}`
        )
      }

      if (vatTreatment && !VALID_VAT_TREATMENTS.includes(vatTreatment as typeof VALID_VAT_TREATMENTS[number])) {
        throw new Error(
          `Invalid vat_treatment "${vatTreatment}". Valid: ${VALID_VAT_TREATMENTS.join(', ')}`
        )
      }

      const isBusiness = category !== 'private'

      // Fetch the transaction
      const { data: transaction, error: fetchError } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', txId)
        .eq('user_id', userId)
        .single()

      if (fetchError || !transaction) {
        throw new Error('Transaction not found. Check the transaction_id is correct.')
      }

      if (transaction.journal_entry_id) {
        return {
          success: true,
          journal_entry_created: false,
          message: 'Transaction already has a journal entry — use gnubok_list_uncategorized_transactions to find unboooked ones.',
          journal_entry_id: transaction.journal_entry_id,
        }
      }

      // Get entity type
      const { data: settings } = await supabase
        .from('company_settings')
        .select('entity_type, fiscal_year_start_month')
        .eq('user_id', userId)
        .single()

      const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

      // Build mapping
      const mappingResult = buildMappingResultFromCategory(
        category,
        transaction as Transaction,
        isBusiness,
        entityType,
        vatTreatment
      )

      if (!mappingResult.debit_account || !mappingResult.credit_account) {
        throw new Error(
          `No account mapping for category "${category}" with entity type "${entityType}". ` +
          'Try a different category or check your chart of accounts.'
        )
      }

      // Ensure fiscal period exists
      const fiscalYearStartMonth = settings?.fiscal_year_start_month ?? 1
      const txDate = new Date(transaction.date)
      const txMonth = txDate.getMonth() + 1
      const txYear = txDate.getFullYear()

      let periodStartYear: number
      if (fiscalYearStartMonth === 1) {
        periodStartYear = txYear
      } else if (txMonth >= fiscalYearStartMonth) {
        periodStartYear = txYear
      } else {
        periodStartYear = txYear - 1
      }

      const startMonth = String(fiscalYearStartMonth).padStart(2, '0')
      const periodStart = `${periodStartYear}-${startMonth}-01`

      const endYear = fiscalYearStartMonth === 1 ? periodStartYear : periodStartYear + 1
      const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
      const lastDay = new Date(endYear, endMonth, 0).getDate()
      const periodEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

      const periodName = fiscalYearStartMonth === 1
        ? `Räkenskapsår ${periodStartYear}`
        : `Räkenskapsår ${periodStartYear}/${endYear}`

      await supabase
        .from('fiscal_periods')
        .upsert(
          { user_id: userId, name: periodName, period_start: periodStart, period_end: periodEnd },
          { onConflict: 'user_id,period_start,period_end' }
        )

      // Create journal entry
      let journalEntryId: string | null = null
      let journalEntryError: string | null = null

      try {
        const journalEntry = await createTransactionJournalEntry(
          supabase,
          userId,
          transaction as Transaction,
          mappingResult
        )
        if (journalEntry) {
          journalEntryId = journalEntry.id
        }
      } catch (err) {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }

      // Update transaction
      await supabase
        .from('transactions')
        .update({
          is_business: isBusiness,
          category,
          journal_entry_id: journalEntryId,
        })
        .eq('id', txId)

      // Emit event so extensions (mapping rules, etc.) can react
      await eventBus.emit({
        type: 'transaction.categorized',
        payload: {
          transaction: transaction as Transaction,
          account: mappingResult.debit_account,
          taxCode: mappingResult.vat_lines[0]?.account_number || '',
          userId,
        },
      })

      return {
        success: true,
        journal_entry_created: !!journalEntryId,
        journal_entry_id: journalEntryId,
        journal_entry_error: journalEntryError,
        category,
        debit_account: mappingResult.debit_account,
        credit_account: mappingResult.credit_account,
        amount: Math.abs(transaction.amount),
        currency: transaction.currency,
      }
    },
  },

  // ── Customer tools ───────────────────────────────────────────

  {
    name: 'gnubok_list_customers',
    description:
      'List all customers. Use this to look up customer IDs for invoice creation.\n\n' +
      'Args: none\n\n' +
      'Returns JSON:\n' +
      '  { customers: [{ id, name, customer_type, email, org_number, vat_number, default_payment_terms }],\n' +
      '    count: number }',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, userId, supabase) {
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, customer_type, email, org_number, vat_number, default_payment_terms, city, country')
        .eq('user_id', userId)
        .order('name')

      if (error) throw new Error(`Database error: ${error.message}`)

      return { customers: data, count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_customer',
    description:
      'Create a new customer. Required for invoice creation.\n\n' +
      'Args:\n' +
      '  - name (string, required): Customer/company name\n' +
      '  - customer_type (string, required): individual, swedish_business, eu_business, non_eu_business\n' +
      '  - email (string, optional): Contact email\n' +
      '  - org_number (string, optional): Swedish org number (for swedish_business)\n' +
      '  - vat_number (string, optional): EU VAT number (for eu_business, triggers VIES validation)\n' +
      '  - payment_terms (number, optional): Days until due (default 30)\n' +
      '  - address (string, optional): Street address\n' +
      '  - postal_code (string, optional)\n' +
      '  - city (string, optional)\n' +
      '  - country (string, optional): Defaults to Sweden\n\n' +
      'Returns JSON: the created customer object with id.\n\n' +
      'Examples:\n' +
      '  - "Add Acme AB" → name="Acme AB", customer_type="swedish_business"\n' +
      '  - "Add a German client" → customer_type="eu_business", country="Germany"',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name' },
        customer_type: {
          type: 'string',
          enum: ['individual', 'swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Customer type',
        },
        email: { type: 'string', description: 'Email address' },
        org_number: { type: 'string', description: 'Swedish org number' },
        vat_number: { type: 'string', description: 'EU VAT number' },
        payment_terms: { type: 'number', description: 'Payment terms in days (default 30)' },
        address: { type: 'string', description: 'Street address' },
        postal_code: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string', description: 'Country (default Sweden)' },
      },
      required: ['name', 'customer_type'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const name = args.name as string
      const customerType = args.customer_type as string

      if (!name?.trim()) throw new Error('Customer name is required.')
      if (!['individual', 'swedish_business', 'eu_business', 'non_eu_business'].includes(customerType)) {
        throw new Error('Invalid customer_type. Must be: individual, swedish_business, eu_business, non_eu_business')
      }

      const { data, error } = await supabase
        .from('customers')
        .insert({
          user_id: userId,
          name: name.trim(),
          customer_type: customerType,
          email: (args.email as string) || null,
          org_number: (args.org_number as string) || null,
          vat_number: (args.vat_number as string) || null,
          default_payment_terms: Number(args.payment_terms) || 30,
          address_line1: (args.address as string) || null,
          postal_code: (args.postal_code as string) || null,
          city: (args.city as string) || null,
          country: (args.country as string) || 'Sweden',
        })
        .select()
        .single()

      if (error) throw new Error(`Failed to create customer: ${error.message}`)

      return { customer: data }
    },
  },

  // ── Invoice tools ────────────────────────────────────────────

  {
    name: 'gnubok_list_invoices',
    description:
      'List invoices, optionally filtered by status.\n\n' +
      'Args:\n' +
      '  - status (string, optional): Filter by status: draft, sent, paid, overdue, cancelled, credited\n' +
      '  - limit (number, optional): Max results, 1–100 (default 50)\n\n' +
      'Returns JSON:\n' +
      '  { invoices: [{ id, invoice_number, status, customer_name, total, currency, invoice_date, due_date }],\n' +
      '    count: number, total_count: number }\n\n' +
      'Examples:\n' +
      '  - "Show unpaid invoices" → status="sent"\n' +
      '  - "Show overdue invoices" → status="overdue"',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited'],
          description: 'Filter by invoice status',
        },
        limit: { type: 'number', description: 'Max results (default 50, max 100)' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const status = args.status as string | undefined

      let query = supabase
        .from('invoices')
        .select('id, invoice_number, status, customer_id, total, currency, invoice_date, due_date, document_type, customers(name)', { count: 'exact' })
        .eq('user_id', userId)

      if (status) {
        query = query.eq('status', status)
      }

      const { data, error, count } = await query
        .order('invoice_date', { ascending: false })
        .limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      const invoices = (data ?? []).map((inv: Record<string, unknown>) => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        status: inv.status,
        customer_name: (inv.customers as Record<string, unknown>)?.name ?? null,
        total: inv.total,
        currency: inv.currency,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        document_type: inv.document_type,
      }))

      return {
        invoices,
        count: invoices.length,
        total_count: count ?? invoices.length,
      }
    },
  },

  {
    name: 'gnubok_create_invoice',
    description:
      'Create a new invoice for a customer. Automatically calculates VAT based on customer type.\n\n' +
      'Args:\n' +
      '  - customer_id (string, required): UUID from gnubok_list_customers\n' +
      '  - items (array, required): Line items, each with:\n' +
      '      - description (string): What was sold/delivered\n' +
      '      - quantity (number): How many\n' +
      '      - unit (string): Unit of measure (st, tim, dag, mån)\n' +
      '      - unit_price (number): Price per unit excl. VAT\n' +
      '      - vat_rate (number, optional): Override VAT rate (0–100)\n' +
      '  - invoice_date (string, optional): YYYY-MM-DD (default today)\n' +
      '  - due_date (string, optional): YYYY-MM-DD (default based on payment terms)\n' +
      '  - currency (string, optional): SEK, EUR, USD, GBP, NOK, DKK (default SEK)\n' +
      '  - our_reference (string, optional)\n' +
      '  - your_reference (string, optional)\n' +
      '  - notes (string, optional): Notes printed on invoice\n\n' +
      'Returns JSON: the created invoice with id, invoice_number, total, vat_amount.\n\n' +
      'Examples:\n' +
      '  - "Invoice Acme for 15000 kr consulting" → items=[{description:"Konsulttjänster",quantity:1,unit:"st",unit_price:15000}]\n' +
      '  - "Invoice 10 hours at 1500/h" → items=[{description:"Konsulttjänster",quantity:10,unit:"tim",unit_price:1500}]',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT' },
              vat_rate: { type: 'number', description: 'VAT rate 0–100 (optional override)' },
            },
            required: ['description', 'quantity', 'unit', 'unit_price'],
          },
          description: 'Invoice line items',
        },
        invoice_date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (default from payment terms)' },
        currency: { type: 'string', enum: ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] },
        our_reference: { type: 'string' },
        your_reference: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['customer_id', 'items'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const customerId = args.customer_id as string
      const items = args.items as Array<{
        description: string
        quantity: number
        unit: string
        unit_price: number
        vat_rate?: number
      }>

      if (!customerId) throw new Error('customer_id is required. Use gnubok_list_customers to find IDs.')
      if (!items?.length) throw new Error('At least one item is required.')

      for (const [i, item] of items.entries()) {
        if (!item.description?.trim()) throw new Error(`Item ${i + 1}: description is required`)
        if (!item.quantity || item.quantity <= 0) throw new Error(`Item ${i + 1}: quantity must be positive`)
        if (!item.unit?.trim()) throw new Error(`Item ${i + 1}: unit is required (st, tim, dag)`)
        if (item.unit_price == null) throw new Error(`Item ${i + 1}: unit_price is required`)
      }

      const today = new Date().toISOString().split('T')[0]
      const currency = ((args.currency as string) || 'SEK') as Currency
      const invoiceDate = (args.invoice_date as string) || today

      // Fetch customer (full row for VAT rules)
      const { data: customer, error: custError } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId)
        .eq('user_id', userId)
        .single()

      if (custError || !customer) {
        throw new Error('Customer not found. Use gnubok_list_customers to find valid IDs.')
      }

      // VAT rules from customer type (same logic as web UI)
      const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
      const availableRates = getAvailableVatRates(customer.customer_type, customer.vat_number_validated)
      const allowedRates = new Set(availableRates.map((r) => r.rate))

      // Calculate per-item VAT
      const subtotal = items.reduce((s, item) => s + item.quantity * item.unit_price, 0)
      let vatAmount = 0
      for (const item of items) {
        const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
        if (!allowedRates.has(itemRate)) {
          throw new Error(
            `VAT rate ${itemRate}% is not allowed for customer type "${customer.customer_type}". ` +
            `Allowed rates: ${availableRates.map((r) => r.rate + '%').join(', ')}`
          )
        }
        const lineTotal = item.quantity * item.unit_price
        vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
      }
      const total = subtotal + vatAmount

      // Mixed-rate detection
      const uniqueRates = new Set(items.map((item) => item.vat_rate ?? vatRules.rate))

      // Currency exchange (Riksbanken)
      let exchangeRate: number | null = null
      let exchangeRateDate: string | null = null
      let subtotalSek: number | null = null
      let vatAmountSek: number | null = null
      let totalSek: number | null = null

      if (currency !== 'SEK') {
        const rateData = await fetchExchangeRate(currency)
        if (rateData) {
          exchangeRate = rateData.rate
          exchangeRateDate = rateData.date
          subtotalSek = convertToSEK(subtotal, exchangeRate)
          vatAmountSek = convertToSEK(vatAmount, exchangeRate)
          totalSek = convertToSEK(total, exchangeRate)
        }
      }

      // Due date from payment terms if not provided
      let dueDate = args.due_date as string | undefined
      if (!dueDate) {
        const d = new Date(invoiceDate)
        d.setDate(d.getDate() + (customer.default_payment_terms || 30))
        dueDate = d.toISOString().split('T')[0]
      }

      // Generate invoice number via DB RPC (sequential, same as web UI)
      const { data: baseNumber } = await supabase.rpc('generate_invoice_number', {
        p_user_id: userId,
      })
      const invoiceNumber = baseNumber as string

      // Create invoice
      const { data: invoice, error: insertError } = await supabase
        .from('invoices')
        .insert({
          user_id: userId,
          customer_id: customerId,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          due_date: dueDate,
          status: 'draft',
          currency,
          exchange_rate: exchangeRate,
          exchange_rate_date: exchangeRateDate,
          subtotal,
          subtotal_sek: subtotalSek,
          vat_amount: vatAmount,
          vat_amount_sek: vatAmountSek,
          total,
          total_sek: totalSek,
          vat_treatment: vatRules.treatment,
          vat_rate: uniqueRates.size > 1 ? null : (uniqueRates.values().next().value ?? vatRules.rate),
          moms_ruta: vatRules.momsRuta,
          reverse_charge_text: vatRules.reverseChargeText || null,
          document_type: 'invoice',
          our_reference: (args.our_reference as string) || null,
          your_reference: (args.your_reference as string) || null,
          notes: (args.notes as string) || null,
        })
        .select()
        .single()

      if (insertError || !invoice) {
        throw new Error(`Failed to create invoice: ${insertError?.message || 'Unknown error'}`)
      }

      // Insert items
      const invoiceItems = items.map((item, idx) => {
        const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
        const lineTotal = item.quantity * item.unit_price
        const itemVat = Math.round(lineTotal * itemRate / 100 * 100) / 100
        return {
          invoice_id: invoice.id,
          sort_order: idx,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unit_price,
          line_total: lineTotal,
          vat_rate: itemRate,
          vat_amount: itemVat,
        }
      })

      const { error: itemsError } = await supabase
        .from('invoice_items')
        .insert(invoiceItems)

      if (itemsError) {
        await supabase.from('invoices').delete().eq('id', invoice.id)
        throw new Error(`Failed to create invoice items: ${itemsError.message}`)
      }

      // Emit event (triggers journal entry creation via event handler)
      const { data: completeInvoice } = await supabase
        .from('invoices')
        .select('*, customer:customers(*), items:invoice_items(*)')
        .eq('id', invoice.id)
        .single()

      if (completeInvoice) {
        await eventBus.emit({
          type: 'invoice.created',
          payload: { invoice: completeInvoice as Invoice, userId },
        })
      }

      return {
        invoice: {
          id: invoice.id,
          invoice_number: invoiceNumber,
          status: 'draft',
          customer_name: customer.name,
          subtotal: Math.round(subtotal * 100) / 100,
          vat_amount: Math.round(vatAmount * 100) / 100,
          total: Math.round(total * 100) / 100,
          currency,
          vat_treatment: vatRules.treatment,
          invoice_date: invoiceDate,
          due_date: dueDate,
          item_count: invoiceItems.length,
          ...(exchangeRate ? { exchange_rate: exchangeRate, total_sek: totalSek } : {}),
        },
        note: 'Invoice created as draft. Use the web UI to send it.',
      }
    },
  },

  // ── Report tools ─────────────────────────────────────────────

  {
    name: 'gnubok_get_trial_balance',
    description:
      'Get the trial balance (huvudbok) for a fiscal period. Shows all account balances.\n\n' +
      'Args:\n' +
      '  - period_id (string, optional): Fiscal period UUID. If omitted, uses the most recent period.\n\n' +
      'Returns JSON:\n' +
      '  { rows: [{ account_number, account_name, period_debit, period_credit, closing_debit, closing_credit }],\n' +
      '    total_debit: number, total_credit: number, is_balanced: boolean, period_name: string }\n\n' +
      'Examples:\n' +
      '  - "What are my account balances?" → call with no args\n' +
      '  - "Trial balance for last year" → provide the period_id',
    inputSchema: {
      type: 'object',
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      let periodId = args.period_id as string | undefined

      // If no period specified, find the most recent one
      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id, name')
          .eq('user_id', userId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first to auto-create a period.')
        }
        periodId = periods.id
      }

      // Get period info
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('user_id', userId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Aggregate journal entry lines
      const { data: lines, error } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount, journal_entries!inner(status, user_id, fiscal_period_id)')
        .eq('journal_entries.user_id', userId)
        .eq('journal_entries.fiscal_period_id', periodId)
        .in('journal_entries.status', ['posted', 'reversed'])

      if (error) throw new Error(`Database error: ${error.message}`)

      // Get account names
      const { data: accounts } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('user_id', userId)

      const accountMap = new Map((accounts ?? []).map((a: { account_number: string; account_name: string }) => [a.account_number, a.account_name]))

      // Aggregate by account
      const totals = new Map<string, { debit: number; credit: number }>()
      for (const line of lines ?? []) {
        const acc = line.account_number
        const existing = totals.get(acc) ?? { debit: 0, credit: 0 }
        existing.debit += Number(line.debit_amount) || 0
        existing.credit += Number(line.credit_amount) || 0
        totals.set(acc, existing)
      }

      const rows = Array.from(totals.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([accNum, t]) => {
          const net = Math.round((t.debit - t.credit) * 100) / 100
          return {
            account_number: accNum,
            account_name: accountMap.get(accNum) ?? accNum,
            period_debit: Math.round(t.debit * 100) / 100,
            period_credit: Math.round(t.credit * 100) / 100,
            closing_debit: net > 0 ? net : 0,
            closing_credit: net < 0 ? Math.abs(net) : 0,
          }
        })

      const totalDebit = Math.round(rows.reduce((s, r) => s + r.closing_debit, 0) * 100) / 100
      const totalCredit = Math.round(rows.reduce((s, r) => s + r.closing_credit, 0) * 100) / 100

      return {
        rows,
        total_debit: totalDebit,
        total_credit: totalCredit,
        is_balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        account_count: rows.length,
      }
    },
  },

  {
    name: 'gnubok_get_vat_report',
    description:
      'Get the VAT declaration (momsdeklaration) for a period. Shows all rutor (boxes) for SKV 4700.\n\n' +
      'Args:\n' +
      '  - period_type (string, required): monthly, quarterly, yearly\n' +
      '  - year (number, required): e.g. 2025\n' +
      '  - period (number, required): 1–12 for monthly, 1–4 for quarterly, 1 for yearly\n\n' +
      'Returns JSON: VAT declaration with all rutor (05, 10, 11, 12, 48, 49, etc.)\n' +
      '  ruta49 = VAT to pay (positive) or refund (negative)\n\n' +
      'Examples:\n' +
      '  - "VAT for Q1 2025" → period_type="quarterly", year=2025, period=1\n' +
      '  - "VAT for March 2025" → period_type="monthly", year=2025, period=3',
    inputSchema: {
      type: 'object',
      properties: {
        period_type: {
          type: 'string',
          enum: ['monthly', 'quarterly', 'yearly'],
          description: 'Period type',
        },
        year: { type: 'number', description: 'Year (e.g. 2025)' },
        period: { type: 'number', description: '1–12 for monthly, 1–4 for quarterly, 1 for yearly' },
      },
      required: ['period_type', 'year', 'period'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      const periodType = args.period_type as string
      const year = Number(args.year)
      const period = Number(args.period)

      if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
        throw new Error('period_type must be: monthly, quarterly, yearly')
      }
      if (!year || year < 2000 || year > 2100) throw new Error('year must be between 2000 and 2100')
      if (periodType === 'monthly' && (period < 1 || period > 12)) throw new Error('period must be 1–12 for monthly')
      if (periodType === 'quarterly' && (period < 1 || period > 4)) throw new Error('period must be 1–4 for quarterly')

      // Calculate date range
      let startDate: string
      let endDate: string

      if (periodType === 'monthly') {
        startDate = `${year}-${String(period).padStart(2, '0')}-01`
        const lastDay = new Date(year, period, 0).getDate()
        endDate = `${year}-${String(period).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      } else if (periodType === 'quarterly') {
        const startMonth = (period - 1) * 3 + 1
        const endMonth = period * 3
        startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
        const lastDay = new Date(year, endMonth, 0).getDate()
        endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
      } else {
        startDate = `${year}-01-01`
        endDate = `${year}-12-31`
      }

      // Get all posted journal entry lines in the date range
      const { data: lines, error } = await supabase
        .from('journal_entry_lines')
        .select('account_number, debit_amount, credit_amount, journal_entries!inner(entry_date, status, user_id)')
        .eq('journal_entries.user_id', userId)
        .in('journal_entries.status', ['posted', 'reversed'])
        .gte('journal_entries.entry_date', startDate)
        .lte('journal_entries.entry_date', endDate)

      if (error) throw new Error(`Database error: ${error.message}`)

      // Aggregate by account
      const accountTotals = new Map<string, { debit: number; credit: number }>()
      for (const line of lines ?? []) {
        const acc = line.account_number
        const existing = accountTotals.get(acc) ?? { debit: 0, credit: 0 }
        existing.debit += Number(line.debit_amount) || 0
        existing.credit += Number(line.credit_amount) || 0
        accountTotals.set(acc, existing)
      }

      function creditBalance(acc: string): number {
        const t = accountTotals.get(acc)
        return t ? Math.round((t.credit - t.debit) * 100) / 100 : 0
      }

      function debitBalance(acc: string): number {
        const t = accountTotals.get(acc)
        return t ? Math.round((t.debit - t.credit) * 100) / 100 : 0
      }

      // Map accounts to rutor
      const ruta05 = creditBalance('3001') + creditBalance('3002') + creditBalance('3003')
      const ruta10 = creditBalance('2611')
      const ruta11 = creditBalance('2621')
      const ruta12 = creditBalance('2631')
      const ruta39 = creditBalance('3308')
      const ruta40 = creditBalance('3305')
      const ruta48 = debitBalance('2641') + debitBalance('2645')
      const ruta49 = Math.round((ruta10 + ruta11 + ruta12 - ruta48) * 100) / 100

      const monthNames = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
        'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December']

      let periodLabel: string
      if (periodType === 'monthly') periodLabel = `${monthNames[period - 1]} ${year}`
      else if (periodType === 'quarterly') periodLabel = `Q${period} ${year}`
      else periodLabel = `${year}`

      return {
        period: { type: periodType, year, period, start: startDate, end: endDate },
        period_label: periodLabel,
        rutor: {
          ruta05: Math.abs(ruta05),
          ruta10: Math.abs(ruta10),
          ruta11: Math.abs(ruta11),
          ruta12: Math.abs(ruta12),
          ruta39: Math.abs(ruta39),
          ruta40: Math.abs(ruta40),
          ruta48: Math.abs(ruta48),
          ruta49,
        },
        summary: ruta49 > 0
          ? `Moms att betala: ${Math.abs(ruta49).toFixed(2)} kr`
          : ruta49 < 0
            ? `Moms att få tillbaka: ${Math.abs(ruta49).toFixed(2)} kr`
            : 'Noll i moms',
      }
    },
  },

  // ── KPI & Income Statement tools ─────────────────────────────

  {
    name: 'gnubok_get_kpi_report',
    description:
      'Get key performance indicators for the business. Returns gross margin, net result, cash position, ' +
      'receivables, expense ratio, average payment days, VAT liability, and monthly trend data.\n\n' +
      'Args:\n' +
      '  - period_id (string, optional): Fiscal period UUID. If omitted, uses the most recent period.\n\n' +
      'Returns JSON:\n' +
      '  { gross_margin: %|null, net_result: SEK, cash_position: SEK, outstanding_receivables: SEK,\n' +
      '    overdue_receivables: SEK, expense_ratio: %|null, avg_payment_days: days|null,\n' +
      '    vat_liability: SEK, total_revenue: SEK, total_expenses: SEK,\n' +
      '    months: [{ label, income, expenses, net }] }\n\n' +
      'Examples:\n' +
      '  - "How is my business doing?" → call with no args\n' +
      '  - "What are my KPIs?" → call with no args\n' +
      '  - "Show me the numbers" → call with no args',
    inputSchema: {
      type: 'object',
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('user_id', userId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      // Verify period belongs to user
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('user_id', userId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Run queries in parallel (same as the KPI API route)
      const [incomeStatement, trialBalance, arLedger, monthlyBreakdown, paidInvoices] =
        await Promise.all([
          generateIncomeStatement(supabase, userId, periodId!),
          generateTrialBalance(supabase, userId, periodId!),
          generateARLedger(supabase, userId),
          generateMonthlyBreakdown(supabase, userId, periodId!),
          supabase
            .from('invoices')
            .select('invoice_date, paid_at')
            .eq('user_id', userId)
            .eq('status', 'paid')
            .not('paid_at', 'is', null),
        ])

      const grossMargin = calculateGrossMargin(incomeStatement)
      const cashPosition = calculateCashPosition(trialBalance.rows)
      const expenseRatio = calculateExpenseRatio(incomeStatement)
      const avgPaymentDays = calculateAvgPaymentDays(
        (paidInvoices.data ?? []) as { invoice_date: string; paid_at: string }[]
      )

      // AR ledger uses entries, each with invoices that have outstanding amounts
      const outstandingReceivables = arLedger.total_outstanding
      const overdueReceivables = arLedger.total_overdue

      // VAT liability from trial balance
      const getClosing = (accNum: string) => {
        const row = trialBalance.rows.find((r) => r.account_number === accNum)
        if (!row) return 0
        return row.closing_credit - row.closing_debit
      }
      const vatLiability = Math.round(
        (getClosing('2611') + getClosing('2621') + getClosing('2631') -
          getClosing('2641') - getClosing('2645')) * 100
      ) / 100

      return {
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        gross_margin: grossMargin,
        net_result: incomeStatement.net_result,
        cash_position: cashPosition,
        outstanding_receivables: Math.round(outstandingReceivables * 100) / 100,
        overdue_receivables: Math.round(overdueReceivables * 100) / 100,
        expense_ratio: expenseRatio,
        avg_payment_days: avgPaymentDays,
        paid_invoice_count: paidInvoices.data?.length ?? 0,
        vat_liability: vatLiability,
        total_revenue: incomeStatement.total_revenue,
        total_expenses: incomeStatement.total_expenses,
        months: monthlyBreakdown.months,
      }
    },
  },

  {
    name: 'gnubok_get_income_statement',
    description:
      'Get the income statement (resultaträkning) for a fiscal period. Shows revenue, expenses, ' +
      'and net result broken down by account category.\n\n' +
      'Args:\n' +
      '  - period_id (string, optional): Fiscal period UUID. If omitted, uses the most recent period.\n\n' +
      'Returns JSON:\n' +
      '  { revenue_sections, total_revenue, expense_sections, total_expenses, net_result,\n' +
      '    period: { start, end } }\n\n' +
      'Examples:\n' +
      '  - "What is my profit this year?" → call with no args\n' +
      '  - "Show my income statement" → call with no args',
    inputSchema: {
      type: 'object',
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('user_id', userId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('user_id', userId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      const result = await generateIncomeStatement(supabase, userId, periodId!)
      result.period = { start: period.period_start, end: period.period_end }

      return {
        period_name: period.name,
        ...result,
      }
    },
  },
]

// ── MCP Protocol Handler ─────────────────────────────────────

const SERVER_INFO = {
  name: 'gnubok',
  version: '1.0.0',
}

const PROTOCOL_VERSION = '2025-03-26'

function jsonRpc(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

/**
 * Handle an MCP JSON-RPC request.
 * Auth is done via Bearer API key (extension route has skipAuth: true).
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  // ── Auth ──
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const wwwAuth = `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource"`

  const token = extractBearerToken(request)
  if (!token) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const authResult = await validateApiKey(token)
  if ('error' in authResult) {
    const status = authResult.status
    if (status === 429) {
      return new Response(authResult.error, {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '60' },
      })
    }
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const { userId } = authResult
  const supabase = createServiceClientNoCookies()

  // ── Parse JSON-RPC ──
  let body: JsonRpcRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      jsonRpcError(null, -32700, 'Parse error: expected JSON-RPC 2.0 request body'),
      { status: 400 }
    )
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return NextResponse.json(
      jsonRpcError(body.id ?? null, -32600, 'Invalid Request: must include jsonrpc="2.0" and method'),
      { status: 400 }
    )
  }

  // ── Dispatch ──
  const { method, id, params } = body

  switch (method) {
    case 'initialize':
      return NextResponse.json(
        jsonRpc(id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        })
      )

    case 'notifications/initialized':
      // Client acknowledgement — no response needed for notifications
      return new Response(null, { status: 204 })

    case 'ping':
      return NextResponse.json(jsonRpc(id ?? null, {}))

    case 'tools/list':
      return NextResponse.json(
        jsonRpc(id ?? null, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        })
      )

    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
        string,
        unknown
      >

      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        const available = tools.map((t) => t.name).join(', ')
        return NextResponse.json(
          jsonRpcError(id ?? null, -32602, `Unknown tool: "${toolName}". Available tools: ${available}`)
        )
      }

      try {
        const result = await tool.execute(toolArgs, userId, supabase)
        return NextResponse.json(
          jsonRpc(id ?? null, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          })
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution failed'
        return NextResponse.json(
          jsonRpc(id ?? null, {
            content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
            isError: true,
          })
        )
      }
    }

    default:
      return NextResponse.json(
        jsonRpcError(id ?? null, -32601, `Method not found: "${method}"`)
      )
  }
}
