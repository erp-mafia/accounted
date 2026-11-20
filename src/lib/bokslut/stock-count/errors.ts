/** Refusals of the stock count, each a structured error code (lib/errors/structured-errors.ts, STOCK_COUNT). */
export type StockCountErrorCode =
  | 'STOCK_COUNT_DISABLED'
  | 'STOCK_COUNT_NOT_FOUND'
  | 'STOCK_COUNT_NO_PERIOD'
  | 'STOCK_COUNT_ROLL_FORWARD_REQUIRED'
  | 'STOCK_COUNT_LOCKED'
  | 'STOCK_COUNT_SIGNING_PENDING'
  | 'STOCK_COUNT_EMPTY'
  | 'STOCK_COUNT_NOT_SIGNED'
  | 'STOCK_COUNT_ALREADY_BOOKED'
  | 'STOCK_COUNT_ARTICLE_NOT_FOUND'
  | 'STOCK_COUNT_FILE_INVALID'

export class StockCountError extends Error {
  constructor(
    readonly code: StockCountErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'StockCountError'
  }
}

/** A trigger refusal (inventory_counts_guard) read back as the same code. */
export function stockCountErrorFromDb(error: { code?: string; message?: string } | null | undefined): StockCountError | null {
  const message = error?.message ?? ''
  if (message.includes('INVENTORY_COUNT_NOT_SIGNED')) return new StockCountError('STOCK_COUNT_NOT_SIGNED')
  if (message.includes('INVENTORY_COUNT_LOCKED')) return new StockCountError('STOCK_COUNT_LOCKED')
  if (error?.code === '23505' && message.includes('inventory_counts_one_booked_per_period')) {
    return new StockCountError('STOCK_COUNT_ALREADY_BOOKED')
  }
  return null
}
