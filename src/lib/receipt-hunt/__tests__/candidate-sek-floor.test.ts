/**
 * The nightly hunt's 100 kr floor is in kronor whatever the row's currency
 * (crm#1785). On a USD or EUR cash account a row's `amount` is in that
 * currency, so the floor reads `amount_sek` when the row carries one.
 *
 * The stand-in answers from rows: it applies the query's own filters, the
 * or=() group included, as Postgres would (a comparison with NULL is not
 * true), and pages with `range`, so a wrong filter shows up as a wrong set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { fetchCandidateTransactions } from '../hunt'

type Row = Record<string, unknown>
type Call = { method: string; args: unknown[] }

/** A PostgREST logic list split on its top-level commas. */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++
    else if (list[i] === ')') depth--
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i))
      start = i + 1
    }
  }
  out.push(list.slice(start))
  return out
}

function compare(value: unknown, op: string, operand: unknown): boolean {
  if (op === 'is') return operand === null ? value == null : value === operand
  if (value == null) return false
  if (op === 'eq') return String(value) === String(operand)
  const [a, b] = typeof value === 'number' ? [value, Number(operand)] : [String(value), String(operand)]
  if (op === 'lt') return a < b
  if (op === 'lte') return a <= b
  if (op === 'gt') return a > b
  if (op === 'gte') return a >= b
  throw new Error(`operator ${op} is not modelled here`)
}

/** One item of a logic list: `column.op.value`, `and(...)` or `or(...)`. */
function holds(row: Row, item: string): boolean {
  const group = /^(and|or)\((.*)\)$/.exec(item)
  if (group) {
    const parts = splitTopLevel(group[2]).map((part) => holds(row, part))
    return group[1] === 'and' ? parts.every(Boolean) : parts.some(Boolean)
  }
  const [column, op, ...rest] = item.split('.')
  const raw = rest.join('.')
  return compare(row[column], op, op === 'is' && raw === 'null' ? null : raw)
}

function answerFrom(rows: Row[]) {
  return (chain: Call[]) => {
    let out = rows
    let from = 0
    let to = Number.MAX_SAFE_INTEGER
    for (const { method, args } of chain) {
      if (method === 'select') continue
      if (method === 'or') {
        out = out.filter((row) => splitTopLevel(args[0] as string).some((item) => holds(row, item)))
      } else if (['eq', 'is', 'lt', 'lte', 'gt', 'gte'].includes(method)) {
        out = out.filter((row) => compare(row[args[0] as string], method, args[1]))
      } else if (method === 'order') {
        const column = args[0] as string
        out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1))
      } else if (method === 'range') {
        from = Number(args[0])
        to = Number(args[1])
      } else {
        throw new Error(`method ${method} is not modelled here`)
      }
    }
    return { data: out.slice(from, to + 1) }
  }
}

function bankRow(id: string, amount: number, currency: string, amountSek: number | null): Row {
  return {
    id,
    company_id: 'co-1',
    document_id: null,
    date: '2026-11-01',
    description: id,
    merchant_name: null,
    amount,
    currency,
    amount_sek: amountSek,
    exchange_rate: null,
  }
}

async function hunted(rows: Row[]): Promise<string[]> {
  const { supabase } = createTableMockSupabase({ open_bank_rows: answerFrom(rows) })
  const found = await fetchCandidateTransactions(supabase as unknown as SupabaseClient, 'co-1')
  return found.map((row) => row.id)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-11T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCandidateTransactions: the 100 kr floor is in kronor', () => {
  it('hunts a foreign row worth 100 kr or more although its own amount is under 100', async () => {
    const ids = await hunted([
      bankRow('usd-50', -50, 'USD', -512.4),
      bankRow('eur-9', -9, 'EUR', -100),
    ])
    expect(ids).toEqual(['eur-9', 'usd-50'])
  })

  it('skips a foreign row under 100 kr although its own amount is over 100', async () => {
    const ids = await hunted([
      bankRow('jpy-150', -150, 'JPY', -9.8),
      bankRow('eur-120', -120, 'EUR', -99.99),
    ])
    expect(ids).toEqual([])
  })

  it('weighs a SEK row by its amount, as before', async () => {
    const ids = await hunted([
      bankRow('sek-100', -100, 'SEK', null),
      bankRow('sek-99', -99.99, 'SEK', null),
      bankRow('sek-250-twin', -250, 'SEK', -250),
      bankRow('sek-50-twin', -50, 'SEK', -50),
    ])
    expect(ids).toEqual(['sek-100', 'sek-250-twin'])
  })

  it('keeps the old comparison for a foreign row without amount_sek', async () => {
    const ids = await hunted([
      bankRow('eur-150-no-sek', -150, 'EUR', null),
      bankRow('eur-50-no-sek', -50, 'EUR', null),
    ])
    expect(ids).toEqual(['eur-150-no-sek'])
  })

  it('never hunts money in, whatever its kronor', async () => {
    const ids = await hunted([
      bankRow('usd-in', 50, 'USD', 512.4),
      bankRow('sek-in', 500, 'SEK', null),
    ])
    expect(ids).toEqual([])
  })

  it('pages past 1000 rows with the floor applied on every page', async () => {
    const rows: Row[] = []
    for (let i = 0; i < 2400; i++) {
      const id = `tx-${String(i).padStart(4, '0')}`
      // Every other row is a USD charge worth over 100 kr; the rest are worth
      // under 100 kr though their own number is over 100.
      rows.push(i % 2 === 0 ? bankRow(id, -40, 'USD', -410) : bankRow(id, -400, 'JPY', -26))
    }
    const ids = await hunted(rows)
    expect(ids).toHaveLength(1200)
    expect(new Set(ids).size).toBe(1200)
    expect(ids.every((id) => Number(id.slice(3)) % 2 === 0)).toBe(true)
  })
})
