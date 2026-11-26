/**
 * questionOperations for as many questions as gnubok_list_questions lists.
 *
 * The MCP list takes up to 200 questions, and a question holds up to
 * QUESTION_LIMITS.maxOperations operations. The operations were read by id
 * with one `.in()`, and supabase-js puts the ids in the GET query string:
 * 1000 uuids are about 39 KB, past both gateways' limits, so the read was
 * refused and the list failed. The fake gateway (tests/gateway-supabase.ts)
 * refuses a URL past a self-hosted Kong's 8 KB, the stricter of the two.
 */
import { describe, expect, it } from 'vitest'
import { questionOperations } from '../operations'
import { QUESTION_LIMITS } from '../types'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'

/** The most questions gnubok_list_questions lists (MAX_LIMIT in lib/questions/list.ts). */
const LISTED_MAX = 200
const PER_QUESTION = QUESTION_LIMITS.maxOperations

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const question = (q: number) => uuid(q, 'eeeeeeee')
/** The k-th operation of question q, numbered across the company. */
const nth = (q: number, k: number) => (q - 1) * PER_QUESTION + k
const operation = (n: number) => uuid(n, '0b0b0b0b')
const bankRow = (n: number) => uuid(n, '10101010')

/** Every listed question with its full share of operations, each naming its own bank row. */
function fullList() {
  const start = Date.UTC(2026, 10, 20, 10, 0, 0)
  return {
    // Seeded in operation order, but linked the other way round: the order
    // a question's operations come in is the links' own.
    company_question_operations: range(LISTED_MAX).flatMap((q) =>
      range(PER_QUESTION).map((k) => ({
        id: uuid(nth(q, k), 'cccccccc'),
        company_id: COMPANY,
        question_id: question(q),
        operation_id: operation(nth(q, k)),
        created_at: new Date(start + (nth(q, PER_QUESTION) - k) * 1000).toISOString(),
      })),
    ),
    pending_operations: range(LISTED_MAX * PER_QUESTION).map((n) => ({
      id: operation(n),
      company_id: COMPANY,
      operation_number: n,
      operation_type: 'categorize_transaction',
      title: `Förslag ${n}`,
      status: 'pending',
      result_data: null,
      transaction_id: bankRow(n),
      document_name: null,
      voucher_label: null,
    })),
    transactions: range(LISTED_MAX * PER_QUESTION).map((n) => ({
      id: bankRow(n),
      company_id: COMPANY,
      date: '2026-11-03',
      description: `Rad ${n}`,
      merchant_name: null,
      amount: -n,
      currency: 'SEK',
    })),
  }
}

describe('questionOperations: the questions of a full list', () => {
  it('gives every question its operations in the order they were linked, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(fullList())

    const byQuestion = await questionOperations(supabase, COMPANY, range(LISTED_MAX).map(question))

    expect(byQuestion.size).toBe(LISTED_MAX)
    for (const q of range(LISTED_MAX)) {
      expect(byQuestion.get(question(q))?.map((entry) => entry.operation_id)).toEqual(
        range(PER_QUESTION).reverse().map((k) => operation(nth(q, k))),
      )
    }
    // The last operation of the last question, with the bank row it names.
    expect(byQuestion.get(question(LISTED_MAX))?.[0]).toMatchObject({
      operation_id: operation(LISTED_MAX * PER_QUESTION),
      operation_number: LISTED_MAX * PER_QUESTION,
      bank_row: { label: `Rad ${LISTED_MAX * PER_QUESTION}`, amount: -LISTED_MAX * PER_QUESTION, currency: 'SEK' },
    })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // The questions, the operations and their bank rows, 100 ids at a time.
    expect(requestsTo('company_question_operations').map((r) => inListOf(r, 'question_id').length)).toEqual([100, 100])
    expect(requestsTo('pending_operations').map((r) => inListOf(r, 'id').length)).toEqual(Array(10).fill(100))
    expect(requestsTo('transactions').map((r) => inListOf(r, 'id').length)).toEqual(Array(10).fill(100))
    expect(unmodelled).toEqual([])
  })
})
