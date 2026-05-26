/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { generateFullArchive, estimateArchiveSize } from '../full-archive-export'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getAuditLog } from '@/lib/core/audit/audit-service'

vi.mock('../sie-export', () => ({
  generateSIEExport: vi.fn().mockResolvedValue('#FLAGGA 0\n#PROGRAM "ERPBase"'),
}))

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn().mockResolvedValue({
    rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true,
  }),
}))

vi.mock('../income-statement', () => ({
  generateIncomeStatement: vi.fn().mockResolvedValue({
    sections: [], netResult: 0, period: { start: '2024-01-01', end: '2024-12-31' },
  }),
}))

vi.mock('../balance-sheet', () => ({
  generateBalanceSheet: vi.fn().mockResolvedValue({
    asset_sections: [], equity_liability_sections: [],
    total_assets: 0, total_equity_liabilities: 0,
    period: { start: '2024-01-01', end: '2024-12-31' },
  }),
}))

vi.mock('../general-ledger', () => ({
  generateGeneralLedger: vi.fn().mockResolvedValue({
    accounts: [], period: { start: '2024-01-01', end: '2024-12-31' },
  }),
}))

vi.mock('../journal-register', () => ({
  generateJournalRegister: vi.fn().mockResolvedValue({
    entries: [], total_entries: 0, total_debit: 0, total_credit: 0,
    period: { start: '2024-01-01', end: '2024-12-31' },
  }),
}))

vi.mock('../vat-declaration', () => ({
  calculateVatDeclaration: vi.fn().mockResolvedValue({
    period: { type: 'yearly', year: 2024, period: 1, start: '2024-01-01', end: '2024-12-31' },
    rutor: {
      ruta05: 0, ruta06: 0, ruta07: 0,
      ruta10: 0, ruta11: 0, ruta12: 0,
      ruta39: 0, ruta40: 0, ruta48: 0, ruta49: 0,
    },
    invoiceCount: 0, transactionCount: 0,
    breakdown: {
      invoices: { ruta05: 0, ruta06: 0, ruta07: 0, ruta10: 0, ruta11: 0, ruta12: 0, ruta39: 0, ruta40: 0, base25: 0, base12: 0, base6: 0 },
      transactions: { ruta48: 0 },
      receipts: { ruta48: 0 },
    },
  }),
}))

vi.mock('@/lib/core/audit/audit-service', () => ({
  getAuditLog: vi.fn().mockResolvedValue({ data: [], count: 0 }),
}))

const mockGetAuditLog = vi.mocked(getAuditLog)

const COMPANY_ROW = {
  company_name: 'Test AB',
  org_number: '5566778899',
  moms_period: 'quarterly',
}

const PERIOD_2024 = {
  id: 'period-2024',
  period_start: '2024-01-01',
  period_end: '2024-12-31',
  opening_balance_entry_id: null,
}

const PERIOD_2023 = {
  id: 'period-2023',
  period_start: '2023-01-01',
  period_end: '2023-12-31',
  opening_balance_entry_id: null,
}

describe('generateFullArchive', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuditLog.mockResolvedValue({ data: [], count: 0 })
    const mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
  })

  describe('scope: period', () => {
    it('generates a ZIP with expected file structure', async () => {
      enqueueMany([
        { data: COMPANY_ROW }, // company_settings
        { data: PERIOD_2024 }, // fiscal_periods (single)
        { data: [] }, // document_attachments
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
      })

      const zip = await JSZip.loadAsync(buffer)

      expect(zip.file('bokforing.se')).not.toBeNull()
      expect(zip.file('rapporter/saldobalans.json')).not.toBeNull()
      expect(zip.file('rapporter/resultatrakning.json')).not.toBeNull()
      expect(zip.file('rapporter/balansrakning.json')).not.toBeNull()
      expect(zip.file('rapporter/huvudbok.json')).not.toBeNull()
      expect(zip.file('rapporter/grundbok.json')).not.toBeNull()
      expect(zip.file('rapporter/momsdeklaration.json')).not.toBeNull()
      expect(zip.file('dokument/manifest.json')).not.toBeNull()
      expect(zip.file('revision/behandlingshistorik.json')).not.toBeNull()
      expect(zip.file('revision/systemdokumentation.json')).not.toBeNull()
    })

    it('handles missing documents gracefully', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: PERIOD_2024 },
        {
          data: [
            {
              id: 'doc-1',
              file_name: 'receipt.pdf',
              storage_path: 'documents/user-1/receipt.pdf',
              journal_entry_id: 'entry-1',
              journal_entries: {
                voucher_number: 17,
                voucher_series: 'A',
                entry_date: '2024-03-15',
              },
            },
          ],
        },
        { data: [{ id: 'entry-1', fiscal_period_id: PERIOD_2024.id }] },
      ])

      supabase.storage.from = vi.fn().mockReturnValue({
        download: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'File not found' },
        }),
      })

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
      })

      const zip = await JSZip.loadAsync(buffer)
      const manifestFile = zip.file('dokument/manifest.json')
      expect(manifestFile).not.toBeNull()

      const manifest = JSON.parse(await manifestFile!.async('text'))
      expect(manifest).toHaveLength(1)
      expect(manifest[0].status).toBe('error')
      expect(manifest[0].error).toBe('File not found')
      expect(manifest[0].fiscal_period_id).toBe(PERIOD_2024.id)
      // New manifest fields populated even on error (path is computed before download)
      expect(manifest[0].voucher_number).toBe('A17')
      expect(manifest[0].entry_date).toBe('2024-03-15')
      expect(manifest[0].zip_path).toBe('dokument/2024/A17_receipt.pdf')
    })

    it('skips documents when include_documents is false', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: PERIOD_2024 },
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
        include_documents: false,
      })

      const zip = await JSZip.loadAsync(buffer)

      expect(zip.file('dokument/manifest.json')).toBeNull()
      expect(zip.file('bokforing.se')).not.toBeNull()
      expect(zip.file('revision/behandlingshistorik.json')).not.toBeNull()
    })

    it('throws when fiscal period not found', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: null },
      ])

      await expect(
        generateFullArchive(supabase as any, 'company-1', {
          scope: 'period',
          period_id: 'nonexistent',
        })
      ).rejects.toThrow('Fiscal period not found')
    })

    it('filters audit trail by period dates', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: PERIOD_2024 },
        { data: [] },
      ])

      await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
      })

      expect(mockGetAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        expect.objectContaining({
          from_date: PERIOD_2024.period_start,
          to_date: `${PERIOD_2024.period_end}T23:59:59.999Z`,
        })
      )
    })
  })

  describe('scope: all', () => {
    it('generates per-period SIE files and report subfolders', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2023, PERIOD_2024] }, // fiscal_periods (list for fetchAllPeriods)
        { data: [] }, // document_attachments
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })

      const zip = await JSZip.loadAsync(buffer)

      expect(zip.file('sie/2023-01-01_2023-12-31.se')).not.toBeNull()
      expect(zip.file('sie/2024-01-01_2024-12-31.se')).not.toBeNull()
      expect(zip.file('rapporter/2023-01-01_2023-12-31/saldobalans.json')).not.toBeNull()
      expect(zip.file('rapporter/2024-01-01_2024-12-31/saldobalans.json')).not.toBeNull()
      expect(zip.file('revision/behandlingshistorik.json')).not.toBeNull()
      expect(zip.file('revision/systemdokumentation.json')).not.toBeNull()
      // No root bokforing.se in all-mode
      expect(zip.file('bokforing.se')).toBeNull()
    })

    it('does not filter audit trail by date in all-mode', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        { data: [] },
      ])

      await generateFullArchive(supabase as any, 'company-1', { scope: 'all' })

      const call = mockGetAuditLog.mock.calls[0]
      expect(call[2]).not.toHaveProperty('from_date')
      expect(call[2]).not.toHaveProperty('to_date')
    })

    it('tags each document with its fiscal_period_id across periods', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2023, PERIOD_2024] },
        {
          data: [
            {
              id: 'doc-2023',
              file_name: 'r23.pdf',
              storage_path: 'p/r23.pdf',
              journal_entry_id: 'e-2023',
              journal_entries: { voucher_number: 7, voucher_series: 'A', entry_date: '2023-06-01' },
            },
            {
              id: 'doc-2024',
              file_name: 'r24.pdf',
              storage_path: 'p/r24.pdf',
              journal_entry_id: 'e-2024',
              journal_entries: { voucher_number: 12, voucher_series: 'B', entry_date: '2024-08-20' },
            },
          ],
        },
        {
          data: [
            { id: 'e-2023', fiscal_period_id: PERIOD_2023.id },
            { id: 'e-2024', fiscal_period_id: PERIOD_2024.id },
          ],
        },
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })

      const zip = await JSZip.loadAsync(buffer)
      const manifestFile = zip.file('dokument/manifest.json')
      expect(manifestFile).not.toBeNull()

      const manifest = JSON.parse(await manifestFile!.async('text'))
      expect(manifest).toHaveLength(2)
      const byId = Object.fromEntries(
        (
          manifest as Array<{
            document_id: string
            fiscal_period_id: string | null
            voucher_number: string | null
            zip_path: string | null
          }>
        ).map((m) => [m.document_id, m])
      )
      expect(byId['doc-2023'].fiscal_period_id).toBe(PERIOD_2023.id)
      expect(byId['doc-2024'].fiscal_period_id).toBe(PERIOD_2024.id)
      expect(byId['doc-2023'].voucher_number).toBe('A7')
      expect(byId['doc-2024'].voucher_number).toBe('B12')
      expect(byId['doc-2023'].zip_path).toBe('dokument/2023/A7_r23.pdf')
      expect(byId['doc-2024'].zip_path).toBe('dokument/2024/B12_r24.pdf')

      // Files actually written under the new path
      expect(zip.file('dokument/2023/A7_r23.pdf')).not.toBeNull()
      expect(zip.file('dokument/2024/B12_r24.pdf')).not.toBeNull()
    })

    it('routes draft entries and orphans to dokument/_okopplade and disambiguates collisions', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        {
          data: [
            // Draft entry — journal_entry_id present but voucher_number is null
            {
              id: 'doc-draft',
              file_name: 'invoice.pdf',
              storage_path: 'p/invoice.pdf',
              journal_entry_id: 'e-draft',
              journal_entries: { voucher_number: null, voucher_series: 'A', entry_date: null },
            },
            // Two posted docs that collide on the same voucher+filename
            {
              id: 'doc-collide-1234abcd-ee',
              file_name: 'kvitto.pdf',
              storage_path: 'p/kvitto-1.pdf',
              journal_entry_id: 'e-posted',
              journal_entries: { voucher_number: 5, voucher_series: 'A', entry_date: '2024-05-01' },
            },
            {
              id: 'doc-collide-5678efgh-ff',
              file_name: 'kvitto.pdf',
              storage_path: 'p/kvitto-2.pdf',
              journal_entry_id: 'e-posted',
              journal_entries: { voucher_number: 5, voucher_series: 'A', entry_date: '2024-05-01' },
            },
          ],
        },
        // entryIdToPeriodId map — draft and posted both resolve to PERIOD_2024
        {
          data: [
            { id: 'e-draft', fiscal_period_id: PERIOD_2024.id },
            { id: 'e-posted', fiscal_period_id: PERIOD_2024.id },
          ],
        },
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })

      const zip = await JSZip.loadAsync(buffer)
      const manifest = JSON.parse(await zip.file('dokument/manifest.json')!.async('text')) as Array<{
        document_id: string
        voucher_number: string | null
        zip_path: string | null
      }>
      const byId = Object.fromEntries(manifest.map((m) => [m.document_id, m]))

      // Draft -> _okopplade, no voucher prefix
      expect(byId['doc-draft'].voucher_number).toBeNull()
      expect(byId['doc-draft'].zip_path).toBe('dokument/_okopplade/invoice.pdf')

      // First posted doc gets the canonical path
      expect(byId['doc-collide-1234abcd-ee'].zip_path).toBe('dokument/2024/A5_kvitto.pdf')
      // Second posted doc gets the id-suffix disambiguation before the extension
      expect(byId['doc-collide-5678efgh-ff'].zip_path).toBe(
        'dokument/2024/A5_kvitto_doc-coll.pdf'
      )

      // Both files exist in the ZIP
      expect(zip.file('dokument/_okopplade/invoice.pdf')).not.toBeNull()
      expect(zip.file('dokument/2024/A5_kvitto.pdf')).not.toBeNull()
      expect(zip.file('dokument/2024/A5_kvitto_doc-coll.pdf')).not.toBeNull()
    })

    it('throws when no fiscal periods exist', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [] },
      ])

      await expect(
        generateFullArchive(supabase as any, 'company-1', { scope: 'all' })
      ).rejects.toThrow('No fiscal periods found')
    })

    it('includes imported SIE source files and master-data dumps in all-mode', async () => {
      const importRow = {
        id: 'import-1',
        filename: 'original.se',
        file_hash: 'abc123',
        file_storage_path: 'company-1/import-1.se',
        org_number: '5560000000',
        company_name: 'Test AB',
        sie_type: 4,
        fiscal_year_start: '2024-01-01',
        fiscal_year_end: '2024-12-31',
        accounts_count: 42,
        transactions_count: 120,
        status: 'completed',
        fiscal_period_id: PERIOD_2024.id,
        imported_at: '2024-11-01T10:00:00Z',
        created_at: '2024-11-01T09:55:00Z',
      }

      enqueueMany([
        { data: COMPANY_ROW }, // fetchCompany
        { data: [PERIOD_2024] }, // fetchAllPeriods
        { data: [] }, // document_attachments
        { data: [importRow] }, // sie_imports
        { data: [{ source_account: '9999', target_account: '1510' }] }, // sie_account_mappings
        { data: [{ id: 'cust-1', name: 'Acme AB' }] }, // customers
        { data: [{ id: 'sup-1', name: 'Supplier AB' }] }, // suppliers
        { data: [{ id: 'inv-1', invoice_number: 'F-001' }] }, // invoices
        { data: [] }, // invoice_items
        { data: [] }, // invoice_payments
        { data: [] }, // supplier_invoices
        { data: [] }, // supplier_invoice_items
        { data: [] }, // receipts
        { data: [] }, // receipt_line_items
        { data: [] }, // transactions
        { data: [] }, // mapping_rules
        { data: [] }, // categorization_templates
        { data: [] }, // bank_file_imports
        { data: [COMPANY_ROW] }, // company_settings
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })
      const zip = await JSZip.loadAsync(buffer)

      const originalFile = zip.file('sie/original/import-1_original.se')
      expect(originalFile).not.toBeNull()

      const manifestFile = zip.file('sie/original/manifest.json')
      expect(manifestFile).not.toBeNull()
      const manifest = JSON.parse(await manifestFile!.async('text'))
      expect(manifest[0].import_id).toBe('import-1')
      expect(manifest[0].status).toBe('downloaded')

      const imports = JSON.parse(await zip.file('sie/imports.json')!.async('text'))
      expect(imports[0].filename).toBe('original.se')
      expect(zip.file('sie/account_mappings.json')).not.toBeNull()

      expect(zip.file('data/customers.json')).not.toBeNull()
      expect(zip.file('data/suppliers.json')).not.toBeNull()
      expect(zip.file('data/invoices.json')).not.toBeNull()
      expect(zip.file('data/invoice_items.json')).not.toBeNull()
      expect(zip.file('data/invoice_payments.json')).not.toBeNull()
      expect(zip.file('data/supplier_invoices.json')).not.toBeNull()
      expect(zip.file('data/supplier_invoice_items.json')).not.toBeNull()
      expect(zip.file('data/receipts.json')).not.toBeNull()
      expect(zip.file('data/receipt_line_items.json')).not.toBeNull()
      expect(zip.file('data/transactions.json')).not.toBeNull()
      expect(zip.file('data/mapping_rules.json')).not.toBeNull()
      expect(zip.file('data/categorization_templates.json')).not.toBeNull()
      expect(zip.file('data/bank_file_imports.json')).not.toBeNull()
      expect(zip.file('data/company_settings.json')).not.toBeNull()

      const customers = JSON.parse(await zip.file('data/customers.json')!.async('text'))
      expect(customers).toEqual([{ id: 'cust-1', name: 'Acme AB' }])
    })

    it('skips raw SIE blobs when include_documents is false but keeps metadata', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        {
          data: [
            {
              id: 'import-1',
              filename: 'x.se',
              file_hash: 'h',
              file_storage_path: 'company-1/import-1.se',
              status: 'completed',
              imported_at: '2024-11-01T10:00:00Z',
              created_at: '2024-11-01T09:55:00Z',
            },
          ],
        }, // sie_imports
        { data: [] }, // sie_account_mappings
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
        include_documents: false,
      })
      const zip = await JSZip.loadAsync(buffer)

      expect(zip.file('sie/imports.json')).not.toBeNull()
      expect(zip.file('sie/account_mappings.json')).not.toBeNull()
      expect(zip.file('sie/original/import-1_x.se')).toBeNull()
      expect(zip.file('sie/original/manifest.json')).toBeNull()
      expect(zip.file('data/customers.json')).not.toBeNull()
    })
  })
})

describe('estimateArchiveSize', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
  })

  it('sums document file_size_bytes in all-mode plus overhead', async () => {
    enqueueMany([
      {
        data: [
          { file_size_bytes: 1_000_000, journal_entry_id: 'e1' },
          { file_size_bytes: 2_500_000, journal_entry_id: 'e2' },
        ],
        count: 2,
      },
    ])

    const result = await estimateArchiveSize(supabase as any, 'company-1', 'all')

    expect(result.document_bytes).toBe(3_500_000)
    expect(result.document_count).toBe(2)
    // overhead is +8 MB
    expect(result.total_bytes).toBe(3_500_000 + 8 * 1024 * 1024)
  })

  it('returns overhead only when no documents in scope', async () => {
    enqueueMany([
      { data: [], count: 0 }, // journal_entries for periodEntryIds
      { data: [], count: 0 }, // document_attachments
    ])

    const result = await estimateArchiveSize(supabase as any, 'company-1', 'period', 'p-1')

    expect(result.document_bytes).toBe(0)
    expect(result.document_count).toBe(0)
    expect(result.total_bytes).toBe(8 * 1024 * 1024)
  })
})
