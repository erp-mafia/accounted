/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import {
  generateFullArchive,
  generateBaseDataArchive,
  estimateArchiveSize,
  MASTER_DATA_DUMP_TABLES,
} from '../full-archive-export'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getAuditLog } from '@/lib/core/audit/audit-service'
import type { AuditLogEntry } from '@/types'

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
    revenue_sections: [], total_revenue: 0,
    expense_sections: [], total_expenses: 0,
    financial_sections: [], total_financial: 0,
    net_result: 0, period: { start: '2024-01-01', end: '2024-12-31' },
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

// The bilagor step reads account_reconciliation_attachments through the
// store; an empty list keeps the queued-mock order of these tests intact.
vi.mock('@/lib/reconciliation/attachments-store', () => ({
  listAttachmentRowsInRange: vi.fn().mockResolvedValue([]),
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

/**
 * Queue one mock response per query writeMasterData issues, in order.
 *
 * Direct tables issue a single query; via-tables issue a parent-id query and,
 * only when parents exist, one chunked child query. Tables not named in
 * `opts` come back empty.
 */
function buildMasterDataQueue(opts: {
  direct?: Record<string, unknown[]>
  via?: Record<string, { parents: unknown[]; children: unknown[] }>
}): { data: unknown }[] {
  return MASTER_DATA_DUMP_TABLES.flatMap((t): { data: unknown }[] => {
    if (t.via) {
      const spec = opts.via?.[t.name]
      if (!spec || spec.parents.length === 0) return [{ data: [] }]
      return [{ data: spec.parents }, { data: spec.children }]
    }
    return [{ data: opts.direct?.[t.name] ?? [] }]
  })
}

describe('generateFullArchive', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']
  let findCall: ReturnType<typeof createQueuedMockSupabase>['findCall']

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuditLog.mockResolvedValue({ data: [], count: 0 })
    const mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
    findCall = mock.findCall
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
      // Human-readable layer: CSV twins + the Swedish README.
      expect(zip.file('rapporter/saldobalans.csv')).not.toBeNull()
      expect(zip.file('rapporter/resultatrakning.csv')).not.toBeNull()
      expect(zip.file('rapporter/balansrakning.csv')).not.toBeNull()
      expect(zip.file('rapporter/huvudbok.csv')).not.toBeNull()
      const readme = zip.file('LÄSMIG.txt')
      expect(readme).not.toBeNull()
      const readmeText = await readme!.async('text')
      expect(readmeText).toContain('Test AB')
      expect(readmeText).toContain('Räkenskapsår')
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

    it('falls back to the company-scoped key when the stored pointer is stale', async () => {
      // A concurrent Phase B backfill re-homed the object mid-run: the
      // legacy pointer 404s but the company-scoped copy exists. The archive
      // must contain the bytes, not a manifest error.
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

      const download = vi.fn(async (path: string) =>
        path === 'documents/company-1/user-1/receipt.pdf'
          ? { data: new Blob(['receipt bytes']), error: null }
          : { data: null, error: { message: 'Object not found' } },
      )
      supabase.storage.from = vi.fn().mockReturnValue({ download })

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
      })

      const zip = await JSZip.loadAsync(buffer)
      const manifest = JSON.parse(await zip.file('dokument/manifest.json')!.async('text'))
      expect(manifest).toHaveLength(1)
      expect(manifest[0].status).toBe('downloaded')
      expect(zip.file('dokument/2024/A17_receipt.pdf')).not.toBeNull()
      // Stored pointer first, alternate layout second.
      expect(download).toHaveBeenNthCalledWith(1, 'documents/user-1/receipt.pdf')
      expect(download).toHaveBeenNthCalledWith(2, 'documents/company-1/user-1/receipt.pdf')
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

    it("includes audit rows for the period's entries booked outside the window", async () => {
      // Bokslut reality: the FY2024 year-end entry is committed in March 2025,
      // so its audit rows fall outside the period's date window. The year's
      // archive must still carry them (BFNAR 2013:2 kap 8).
      const inWindow: AuditLogEntry = {
        id: 'audit-1',
        user_id: 'user-1',
        company_id: 'company-1',
        action: 'INSERT',
        table_name: 'journal_entries',
        record_id: 'e-1',
        actor_id: 'user-1',
        actor_type: null,
        actor_label: null,
        old_state: null,
        new_state: null,
        description: 'Created journal_entries record',
        created_at: '2024-06-01T10:00:00Z',
      }
      const outOfWindowCommit: AuditLogEntry = {
        ...inWindow,
        id: 'audit-2',
        action: 'COMMIT',
        description: 'Committed journal entry A55',
        created_at: '2025-03-15T09:00:00Z',
      }
      // Line audit rows carry company_id NULL (write_audit_log finds no
      // company_id column on journal_entry_lines).
      const lineRow: AuditLogEntry = {
        ...inWindow,
        id: 'audit-3',
        company_id: null,
        table_name: 'journal_entry_lines',
        record_id: 'l-1',
        created_at: '2025-03-15T09:00:01Z',
      }

      mockGetAuditLog.mockResolvedValue({ data: [inWindow], count: 1 })

      enqueueMany([
        { data: COMPANY_ROW }, // company_settings
        { data: PERIOD_2024 }, // fiscal_periods
        { data: [] }, // document_attachments
        { data: [{ id: 'e-1' }] }, // journal_entries ids for the period
        { data: [{ id: 'l-1' }] }, // journal_entry_lines ids
        // audit_log by record id: returns the in-window row again (dedupe)
        // plus the two out-of-window rows
        { data: [inWindow, outOfWindowCommit, lineRow] },
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'period',
        period_id: PERIOD_2024.id,
      })

      const zip = await JSZip.loadAsync(buffer)
      const history = JSON.parse(
        await zip.file('revision/behandlingshistorik.json')!.async('text')
      ) as Array<{ id: string }>

      // Deduped: audit-1 appears once despite arriving via both fetches.
      expect(history).toHaveLength(3)
      const ids = history.map((h) => h.id)
      expect(ids).toContain('audit-2')
      expect(ids).toContain('audit-3')
      // Newest first, matching getAuditLog's output order.
      expect(ids[0]).toBe('audit-3')
      expect(ids[2]).toBe('audit-1')
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
      expect(zip.file('rapporter/2024-01-01_2024-12-31/saldobalans.csv')).not.toBeNull()
      expect(zip.file('rapporter/2024-01-01_2024-12-31/huvudbok.csv')).not.toBeNull()
      expect(zip.file('revision/behandlingshistorik.json')).not.toBeNull()
      expect(zip.file('revision/systemdokumentation.json')).not.toBeNull()
      const readmeText = await zip.file('LÄSMIG.txt')!.async('text')
      expect(readmeText).toContain('Hela bokföringen')
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
            // True orphan: uploaded but never linked to any entry. Backups
            // must still carry it (inbox items are räkenskapsinformation).
            {
              id: 'doc-orphan',
              file_name: 'inbox.pdf',
              storage_path: 'p/inbox.pdf',
              journal_entry_id: null,
              journal_entries: null,
            },
            // Draft entry: journal_entry_id present but voucher_number is null
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
        // entryIdToPeriodId map: draft and posted both resolve to PERIOD_2024
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

      // Unlinked orphan -> _okopplade, included in the backup
      expect(byId['doc-orphan'].voucher_number).toBeNull()
      expect(byId['doc-orphan'].zip_path).toBe('dokument/_okopplade/inbox.pdf')

      // Draft -> _okopplade, no voucher prefix
      expect(byId['doc-draft'].voucher_number).toBeNull()
      expect(byId['doc-draft'].zip_path).toBe('dokument/_okopplade/invoice.pdf')

      // First posted doc gets the canonical path
      expect(byId['doc-collide-1234abcd-ee'].zip_path).toBe('dokument/2024/A5_kvitto.pdf')
      // Second posted doc gets the id-suffix disambiguation before the extension
      expect(byId['doc-collide-5678efgh-ff'].zip_path).toBe(
        'dokument/2024/A5_kvitto_doc-coll.pdf'
      )

      // All files exist in the ZIP
      expect(zip.file('dokument/_okopplade/inbox.pdf')).not.toBeNull()
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

      // Master-data dump runs sequentially over MASTER_DATA_DUMP_TABLES.
      // Direct tables issue one query; via-tables issue a parent-id query and,
      // when parents exist, one chunked child query.
      const masterDataQueue = buildMasterDataQueue({
        direct: {
          customers: [{ id: 'cust-1', name: 'Acme AB' }],
          company_settings: [COMPANY_ROW],
        },
        via: {
          invoice_items: {
            parents: [{ id: 'inv-1', currency: 'SEK', exchange_rate: null }],
            children: [{ id: 'item-1', invoice_id: 'inv-1', description: 'Konsulttid' }],
          },
        },
      })

      enqueueMany([
        { data: COMPANY_ROW }, // fetchCompany
        { data: [PERIOD_2024] }, // fetchAllPeriods
        { data: [] }, // document_attachments
        { data: [importRow] }, // sie_imports
        { data: [{ source_account: '9999', target_account: '1510' }] }, // sie_account_mappings
        ...masterDataQueue,
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

      // Every table in the dump contract gets a file, even when empty.
      for (const t of MASTER_DATA_DUMP_TABLES) {
        expect(zip.file(`data/${t.file}`), `data/${t.file}`).not.toBeNull()
      }

      const customers = JSON.parse(await zip.file('data/customers.json')!.async('text'))
      expect(customers).toEqual([{ id: 'cust-1', name: 'Acme AB' }])

      // Child table fetched via parent ids (invoice_items has no company_id).
      // A SEK company's rows are unchanged apart from the appended unit.
      const items = JSON.parse(await zip.file('data/invoice_items.json')!.async('text'))
      expect(items).toEqual([
        {
          id: 'item-1',
          invoice_id: 'inv-1',
          description: 'Konsulttid',
          invoice_currency: 'SEK',
          invoice_exchange_rate: null,
        },
      ])
      expect(supabase.rpc).toHaveBeenCalledWith(
        'export_invoice_delivery_evidence',
        { p_company_id: 'company-1' },
      )
    })

    it('makes a foreign-currency invoice line readable without joining the parent', async () => {
      // A revisor opening data/invoice_items.json must be able to tell that
      // line_total 1000 is EUR, not SEK. The row's own `unit` column says
      // "st" (the quantity unit), so nothing in the file used to state the
      // money unit: it was only recoverable by joining data/invoices.json.
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        { data: [] }, // document_attachments
        { data: [] }, // sie_imports
        { data: [] }, // sie_account_mappings
        ...buildMasterDataQueue({
          via: {
            invoice_items: {
              parents: [
                { id: 'inv-eur', currency: 'EUR', exchange_rate: 11.23 },
                { id: 'inv-sek', currency: 'SEK', exchange_rate: null },
              ],
              children: [
                {
                  id: 'item-eur',
                  invoice_id: 'inv-eur',
                  description: 'Konsulttid',
                  quantity: 10,
                  unit: 'st',
                  unit_price: 100,
                  line_total: 1000,
                  vat_amount: 250,
                },
                {
                  id: 'item-sek',
                  invoice_id: 'inv-sek',
                  description: 'Support',
                  line_total: 500,
                  vat_amount: 125,
                },
              ],
            },
          },
        }),
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })
      const zip = await JSZip.loadAsync(buffer)
      const items = JSON.parse(
        await zip.file('data/invoice_items.json')!.async('text')
      ) as Array<Record<string, unknown>>

      const byId = Object.fromEntries(items.map((i) => [i.id as string, i]))
      expect(byId['item-eur'].invoice_currency).toBe('EUR')
      expect(byId['item-eur'].invoice_exchange_rate).toBe(11.23)
      // The SEK line says SEK explicitly rather than leaving it implied.
      expect(byId['item-sek'].invoice_currency).toBe('SEK')
      expect(byId['item-sek'].invoice_exchange_rate).toBeNull()

      // Every money-bearing row states its unit: no row is ambiguous.
      for (const item of items) {
        expect(item, `row ${item.id} has no unit`).toHaveProperty('invoice_currency')
        expect(item.invoice_currency).not.toBeNull()
      }

      // Additive: the row keeps every column it shipped with before, and the
      // unit is appended rather than replacing anything.
      expect(byId['item-eur']).toMatchObject({
        id: 'item-eur',
        invoice_id: 'inv-eur',
        description: 'Konsulttid',
        quantity: 10,
        unit: 'st',
        unit_price: 100,
        line_total: 1000,
        vat_amount: 250,
      })
    })

    it('carries the unit on supplier invoice lines and receipt lines too', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        { data: [] }, // document_attachments
        { data: [] }, // sie_imports
        { data: [] }, // sie_account_mappings
        ...buildMasterDataQueue({
          via: {
            supplier_invoice_items: {
              parents: [{ id: 'sinv-1', currency: 'USD', exchange_rate: 9.87 }],
              children: [
                { id: 'sitem-1', supplier_invoice_id: 'sinv-1', line_total: 200 },
              ],
            },
            // receipts has no exchange_rate column: currency alone.
            receipt_line_items: {
              parents: [{ id: 'rec-1', currency: 'NOK' }],
              children: [{ id: 'rline-1', receipt_id: 'rec-1', line_total: 49 }],
            },
          },
        }),
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })
      const zip = await JSZip.loadAsync(buffer)

      const supplierItems = JSON.parse(
        await zip.file('data/supplier_invoice_items.json')!.async('text')
      )
      expect(supplierItems[0].supplier_invoice_currency).toBe('USD')
      expect(supplierItems[0].supplier_invoice_exchange_rate).toBe(9.87)

      const receiptLines = JSON.parse(
        await zip.file('data/receipt_line_items.json')!.async('text')
      )
      expect(receiptLines[0].receipt_currency).toBe('NOK')
      expect(receiptLines[0]).not.toHaveProperty('receipt_exchange_rate')
    })

    it('does not invent a unit for rot/rut payout items (parent has no currency)', async () => {
      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        { data: [] }, // document_attachments
        { data: [] }, // sie_imports
        { data: [] }, // sie_account_mappings
        ...buildMasterDataQueue({
          via: {
            rot_rut_payout_request_items: {
              parents: [{ id: 'req-1' }],
              children: [
                { id: 'ritem-1', request_id: 'req-1', requested_amount: 5000 },
              ],
            },
          },
        }),
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })
      const zip = await JSZip.loadAsync(buffer)
      const rows = JSON.parse(
        await zip.file('data/rot_rut_payout_request_items.json')!.async('text')
      )

      // HUS-avdrag is SEK by statute and the parent carries no currency
      // column, so there is nothing to copy: the row stays as the DB has it.
      expect(rows).toEqual([
        { id: 'ritem-1', request_id: 'req-1', requested_amount: 5000 },
      ])
    })

    // The archive is what a company leaving Accounted keeps as its BFL
    // 7-year record. A representation answer given in chat is documented in
    // full only in invoice_inbox_items.channel_context: the verifikat line
    // caps at 220 chars and drops whole names ("… och N till"), while
    // Skatteverket wants every deltagare. So the answers must be exported.
    it('exports the chat answers behind a verifikat, in full', async () => {
      const participants = Array.from({ length: 10 }, (_, i) => ({
        name: `Deltagare Efternamnsson ${i + 1}`,
        company: 'Företagsnamnet Aktiebolag',
      }))
      const inboxRow = {
        id: 'inbox-1',
        created_at: '2024-06-01T10:00:00Z',
        source: 'whatsapp',
        status: 'confirmed',
        document_id: 'doc-1',
        matched_transaction_id: 'tx-1',
        created_journal_entry_id: 'je-1',
        created_supplier_invoice_id: null,
        channel_context: {
          channel: 'whatsapp',
          representation: {
            participants,
            purpose: 'avtalsförhandling',
            event_date: '2024-06-01',
            raw_answer: 'tio personer, avtalsförhandling',
            answered_at: '2024-06-01T18:00:00Z',
          },
        },
      }

      enqueueMany([
        { data: COMPANY_ROW },
        { data: [PERIOD_2024] },
        { data: [] }, // document_attachments
        { data: [] }, // sie_imports
        { data: [] }, // sie_account_mappings
        ...buildMasterDataQueue({ direct: { invoice_inbox_items: [inboxRow] } }),
      ])

      const buffer = await generateFullArchive(supabase as any, 'company-1', {
        scope: 'all',
      })
      const zip = await JSZip.loadAsync(buffer)
      const rows = JSON.parse(
        await zip.file('data/invoice_inbox_items.json')!.async('text')
      ) as Array<Record<string, any>>

      // Every deltagare survives, not the three that fit on the verifikat line.
      expect(rows[0].channel_context.representation.participants).toHaveLength(10)
      expect(rows[0].channel_context.representation.raw_answer).toBe(
        'tio personer, avtalsförhandling'
      )
      // Tied to what was booked from it, so a revisor can find the verifikat.
      expect(rows[0].created_journal_entry_id).toBe('je-1')

      // A projection, not the whole row: inbox workflow state (email bodies,
      // OCR output, error messages) stays out of the archive.
      const select = findCall('invoice_inbox_items', 'select')?.[0] as string
      expect(select).toContain('channel_context')
      expect(select).toContain('created_journal_entry_id')
      expect(select).not.toContain('email_body_text')
      expect(select).not.toContain('extracted_data')
      expect(select).not.toBe('*')
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

describe('generateBaseDataArchive', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAuditLog.mockResolvedValue({ data: [], count: 0 })
    const mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
  })

  it('bundles unlinked documents, master data, SIE sources and the audit trail', async () => {
    const masterDataQueue = buildMasterDataQueue({
      direct: { customers: [{ id: 'cust-1', name: 'Acme AB' }] },
    })

    enqueueMany([
      { data: COMPANY_ROW }, // fetchCompany
      { data: [PERIOD_2024] }, // fetchAllPeriods
      {
        data: [
          // Orphan: goes into Grunddata.
          {
            id: 'doc-orphan',
            file_name: 'inbox.pdf',
            storage_path: 'p/inbox.pdf',
            journal_entry_id: null,
            journal_entries: null,
          },
          // Linked to a posted entry: belongs to the period archive, not here.
          {
            id: 'doc-linked',
            file_name: 'kvitto.pdf',
            storage_path: 'p/kvitto.pdf',
            journal_entry_id: 'e-1',
            journal_entries: { voucher_number: 5, voucher_series: 'A', entry_date: '2024-05-01' },
          },
        ],
      }, // document_attachments
      { data: [{ id: 'e-1', fiscal_period_id: PERIOD_2024.id }] }, // entry->period map
      { data: [] }, // sie_imports
      { data: [] }, // sie_account_mappings
      ...masterDataQueue,
    ])

    const buffer = await generateBaseDataArchive(supabase as any, 'company-1')
    const zip = await JSZip.loadAsync(buffer)

    const manifest = JSON.parse(await zip.file('dokument/manifest.json')!.async('text'))
    expect(manifest).toHaveLength(1)
    expect(manifest[0].document_id).toBe('doc-orphan')
    expect(zip.file('dokument/_okopplade/inbox.pdf')).not.toBeNull()

    expect(zip.file('data/customers.json')).not.toBeNull()
    expect(zip.file('sie/imports.json')).not.toBeNull()
    expect(zip.file('revision/behandlingshistorik.json')).not.toBeNull()
    expect(zip.file('revision/systemdokumentation.json')).not.toBeNull()

    const readme = await zip.file('LÄSMIG.txt')!.async('text')
    expect(readme).toContain('Grunddata')
    // Period-scoped content stays out of Grunddata.
    expect(zip.file('bokforing.se')).toBeNull()
    expect(zip.file('rapporter/saldobalans.json')).toBeNull()
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

  it('paginates the all-mode document read past the page cap', async () => {
    const firstPage = Array.from({ length: 1000 }, () => ({ file_size_bytes: 1_000 }))
    enqueueMany([
      { data: firstPage }, // full first page forces a second fetch
      { data: [{ file_size_bytes: 1_000 }] },
    ])

    const result = await estimateArchiveSize(supabase as any, 'company-1', 'all')

    expect(result.document_count).toBe(1001)
    expect(result.document_bytes).toBe(1_001_000)
  })

  it('chunks the period-mode entry-id filter and sums across chunks', async () => {
    // 250 posted entries -> three IN() chunks of max 100 ids. An unchunked
    // implementation consumes a single document response and undercounts.
    const entryIds = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}` }))
    enqueueMany([
      { data: entryIds }, // journal_entries for periodEntryIds
      { data: [{ file_size_bytes: 100 }] }, // chunk 1
      { data: [{ file_size_bytes: 200 }] }, // chunk 2
      { data: [{ file_size_bytes: 300 }] }, // chunk 3
    ])

    const result = await estimateArchiveSize(supabase as any, 'company-1', 'period', 'p-1')

    expect(result.document_count).toBe(3)
    expect(result.document_bytes).toBe(600)
  })
})
