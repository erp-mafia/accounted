import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown, references: undefined as unknown, referencesError: undefined as unknown }))
vi.mock('swr', () => ({ default: (key: unknown) => ({
  data: Array.isArray(key) && key[0] === 'journal-entry-detail' ? state.data : Array.isArray(key) && key[0] === 'journal-entry-references' ? state.references : undefined,
  error: Array.isArray(key) && key[0] === 'journal-entry-detail' ? state.error : Array.isArray(key) && key[0] === 'journal-entry-references' ? state.referencesError : undefined,
  isLoading: false, mutate: vi.fn(),
}) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('next-intl', () => ({ useLocale: () => 'en', useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }) }))
vi.mock('@/contexts/CompanyContext', () => ({ useCompanyOptional: () => ({ company: { id: 'company' } }) }))
vi.mock('@/lib/hooks/use-can-write', () => ({ useCanWrite: () => ({ canWrite: false }) }))
vi.mock('@/components/settings/useSettings', () => ({ useCompanySettings: () => ({ settings: {} }) }))
vi.mock('@/lib/reference-data/hooks', () => ({ useDimensions: () => ({ dimensions: [] }) }))
vi.mock('@/lib/attribution/use-attribution', () => ({ useAttribution: () => ({ format: () => '' }) }))
vi.mock('@/lib/hooks/use-detail-pager', () => ({ useListReturnHref: () => '/bookkeeping' }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/components/bookkeeping/use-commit-draft', () => ({ useCommitDraft: () => ({}) }))
vi.mock('@/components/bookkeeping/use-reverse-journal-entry', () => ({ useReverseJournalEntry: () => ({ reverse: vi.fn(), isReversing: false }) }))
vi.mock('@/components/ui/record-header', () => ({ RecordHeader: () => React.createElement('header', null, 'Voucher') }))
vi.mock('@/components/ui/page-header-actions', () => ({ PageHeaderOverflowItems: () => null }))
vi.mock('@/components/common/DetailPager', () => ({ DetailPager: () => null }))
vi.mock('@/components/bookkeeping/JournalEntryAttachments', () => ({ default: ({ referencesState }: { referencesState: string }) => React.createElement('div', null, 'Attachments: ' + referencesState) }))
vi.mock('@/components/bookkeeping/JournalEntryTransactionLinks', () => ({ default: () => null }))
vi.mock('@/components/bookkeeping/JournalEntryStatusBadge', () => ({ default: () => null, useSourceTypeLabels: () => ({}) }))
vi.mock('@/components/bookkeeping/VoucherLinesTable', () => ({ VoucherLinesTable: () => React.createElement('div', null, 'Voucher rows') }))
vi.mock('@/components/bookkeeping/ManualAccrualDialog', () => ({ ManualAccrualDialog: () => null }))
import JournalEntryDetail from '../JournalEntryDetail'

const detail = {
  entry: { id: 'entry', status: 'draft', source_type: 'manual', entry_date: '2026-01-01',
    notes: 'Previously retrieved note', lines: [] },
  chain: [], references: [], retag_log: [], rattelse_log: [], period_status: null, period: null,
}
const render = () => renderToStaticMarkup(React.createElement(JournalEntryDetail, { id: 'entry' }))
beforeEach(() => { state.data = detail; state.error = undefined; state.references = undefined; state.referencesError = undefined })
it('keeps cached voucher data visible and offers retry when refresh fails', () => {
  state.error = new Error('Connection lost')
  const html = render()
  expect(html).toContain('Previously retrieved note')
  expect(html).toContain('Voucher rows')
  expect(html).toContain('refresh_failed')
  expect(html).toContain('role="alert"')
  expect(html).toContain('retry')
})
it('shows a load error when there is no previously retrieved voucher', () => {
  state.data = undefined; state.error = new Error('Connection lost')
  const html = render()
  expect(html).toContain('error_load_failed')
  expect(html).not.toContain('Voucher rows')
})
it('does not keep a stale voucher visible after a genuine 404', () => {
  state.error = Object.assign(new Error('Missing'), { status: 404 })
  const html = render()
  expect(html).toContain('not_found_hint')
  expect(html).not.toContain('Previously retrieved note')
  expect(html).not.toContain('refresh_failed')
})

it('keeps unavailable references distinct from an empty attachment list while recovery is pending', () => {
  state.data = { ...detail, references: null }
  const html = render()
  expect(html).toContain('Attachments: loading')
  expect(html).not.toContain('no_attachments')
})
it('offers retry when reference recovery fails without reporting an empty attachment list', () => {
  state.data = { ...detail, references: null }
  state.referencesError = new Error('Reference read failed')
  const html = render()
  expect(html).toContain('Attachments: error')
  expect(html).toContain('retry')
  expect(html).not.toContain('no_attachments')
})
it('uses the recovered owner when both optional owner and reference reads failed', () => {
  state.data = { ...detail, references: null, owned_by: null }
  state.references = { references: [], owned_by: {
    kind: 'supplier_invoice', owner_id: 'invoice', href: '/supplier-invoices/invoice', label: 'Recovered invoice',
  } }
  const html = render()
  expect(html).toContain('Attachments: ready')
  expect(html).toContain('Recovered invoice')
  expect(html).toContain('/supplier-invoices/invoice')
})
