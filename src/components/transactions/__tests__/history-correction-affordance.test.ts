/**
 * "Skapa ändringsverifikation" in the Alla list's row menu. The affordance
 * owns the correction dialog, and it used to render inside the menu content,
 * which unmounts the moment an item is selected: the fetch then resolved into
 * an unmounted component and the dialog never opened. It must wrap the whole
 * menu so it is mounted while the menu is closed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeTransaction } from '@/tests/helpers'

vi.mock('next-intl', () => {
  const t = (key: string) => key
  return { useTranslations: () => Object.assign(t, { has: () => true }) }
})

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}))

const canWrite = { value: true }
vi.mock('@/lib/hooks/use-can-write', () => ({ useCanWrite: () => ({ canWrite: canWrite.value }) }))

const mounted: string[] = []
vi.mock('@/components/bookkeeping/CorrectionAffordance', () => ({
  default: ({
    journalEntryId,
    children,
  }: {
    journalEntryId: string
    children: (args: { open: () => void; isLoading: boolean }) => ReactNode
  }) => {
    mounted.push(journalEntryId)
    return createElement('div', { 'data-correction': journalEntryId }, children({ open: () => undefined, isLoading: false }))
  },
}))

const { default: TransactionHistoryList } = await import('../TransactionHistoryList')

function render(
  transaction: ReturnType<typeof makeTransaction>,
  filter: 'all' | 'business' | 'private' | 'ignored' = 'all',
) {
  return renderToStaticMarkup(
    createElement(TransactionHistoryList, {
      transactions: [{ ...transaction }],
      sourceFilter: 'all',
      filter,
      onFilterChange: () => undefined,
      onUnignore: () => undefined,
      onOpenMatchDialog: () => undefined,
      onOpenCategoryDialog: () => undefined,
    }),
  )
}

describe('TransactionHistoryList correction affordance', () => {
  beforeEach(() => {
    mounted.length = 0
    canWrite.value = true
  })

  it('mounts the affordance around the closed row menu of a booked row', () => {
    const html = render(makeTransaction({ id: 'tx-1', journal_entry_id: 'je-1', is_business: true, category: 'expense_other' }))
    expect(mounted).toEqual(['je-1'])
    // The menu trigger sits inside the affordance, so the dialog outlives the menu content.
    expect(html).toMatch(/data-correction="je-1"[^]*aria-label="Fler alternativ"/)
  })

  it('leaves an unbooked row without the affordance', () => {
    render(makeTransaction({ id: 'tx-2', journal_entry_id: null, is_business: null }))
    expect(mounted).toEqual([])
  })

  it('leaves a viewer without the affordance', () => {
    canWrite.value = false
    render(makeTransaction({ id: 'tx-3', journal_entry_id: 'je-3', is_business: true, category: 'expense_other' }))
    expect(mounted).toEqual([])
  })
})

// crm#1612: a migrated row the user ignored showed under Alla as unbooked with
// Bokför, so nothing told them it was the ignored one or how to restore it.
describe('TransactionHistoryList ignored row', () => {
  const ignored = () =>
    makeTransaction({ id: 'tx-ign', journal_entry_id: null, is_business: null, is_ignored: true })

  beforeEach(() => {
    canWrite.value = true
  })

  it('says Ignorerad and offers Återställ instead of Bokför', () => {
    const html = render(ignored())
    expect(html).toContain('ignored_badge')
    expect(html).toContain('>unignore<')
    expect(html).not.toContain('>book<')
  })

  it('shows under the Ignorerade chip, and an ordinary unbooked row does not', () => {
    expect(render(ignored(), 'ignored')).toContain('data-tx-id="tx-ign"')
    const pending = makeTransaction({ id: 'tx-pend', journal_entry_id: null, is_business: null, is_ignored: false })
    expect(render(pending, 'ignored')).not.toContain('data-tx-id="tx-pend"')
    expect(render(pending)).toContain('>book<')
  })

  it('drops Ladda fler under Ignorerade, where every ignored row is already loaded', () => {
    const withMore = (filter: 'all' | 'ignored') =>
      renderToStaticMarkup(
        createElement(TransactionHistoryList, {
          transactions: [ignored()],
          sourceFilter: 'all',
          filter,
          onFilterChange: () => undefined,
          onOpenMatchDialog: () => undefined,
          onOpenCategoryDialog: () => undefined,
          hasMore: true,
          onLoadMore: () => undefined,
        }),
      )
    expect(withMore('all')).toContain('load_more')
    expect(withMore('ignored')).not.toContain('load_more')
  })

  it('offers a viewer no Återställ', () => {
    canWrite.value = false
    const html = render(ignored())
    expect(html).toContain('ignored_badge')
    expect(html).not.toContain('>unignore<')
  })
})
