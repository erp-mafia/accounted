/**
 * Nedskrivningar and their reversals as the register holds them (ÅRL 4:5,
 * K3 27): pure readers over `Asset.value_adjustments`, safe in the browser.
 * The accounts a write-down books on are in impairment-accounts.ts; the
 * write path is value-adjustment-service.ts.
 *
 * A row counts while its voucher is posted. A storno sets the voucher to
 * 'reversed' (lib/core/bookkeeping/storno-service.ts), which takes the row
 * out of every figure here, exactly as commit_asset_value_adjustment and
 * asset_net_impairment count it in the database.
 */
import { roundOre } from '@/lib/money'
import type { Asset, AssetValueAdjustment } from '@/types'

/** The adjustments whose voucher is posted. A row read without its voucher
 *  status embedded is taken as posted (the RPC posts it with the row). */
export function effectiveAdjustments(asset: Pick<Asset, 'value_adjustments'>): AssetValueAdjustment[] {
  return (asset.value_adjustments ?? []).filter(
    (row) => !row.journal_entry || row.journal_entry.status === 'posted',
  )
}

function signed(row: AssetValueAdjustment): number {
  const amount = roundOre(Number(row.amount) || 0)
  return row.kind === 'impairment' ? amount : -amount
}

/**
 * Net write-down (write-downs less reversals) per register key: the
 * component id for a component asset's rows, the asset id for an asset
 * written down as a whole. `before`: only rows dated before that day;
 * `through`: only rows dated on or before it.
 */
export function writtenDownByKey(
  asset: Pick<Asset, 'id' | 'value_adjustments'>,
  window: { before?: string; through?: string } = {},
): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of effectiveAdjustments(asset)) {
    if (window.before !== undefined && row.adjustment_date >= window.before) continue
    if (window.through !== undefined && row.adjustment_date > window.through) continue
    const key = row.component_id ?? asset.id
    out.set(key, roundOre((out.get(key) ?? 0) + signed(row)))
  }
  return out
}

/** The asset's whole net write-down (every component), optionally through a day. */
export function netWrittenDown(asset: Pick<Asset, 'id' | 'value_adjustments'>, through?: string): number {
  let total = 0
  for (const value of writtenDownByKey(asset, through ? { through } : {}).values()) total = roundOre(total + value)
  return total
}

/** Net write-down outstanding per accumulated-impairment account (12x8), for
 *  the disposal voucher that clears it. */
export function writtenDownByAccount(asset: Pick<Asset, 'value_adjustments'>): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of effectiveAdjustments(asset)) {
    out.set(row.accumulated_account, roundOre((out.get(row.accumulated_account) ?? 0) + signed(row)))
  }
  return out
}

/**
 * The year's movement in accumulated write-downs of one asset, for the
 * ÅRL 5 kap. 8 § roll-forward (årets nedskrivningar, återföringar and what a
 * disposal took off): the seam the K3 asset note reads (K3 plan phase 1).
 * Posted vouchers only; an asset disposed in the year clears its closing.
 */
export interface WriteDownMovement {
  opening: number
  writtenDown: number
  reversed: number
  disposed: number
  closing: number
}

export function writeDownMovement(
  asset: Pick<Asset, 'id' | 'value_adjustments' | 'disposed_at'>,
  periodStart: string,
  periodEnd: string,
): WriteDownMovement {
  let opening = 0
  let writtenDown = 0
  let reversed = 0
  for (const row of effectiveAdjustments(asset)) {
    const amount = roundOre(Number(row.amount) || 0)
    if (row.adjustment_date < periodStart) opening = roundOre(opening + (row.kind === 'impairment' ? amount : -amount))
    else if (row.adjustment_date <= periodEnd) {
      if (row.kind === 'impairment') writtenDown = roundOre(writtenDown + amount)
      else reversed = roundOre(reversed + amount)
    }
  }
  const beforeDisposal = roundOre(opening + writtenDown - reversed)
  const disposedInYear = Boolean(asset.disposed_at && asset.disposed_at >= periodStart && asset.disposed_at <= periodEnd)
  const disposed = disposedInYear ? beforeDisposal : 0
  return { opening, writtenDown, reversed, disposed, closing: roundOre(beforeDisposal - disposed) }
}

/**
 * What the register booked on each accumulated write-down account in the
 * year (writeDownMovement per accumulated_account), over the assets on the
 * books in it. The ledger's write-down accounts less this are the
 * nedskrivningar booked outside the register (by hand, before Accounted),
 * which the asset note discloses from the ledger instead: each
 * nedskrivning has one source and is never counted twice.
 */
export function registerWriteDownsByAccount(
  assets: ReadonlyArray<Pick<Asset, 'id' | 'value_adjustments' | 'disposed_at'>>,
  periodStart: string,
  periodEnd: string,
): Map<string, WriteDownMovement> {
  const out = new Map<string, WriteDownMovement>()
  for (const asset of assets) {
    if (asset.disposed_at && asset.disposed_at < periodStart) continue
    const byAccount = new Map<string, AssetValueAdjustment[]>()
    for (const row of effectiveAdjustments(asset)) {
      const list = byAccount.get(row.accumulated_account) ?? []
      list.push(row)
      byAccount.set(row.accumulated_account, list)
    }
    for (const [account, rows] of byAccount) {
      const movement = writeDownMovement({ ...asset, value_adjustments: rows }, periodStart, periodEnd)
      const sum = out.get(account)
      out.set(
        account,
        sum
          ? {
              opening: roundOre(sum.opening + movement.opening),
              writtenDown: roundOre(sum.writtenDown + movement.writtenDown),
              reversed: roundOre(sum.reversed + movement.reversed),
              disposed: roundOre(sum.disposed + movement.disposed),
              closing: roundOre(sum.closing + movement.closing),
            }
          : movement,
      )
    }
  }
  return out
}
