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

function render(transaction: ReturnType<typeof makeTransaction>) {
  return renderToStaticMarkup(
    createElement(TransactionHistoryList, {
      transactions: [{ ...transaction }],
      sourceFilter: 'all',
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
