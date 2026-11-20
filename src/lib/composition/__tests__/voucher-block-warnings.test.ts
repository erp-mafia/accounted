/**
 * The blocks' voucher warnings (../voucher-block-warnings.ts) against the
 * ledger's contract (lib/bookkeeping/voucher-block-warnings.ts):
 *   - each entry is owned by the module of its leaf, and the list is frozen;
 *   - the VAT entry calls filedPeriodVoucherWarning unchanged and hands back
 *     its answer and its throw as they are;
 *   - cycle guard: neither the seam nor its leaf reaches back into the guard,
 *     engine.ts or lib/init.
 * What the guard does with a warning is pinned by
 * lib/bookkeeping/__tests__/voucher-warnings-guard.test.ts.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaf = vi.hoisted(() => ({ filedPeriodVoucherWarning: vi.fn() }))
vi.mock('@/lib/vat/voucher-filed-period-warning', () => leaf)

import { VOUCHER_BLOCK_WARNINGS } from '../voucher-block-warnings'
import { MODULE_IDS } from '@/lib/modules/manifest'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAF = 'vat/voucher-filed-period-warning'

describe('VOUCHER_BLOCK_WARNINGS', () => {
  beforeEach(() => {
    leaf.filedPeriodVoucherWarning.mockReset()
  })

  it('holds the VAT block\'s filed-period warning, owned by the module of its leaf, and is frozen', () => {
    expect(VOUCHER_BLOCK_WARNINGS.map((w) => w.id)).toEqual(['vat-period-already-filed'])
    const [vat] = VOUCHER_BLOCK_WARNINGS
    expect(vat.module).toBe('vat')
    expect(MODULE_IDS).toContain(vat.module)
    expect(moduleForLibPath(LEAF)).toBe(vat.module)
    expect(Object.isFrozen(VOUCHER_BLOCK_WARNINGS)).toBe(true)
    expect(Object.isFrozen(vat)).toBe(true)
  })

  it('calls filedPeriodVoucherWarning once with the same arguments and returns its answer as it is', async () => {
    const supabase = {} as SupabaseClient
    const input = { entry_date: '2026-09-27', lines: [], replaces: null }
    const warning = { code: 'VAT_PERIOD_ALREADY_FILED', message_sv: 'sv', message_en: 'en', details: {} }
    leaf.filedPeriodVoucherWarning.mockResolvedValue(warning)

    await expect(VOUCHER_BLOCK_WARNINGS[0].warn(supabase, 'company-1', input)).resolves.toBe(warning)
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledTimes(1)
    expect(leaf.filedPeriodVoucherWarning).toHaveBeenCalledWith(supabase, 'company-1', input)
  })

  it('passes a failed read on as it is: the guard decides what it means', async () => {
    const failed = new Error('filing record unreadable')
    leaf.filedPeriodVoucherWarning.mockRejectedValue(failed)

    await expect(
      VOUCHER_BLOCK_WARNINGS[0].warn({} as SupabaseClient, 'company-1', { entry_date: '2026-09-27', lines: [] }),
    ).rejects.toBe(failed)
  })
})

describe('voucher block warnings: cycle guard', () => {
  const edges = scanLibImports(LIB_ROOT)
  const files = new Set(edges.map((edge) => edge.from.replace(/\.tsx?$/, '')))
  const graph = new Map<string, string[]>()
  for (const edge of edges) {
    const from = edge.from.replace(/\.tsx?$/, '')
    const to = files.has(edge.to) ? edge.to : files.has(`${edge.to}/index`) ? `${edge.to}/index` : edge.to
    graph.set(from, [...(graph.get(from) ?? []), to])
  }
  const reaches = (start: string, target: (node: string) => boolean): string[] | null => {
    const parent = new Map<string, string | null>([[start, null]])
    const queue = [start]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (target(node)) {
        const path = [node]
        for (let p = parent.get(node); p; p = parent.get(p)) path.unshift(p)
        return path
      }
      for (const next of graph.get(node) ?? []) {
        if (!parent.has(next)) {
          parent.set(next, node)
          queue.push(next)
        }
      }
    }
    return null
  }

  it('sees a real path (control: the guard reaches the seam)', () => {
    expect(reaches('bookkeeping/voucher-warnings-guard', (node) => node === 'composition/voucher-block-warnings')).not.toBeNull()
  })

  it.each([LEAF, 'composition/voucher-block-warnings'])('%s never reaches the guard, engine.ts or lib/init', (start) => {
    expect(reaches(start, (node) => node === 'bookkeeping/voucher-warnings-guard'), 'path to the guard').toBeNull()
    expect(reaches(start, (node) => node === 'bookkeeping/engine'), 'path to engine.ts').toBeNull()
    expect(reaches(start, (node) => node === 'init' || node === 'init/index'), 'path to lib/init').toBeNull()
  })
})
