import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { buildSandboxPendingOperations } from '../pending-operations'

const input = {
  userId: 'user-1',
  companyId: 'company-1',
  inboxItemId: 'inbox-1',
  supplierId: 'supplier-1',
  invoiceDate: '2026-07-25',
  dueDate: '2026-08-06',
  transactionId: 'tx-1',
}

/** Sum of a kontering in the `lines` (account_number/debit_amount) spelling. */
function sums(lines: Array<{ debit_amount: number; credit_amount: number }>) {
  return {
    debit: lines.reduce((n, l) => n + l.debit_amount, 0),
    credit: lines.reduce((n, l) => n + l.credit_amount, 0),
  }
}

describe('sandbox pending-operation seed data', () => {
  it('stages both demo operations under the RLS-required actor shape', () => {
    const ops = buildSandboxPendingOperations(input)

    expect(ops).toHaveLength(2)
    // pending_operations_chat_insert is the only policy that lets a
    // user-scoped client INSERT here, and it requires both fields.
    expect(ops.every((op) => op.actor_type === 'agent_chat')).toBe(true)
    expect(ops.every((op) => op.risk_level === 'low')).toBe(true)
    expect(ops.every((op) => op.status === 'pending')).toBe(true)
    expect(ops.every((op) => op.user_id === 'user-1' && op.company_id === 'company-1')).toBe(true)
  })

  it('threads the seeded row ids into the executor params', () => {
    const [supplierInvoice, categorize] = buildSandboxPendingOperations(input)

    expect(supplierInvoice.params).toMatchObject({
      inbox_item_id: 'inbox-1',
      supplier_id: 'supplier-1',
      invoice_date: '2026-07-25',
      due_date: '2026-08-06',
    })
    expect(categorize.params).toMatchObject({ transaction_id: 'tx-1' })
  })

  it('gives categorize_transaction the preview shape CategorizePreview reads', () => {
    const categorize = buildSandboxPendingOperations(input).find(
      (op) => op.operation_type === 'categorize_transaction',
    )!
    const preview = categorize.preview_data as {
      amount?: unknown
      debit_account?: unknown
      credit_account?: unknown
      lines?: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }

    // The regression this guards: seeding only the generic `preview_lines` key
    // dropped the card onto the legacy summary branch, which rendered blank
    // accounts and "NaN kr" from formatCurrency(undefined).
    expect(preview.lines).toBeDefined()
    expect(preview.lines!.length).toBeGreaterThan(0)
    expect(typeof preview.amount).toBe('number')
    expect(Number.isFinite(preview.amount as number)).toBe(true)
    expect(preview.debit_account).toBe('1930')
    expect(preview.credit_account).toBe('3001')
  })

  it('previews a balanced verifikat for the 1 200 kr deposit', () => {
    const categorize = buildSandboxPendingOperations(input).find(
      (op) => op.operation_type === 'categorize_transaction',
    )!
    const preview = categorize.preview_data as {
      amount: number
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }

    const { debit, credit } = sums(preview.lines)
    expect(debit).toBe(credit)
    // Gross on the bank line matches the summary amount the card headlines.
    expect(debit).toBe(preview.amount)
    expect(preview.lines.map((l) => l.account_number)).toEqual(['1930', '2611', '3001'])
  })

  it('keeps the supplier-invoice preview on the generic preview_lines shape', () => {
    const supplierInvoice = buildSandboxPendingOperations(input).find(
      (op) => op.operation_type === 'create_supplier_invoice_from_inbox',
    )!
    const preview = supplierInvoice.preview_data as {
      preview_lines: Array<{ account: string; debit: number; credit: number }>
    }

    // No dedicated preview component for this type: GenericPreview renders a
    // kontering under `preview_lines` in the account/debit/credit spelling.
    expect(preview.preview_lines).toHaveLength(3)
    const debit = preview.preview_lines.reduce((n, l) => n + l.debit, 0)
    const credit = preview.preview_lines.reduce((n, l) => n + l.credit, 0)
    expect(roundOre(debit)).toBe(roundOre(credit))
  })
})
