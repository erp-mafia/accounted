/**
 * /pending, an approval the executor refused (tracker #206 point 2). A
 * refusal that closed the proposal left its row in the list with Godkänn
 * still on it, and the second click answered "Redan hanterad". The page now
 * says the proposal was closed, lets the row go, and Historik says why.
 * Components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the page source and the copy on the message files.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { FIXABLE_REFUSALS } from '@/lib/pending-operations/fixable-refusals'

const page = fs.readFileSync(path.resolve(__dirname, '../pending/page.tsx'), 'utf8')

describe('/pending, a refused approval', () => {
  it('says the proposal was closed and drops its row before the generic failure', () => {
    const closedAt = page.indexOf('if (refusal?.closed) return closeRefusedRow(op, refusal)')
    const throwAt = page.indexOf('if (!res.ok) throw', closedAt)
    expect(closedAt).toBeGreaterThan(-1)
    expect(throwAt).toBeGreaterThan(closedAt)
    const branch = page.slice(page.indexOf('function closeRefusedRow('), page.indexOf('function openRejectDialog('))
    expect(branch).toContain("title: t('refusal_closed_title')")
    expect(branch).toContain('description: refusal.message')
    expect(branch).toContain('dropFromList(op.id)')
    // The approval queue closes the confirm dialog and refetches once drained.
    expect(branch.slice(0, branch.indexOf('function askToFixRefusal('))).not.toContain('afterResolve')
    expect(sv.pending.refusal_closed_title).toBe('Förslaget stängdes')
    expect(en.pending.refusal_closed_title).toBe('The proposal was closed')
  })

  it('names a proposal closed by a refusal as that in the history, with the reason', () => {
    expect(page).toContain("op.rejection_category === 'failed'")
    expect(page).toContain("t('badge_closed_by_refusal')")
    expect(page).toContain("t('closed_by_refusal_detail', { reason: closedByRefusalReason(op) ?? '' })")
    expect(sv.pending.badge_closed_by_refusal).toBe('Kunde inte godkännas')
    expect(en.pending.badge_closed_by_refusal).toBe('Could not be approved')
    expect(sv.pending.closed_by_refusal_detail).toContain('{reason}')
    expect(en.pending.closed_by_refusal_detail).toContain('{reason}')
  })

  it('asks the person to fix a refusal that kept the proposal, after the closed check and before the plain failure', () => {
    const closedAt = page.indexOf('if (refusal?.closed) return closeRefusedRow(op, refusal)')
    const fixAt = page.indexOf('if (refusal && askToFixRefusal(op, refusal)) return')
    const throwAt = page.indexOf('if (!res.ok) throw', fixAt)
    expect(fixAt).toBeGreaterThan(closedAt)
    expect(throwAt).toBeGreaterThan(fixAt)
    const ask = page.slice(page.indexOf('function askToFixRefusal('), page.indexOf('function openRejectDialog('))
    // Only the codes on the one list, for this operation type.
    expect(ask).toContain('fixableRefusalFor(op.operation_type, refusal.code)')
    // The row is neither dropped nor refetched away: the proposal is pending.
    expect(ask).not.toContain('dropFromList')
    // One warnings dialog at a time: a second refusal waits behind the first.
    expect(ask).toContain('const prompt = { op, warnings: warnings as VoucherWarning[] }')
    expect(ask).toContain('setVoucherConfirms((prev) => [...prev.filter((waiting) => waiting.op.id !== op.id), prompt])')
    expect(ask).toContain('setFixNotes(')
  })

  it('confirms the warnings by sending the same approval again with their codes, never on its own', () => {
    const dialog = page.slice(page.indexOf('<VoucherWarningsDialog'), page.indexOf('{/* Bulk commit confirmation dialog */}'))
    expect(dialog).toContain('onCancel={closeVoucherConfirm}')
    // Through the same queue as every other approval.
    expect(dialog).toContain('void queueApproval(op, undefined, warnings.map((warning) => warning.code))')
    expect(page).toContain('...(acknowledgedWarnings ? { acknowledged_warnings: acknowledgedWarnings } : {}),')
    // The only caller that passes codes is the dialog's confirm.
    // (The lookbehind leaves out the function's own declaration.)
    expect(page.match(/(?<!function )queueApproval\([^()]*,[^()]*,/g)).toEqual(['queueApproval(op, undefined,'])
  })

  it('has words for every code on the list of fixable refusals but the one answered in a dialog', () => {
    for (const code of Object.keys(FIXABLE_REFUSALS)) {
      if (code === 'VOUCHER_NEEDS_CONFIRMATION') continue
      expect(page, code).toContain(`  ${code}: { note: '`)
    }
  })

  it('has the fix copy in both languages', () => {
    const keys = [
      'refusal_fix_title',
      'refusal_fix_skatteverket',
      'refusal_fix_skatteverket_link',
      'refusal_fix_invoice_series',
      'refusal_fix_payment_details',
      'refusal_fix_vat_number',
      'refusal_fix_invoicing_link',
      'refusal_fix_tax_link',
    ] as const
    for (const key of keys) {
      expect(sv.pending[key]).toBeTruthy()
      expect(en.pending[key]).toBeTruthy()
    }
  })
})
