/**
 * Tests for receipt matcher tools and MCP Apps protocol additions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'

// ── Mocks ──
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn().mockResolvedValue({
    storage: {
      getBucket: vi.fn().mockResolvedValue({ data: { name: 'documents' } }),
    },
  }),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      scopes: ['transactions:read', 'transactions:write', 'customers:read', 'customers:write', 'invoices:read', 'invoices:write', 'suppliers:read', 'reports:read'],
    }),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: vi.fn().mockReturnValue({
    debit_account: '6110',
    credit_account: '1930',
    vat_lines: [{ account_number: '2641', amount: 74.75 }],
  }),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: vi.fn().mockResolvedValue({ id: 'je-123' }),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined), clear: vi.fn() },
}))

vi.mock('@/lib/invoices/vat-rules', () => ({
  getVatRules: vi.fn(),
  getAvailableVatRates: vi.fn(),
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn(),
  convertToSEK: vi.fn(),
}))

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

vi.mock('@/lib/reports/kpi', () => ({
  calculateGrossMargin: vi.fn(),
  calculateCashPosition: vi.fn(),
  calculateExpenseRatio: vi.fn(),
  calculateAvgPaymentDays: vi.fn(),
}))

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('@/lib/reports/ar-ledger', () => ({
  generateARLedger: vi.fn(),
}))

vi.mock('@/lib/reports/monthly-breakdown', () => ({
  generateMonthlyBreakdown: vi.fn(),
}))

vi.mock('@/lib/reports/balance-sheet', () => ({
  generateBalanceSheet: vi.fn(),
}))

vi.mock('@/lib/reports/general-ledger', () => ({
  generateGeneralLedger: vi.fn(),
}))

vi.mock('@/lib/reports/supplier-ledger', () => ({
  generateSupplierLedger: vi.fn(),
}))

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
  createInvoiceCashEntry: vi.fn(),
  createInvoiceJournalEntry: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: vi.fn(),
}))

vi.mock('@/lib/transactions/category-suggestions', () => ({
  getSuggestedCategories: vi.fn(),
}))

// The categorize tool runs the booking-time duplicate guard before staging.
// These tests don't exercise that path, so stub it to "no duplicate": otherwise
// its detection queries would consume the queued supabase mock results.
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn(),
  findCounterpartyTemplatesBatch: vi.fn(),
  formatCounterpartyName: vi.fn(),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn(),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn(),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: vi.fn().mockReturnValue({ sendInvoice: vi.fn() }),
}))

vi.mock('@/lib/email/invoice-templates', () => ({
  generateInvoiceEmailHtml: vi.fn(),
  generateInvoiceEmailText: vi.fn(),
  generateInvoiceEmailSubject: vi.fn(),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
}))

import { handleMcpRequest } from '../server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'

// Helper: make a JSON-RPC request
function mcpRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

async function parseResult(response: Response) {
  const json = await response.json()
  return json.result
}

describe('MCP Receipt Matcher', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    const mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
  })

  // ── Protocol: initialize includes resources capability ──

  describe('initialize', () => {
    it('returns resources capability', async () => {
      const res = await handleMcpRequest(mcpRequest('initialize', { protocolVersion: '2025-03-26' }))
      const result = await parseResult(res)

      expect(result.capabilities.tools).toEqual({ listChanged: false })
      expect(result.capabilities.resources).toEqual({ listChanged: false })
    })
  })

  // ── Protocol: tools/list includes _meta for receipt matcher ──

  describe('tools/list', () => {
    it('includes _meta.ui for gnubok_receipt_matcher', async () => {
      const res = await handleMcpRequest(mcpRequest('tools/list'))
      const result = await parseResult(res)

      const receiptTool = result.tools.find((t: { name: string }) => t.name === 'gnubok_receipt_matcher')
      expect(receiptTool).toBeDefined()
      expect(receiptTool._meta).toEqual({
        ui: { resourceUri: 'ui://receipt-matcher/app.html' },
      })
    })

    it('does not include _meta for read-only tools that neither stage nor render UI', async () => {
      const res = await handleMcpRequest(mcpRequest('tools/list'))
      const result = await parseResult(res)

      const listTool = result.tools.find(
        (t: { name: string }) => t.name === 'gnubok_list_customers'
      )
      expect(listTool).toBeDefined()
      expect(listTool._meta).toBeUndefined()
    })

    it('includes the derived staging contract in _meta for staging writes', async () => {
      const res = await handleMcpRequest(mcpRequest('tools/list'))
      const result = await parseResult(res)

      const categorizeTool = result.tools.find(
        (t: { name: string }) => t.name === 'gnubok_categorize_transaction'
      )
      expect(categorizeTool).toBeDefined()
      expect(categorizeTool._meta).toMatchObject({
        requires_approval: true,
        approve_tool: 'gnubok_approve_pending_operation',
      })
    })
  })

  // ── Protocol: resources/list ──

  describe('resources/list', () => {
    it('includes the receipt-matcher widget alongside data resources', async () => {
      const res = await handleMcpRequest(mcpRequest('resources/list'))
      const result = await parseResult(res)

      const widget = result.resources.find(
        (r: { uri: string }) => r.uri === 'ui://receipt-matcher/app.html'
      )
      expect(widget).toEqual({
        uri: 'ui://receipt-matcher/app.html',
        name: 'Receipt Matcher',
        description: 'Interactive widget for matching receipts to uncategorized transactions',
        mimeType: 'text/html;profile=mcp-app',
      })

      // Data resources (added in Stream 3 Phase 1) should also be listed.
      const uris = result.resources.map((r: { uri: string }) => r.uri)
      expect(uris).toContain('Accounted://company/current')
      expect(uris).toContain('Accounted://capabilities')
    })
  })

  // ── Protocol: resources/read ──

  describe('resources/read', () => {
    it('returns HTML for the receipt matcher', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://receipt-matcher/app.html' })
      )
      const result = await parseResult(res)

      expect(result.contents).toHaveLength(1)
      expect(result.contents[0].uri).toBe('ui://receipt-matcher/app.html')
      expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
      expect(result.contents[0].text).toContain('<!DOCTYPE html>')
      expect(result.contents[0].text).toContain('Kvittomatchning')
    })

    it('returns error for unknown resource URI', async () => {
      const res = await handleMcpRequest(
        mcpRequest('resources/read', { uri: 'ui://unknown/thing' })
      )
      const json = await res.json()

      expect(json.error).toBeDefined()
      expect(json.error.code).toBe(-32602)
      expect(json.error.message).toContain('Resource not found')
    })
  })

  // ── gnubok_receipt_matcher tool ──

  describe('gnubok_receipt_matcher', () => {
    it('returns uncategorized transactions with categories and vat_treatments', async () => {
      const tx1 = makeTransaction({ id: 'tx-1', description: 'ICA', amount: -150 })
      const tx2 = makeTransaction({ id: 'tx-2', description: 'Consulting', amount: 15000 })
      enqueueMany([
        { data: [tx1, tx2], error: null },
      ])

      const res = await handleMcpRequest(
        mcpRequest('tools/call', { name: 'gnubok_receipt_matcher', arguments: {} })
      )
      const result = await parseResult(res)

      // Should have structuredContent for MCP Apps
      expect(result.structuredContent).toBeDefined()
      expect(result.structuredContent.transactions).toHaveLength(2)
      expect(result.structuredContent.categories).toContain('expense_office')
      expect(result.structuredContent.vat_treatments).toContain('standard_25')

      // Should also have regular content
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
    })

    it('returns empty array when no uncategorized transactions', async () => {
      enqueueMany([{ data: [], error: null }])

      const res = await handleMcpRequest(
        mcpRequest('tools/call', { name: 'gnubok_receipt_matcher', arguments: {} })
      )
      const result = await parseResult(res)

      expect(result.structuredContent.transactions).toHaveLength(0)
    })
  })

  // ── gnubok_categorize_transaction still works after refactor ──

  describe('gnubok_categorize_transaction (staging)', () => {
    it('always stages the operation directly', async () => {
      const tx = makeTransaction({ id: 'tx-1', amount: -500 })

      enqueueMany([
        { data: tx, error: null },           // fetch transaction (preview)
        { data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null },
        { data: tx, error: null },            // fetch transaction for title
        { data: null, error: null },          // resolvePeriodStatusForDate: company_settings
        { data: null, error: null },          // resolvePeriodStatusForDate: fiscal_periods
        { data: { id: 'op-1' }, error: null }, // insert into pending_operations
      ])

      const res = await handleMcpRequest(
        mcpRequest('tools/call', {
          name: 'gnubok_categorize_transaction',
          arguments: { transaction_id: 'tx-1', category: 'expense_office' },
        })
      )
      const result = await parseResult(res)
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.staged).toBe(true)
      expect(parsed.operation_id).toBe('op-1')
      expect(parsed.message).toMatch(/staged/i)
      expect(parsed.preview).toBeDefined()
      expect(parsed.preview.debit_account).toBeDefined()
    })
  })

  // ── tools/call structuredContent ──

  describe('tools/call structuredContent', () => {
    it('includes structuredContent for tools with _meta.ui', async () => {
      enqueueMany([{ data: [], error: null }])

      const res = await handleMcpRequest(
        mcpRequest('tools/call', { name: 'gnubok_receipt_matcher', arguments: {} })
      )
      const result = await parseResult(res)

      expect(result.structuredContent).toBeDefined()
      expect(result.content).toBeDefined()
    })

    it('also includes structuredContent for regular tools (alongside the text content block)', async () => {
      const tx = makeTransaction({ id: 'tx-1', amount: -500 })
      enqueueMany([
        { data: tx, error: null },
        { data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null },
        { data: tx, error: null },            // fetch transaction for title
        { data: null, error: null },          // resolvePeriodStatusForDate: company_settings
        { data: null, error: null },          // resolvePeriodStatusForDate: fiscal_periods
        { data: { id: 'op-1' }, error: null }, // insert into pending_operations
      ])

      const res = await handleMcpRequest(
        mcpRequest('tools/call', {
          name: 'gnubok_categorize_transaction',
          arguments: { transaction_id: 'tx-1', category: 'expense_office' },
        })
      )
      const result = await parseResult(res)

      // Modern clients consume structuredContent directly when an outputSchema is declared.
      expect(result.structuredContent).toBeDefined()
      expect(result.structuredContent).toMatchObject({ staged: true })
      expect(result.content).toBeDefined()
    })
  })
})
