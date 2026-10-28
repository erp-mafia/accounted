/**
 * /pending, approving rows one by one: an approved row stayed in the list
 * (with its Godkänn re-enabled) until the refetch landed, seconds on a long
 * queue. The next click at the same spot hit that row again, the commit route
 * answered 409, and the page toasted "Misslyckades" for an approval that went
 * through; the confirm dialog stayed open for more of the same. The row now
 * leaves the list as soon as the approval answers, and a 409 for an operation
 * that is no longer pending reads as "already handled".
 * Components are not rendered in this suite (vitest runs in `node`), so the
 * wiring is pinned on the page source and the copy on the message files.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

const page = fs.readFileSync(path.resolve(__dirname, '../pending/page.tsx'), 'utf8')
const commitOp = page.slice(page.indexOf('async function commitOp('), page.indexOf('async function handleCommit()'))

describe('/pending approve', () => {
  it('drops the approved row from the list before the refetch', () => {
    const okAt = commitOp.indexOf("toast({ title: 'Godkänd'")
    const dropAt = commitOp.indexOf('dropFromList(op.id)', okAt)
    const refetchAt = commitOp.indexOf('afterResolve()', okAt)
    expect(okAt).toBeGreaterThan(-1)
    expect(dropAt).toBeGreaterThan(okAt)
    expect(refetchAt).toBeGreaterThan(dropAt)

    const drop = page.slice(page.indexOf('function dropFromList('), page.indexOf('async function commitOp('))
    expect(drop).toContain('setOperations((prev) => prev.filter((o) => o.id !== id))')
    // Only a row that was on screen lowers the count.
    expect(drop).toMatch(/if \(!operations\.some\(\(o\) => o\.id === id\)\) return/)
  })

  it('reads a 409 for an operation no longer pending as already handled, not as a failure', () => {
    const notPendingAt = commitOp.indexOf("json?.error?.code === 'PENDING_OPERATION_NOT_PENDING'")
    const throwAt = commitOp.indexOf('if (!res.ok) throw')
    expect(notPendingAt).toBeGreaterThan(-1)
    expect(notPendingAt).toBeLessThan(throwAt)
    const branch = commitOp.slice(notPendingAt, throwAt)
    expect(branch).toContain("title: t('already_resolved')")
    expect(branch).not.toContain("variant: 'destructive'")
    expect(branch).toContain('setShowCommitDialog(false)')
    expect(branch).toContain('dropFromList(op.id)')
    expect(sv.pending.already_resolved).toBe('Redan hanterad')
    expect(en.pending.already_resolved).toBe('Already handled')
  })

  it('re-enables the buttons on every way out, the early return included', () => {
    expect(commitOp).toMatch(/\} finally \{\s*setIsCommitting\(false\)\s*\}/)
  })
})
