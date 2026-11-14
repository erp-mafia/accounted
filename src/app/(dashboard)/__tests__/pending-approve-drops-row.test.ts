/**
 * /pending, approving rows one by one: an approved row stayed in the list
 * (with its Godkänn re-enabled) until the refetch landed, seconds on a long
 * queue. The next click at the same spot hit that row again, the commit route
 * answered 409, and the page toasted "Misslyckades" for an approval that went
 * through; the confirm dialog stayed open for more of the same. The row now
 * leaves the list as soon as the approval answers, and a 409 for an operation
 * that is no longer pending reads as "already handled".
 * Approvals now run through a queue: the row is hidden on the click and the
 * approvals are sent one at a time, so no button waits on another row.
 * Components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the page source and the copy on the message files.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const page = fs.readFileSync(path.resolve(__dirname, '../pending/page.tsx'), 'utf8')
const sendApproval = page.slice(page.indexOf('async function sendApproval('), page.indexOf('function queueApproval('))
const queueApproval = page.slice(page.indexOf('function queueApproval('), page.indexOf('async function handleCommit()'))

describe('/pending approve', () => {
  it('drops the approved row from the list before the refetch', () => {
    const okAt = sendApproval.indexOf('const signingUrl = signingUrlOf(json.data)')
    expect(okAt).toBeGreaterThan(-1)
    expect(sendApproval.indexOf('dropFromList(op.id)', okAt)).toBeGreaterThan(okAt)
    // The refetch belongs to the queue, once it has drained.
    expect(sendApproval).not.toContain('afterResolve')

    const drop = page.slice(page.indexOf('function dropFromList('), page.indexOf('async function sendApproval('))
    expect(drop).toContain('setOperations((prev) => prev.filter((o) => o.id !== id))')
    // Only a row that was on screen lowers the count.
    expect(drop).toMatch(/if \(!operationsRef\.current\.some\(\(o\) => o\.id === id\)\) return/)
  })

  it('reads a 409 for an operation no longer pending as already handled, not as a failure', () => {
    const notPendingAt = sendApproval.indexOf("code === 'PENDING_OPERATION_NOT_PENDING'")
    const throwAt = sendApproval.indexOf('if (!res.ok) throw')
    expect(notPendingAt).toBeGreaterThan(-1)
    expect(notPendingAt).toBeLessThan(throwAt)
    const branch = sendApproval.slice(notPendingAt, sendApproval.indexOf('return', notPendingAt))
    expect(branch).toContain("title: t('already_resolved')")
    expect(branch).not.toContain("variant: 'destructive'")
    expect(branch).toContain('dropFromList(op.id)')
    expect(sv.pending.already_resolved).toBe('Redan hanterad')
    expect(en.pending.already_resolved).toBe('Already handled')
  })

  // crm#1618: a "Godkänd" toast opened top-right, over the next row's
  // Godkänn and Avvisa, and stayed while the pointer rested on it, so
  // approving rows in a row meant closing a toast before each click. The row
  // leaving the list is the confirmation; failures and a 409 still toast, and
  // a filing that needs a BankID signature opens its signing step.
  it('confirms a plain approval by the row leaving the list, not by a toast', () => {
    const okAt = sendApproval.indexOf('const signingUrl = signingUrlOf(json.data)')
    const success = sendApproval.slice(okAt, sendApproval.indexOf('} catch (err) {'))
    expect(success).not.toContain('toast(')
    expect(success).toContain('setSigningPrompt({ title: op.title, url: signingUrl })')
    expect(success).toContain('dropFromList(op.id)')
    expect(sendApproval).not.toContain("'Godkänd'")
    // A failure still says so, and names the proposal.
    const failure = sendApproval.slice(sendApproval.indexOf('} catch (err) {'))
    expect(failure).toContain("variant: 'destructive'")
    expect(failure).toContain("t('approve_failed', { title: op.title })")
  })

  it('hides the row on the click and sends approvals one at a time', () => {
    const hideAt = queueApproval.indexOf('setApprovingIds((prev) => new Set(prev).add(op.id))')
    const chainAt = queueApproval.indexOf('approvalChain.current')
    expect(hideAt).toBeGreaterThan(-1)
    expect(chainAt).toBeGreaterThan(hideAt)
    expect(queueApproval).toMatch(/approvalChain\.current\s*\.then\(\(\) => sendApproval\(op, expectedDuplicateJournalEntryId, acknowledgedWarnings\)\)/)
    expect(page).toContain('if (approvingIds.has(op.id)) return false')
  })

  it('brings a refused row back and refetches once, when the queue has drained', () => {
    const settled = queueApproval.slice(queueApproval.indexOf('.finally('))
    expect(settled).toContain('next.delete(op.id)')
    expect(settled).toContain('if (approvalsLeft.current === 0) afterResolveRef.current()')
    // sendApproval never throws, so the chain cannot stall on a failure.
    expect(sendApproval).toMatch(/^async function sendApproval\([^)]*\) \{\s*try \{/)
  })
})
