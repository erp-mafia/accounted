/**
 * inbox-items.set-purchase-category over MCP: the binding that stages it as
 * set_inbox_purchase_category, the supplier a staged every_time pins, and the
 * approver's title.
 */
import { describe, expect, it } from 'vitest'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { inboxItemsSetPurchaseCategory, pinMatchedSupplier, setPurchaseCategoryTitle } from '../inbox-purchase-category'

describe('inbox-items.set-purchase-category: MCP binding', () => {
  it('is a low-risk documents:write that stages as set_inbox_purchase_category, out of tools/list', () => {
    const mcp = inboxItemsSetPurchaseCategory.mcp
    expect(inboxItemsSetPurchaseCategory.kind).toBe('write')
    expect(inboxItemsSetPurchaseCategory.scope).toBe('documents:write')
    expect(inboxItemsSetPurchaseCategory.risk).toBe('low')
    expect(OPERATION_RISK_TIERS.set_inbox_purchase_category).toBe('low')
    expect(mcp?.name).toBe('gnubok_set_inbox_purchase_category')
    // Search-only: reachable through gnubok_search_tools and gnubok_stage_tool.
    expect(mcp?.visibility).toBeUndefined()
    expect(mcp?.stage?.pendingType).toBe('set_inbox_purchase_category')
    expect(mcp?.hints).toEqual({ idempotent: true })
    expect((mcp?.description ?? '').length).toBeLessThanOrEqual(280)
  })
})

describe('setPurchaseCategoryTitle', () => {
  const ITEM = '22222222-2222-4222-8222-222222222222'

  it('names the underlag by the supplier its reading names', () => {
    expect(setPurchaseCategoryTitle({ inbox_item_id: ITEM, code: 'expense.software.saas' }, { supplier_name: 'Anthropic' })).toBe(
      'Ändra kategori för underlag från Anthropic',
    )
  })

  it('says when it holds every time', () => {
    expect(
      setPurchaseCategoryTitle({ inbox_item_id: ITEM, code: 'expense.software.saas', every_time: true }, { supplier_name: 'Anthropic' }),
    ).toBe('Ändra kategori för underlag från Anthropic, varje gång')
  })

  it('says a clear is a clear', () => {
    expect(setPurchaseCategoryTitle({ inbox_item_id: ITEM, code: null, every_time: true }, {})).toBe(
      'Ta bort vald kategori för inkorgspost, varje gång',
    )
  })

  it('falls back to the inbox item when the reading names no supplier', () => {
    expect(setPurchaseCategoryTitle({ inbox_item_id: ITEM, code: 'expense.software.saas' })).toBe('Ändra kategori för inkorgspost')
  })
})

describe('pinMatchedSupplier', () => {
  const ITEM = '22222222-2222-4222-8222-222222222222'
  const SUPPLIER = '33333333-3333-4333-8333-333333333333'

  it('is the binding\'s pinParams', () => {
    expect(inboxItemsSetPurchaseCategory.mcp?.stage?.pinParams).toBe(pinMatchedSupplier)
  })

  it('pins the supplier an every_time would instruct, as a valid input', () => {
    const input = { inbox_item_id: ITEM, code: 'expense.software.saas', every_time: true }
    const pinned = pinMatchedSupplier(input, { inbox_item_id: ITEM, supplier_id: SUPPLIER, every_time: true })
    expect(pinned).toEqual({ ...input, expected_supplier_id: SUPPLIER })
    expect(inboxItemsSetPurchaseCategory.input.safeParse(pinned).success).toBe(true)
  })

  it('pins nothing without every_time: the supplier is not written', () => {
    const input = { inbox_item_id: ITEM, code: 'expense.software.saas' }
    expect(pinMatchedSupplier(input, { inbox_item_id: ITEM })).toBe(input)
  })
})
