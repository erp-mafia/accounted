/**
 * One place that turns a validated schedule line (API, MCP, update helper)
 * into the recurring_invoice_schedule_items row. A text row stores its
 * description only: quantity/unit/price are zeroed so the DB CHECK
 * (product rows need a description and a positive quantity) and the spawn
 * (text rows never book) agree on what a text row is.
 */
export type RecurringScheduleLineType = 'product' | 'text'

export interface RecurringScheduleItemInput {
  line_type?: RecurringScheduleLineType
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number | null
  dimensions?: Record<string, string>
}

export interface RecurringScheduleItemRow {
  schedule_id: string
  sort_order: number
  line_type: RecurringScheduleLineType
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate: number | null
  dimensions: Record<string, string>
}

export function toRecurringScheduleItemRow(
  scheduleId: string,
  item: RecurringScheduleItemInput,
  sortOrder: number,
): RecurringScheduleItemRow {
  if (item.line_type === 'text') {
    return {
      schedule_id: scheduleId,
      sort_order: sortOrder,
      line_type: 'text',
      description: item.description ?? '',
      quantity: 0,
      unit: '',
      unit_price: 0,
      vat_rate: null,
      dimensions: {},
    }
  }
  return {
    schedule_id: scheduleId,
    sort_order: sortOrder,
    line_type: 'product',
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    dimensions: item.dimensions ?? {},
  }
}

export function isTextLine(item: { line_type?: string | null }): boolean {
  return item.line_type === 'text'
}
