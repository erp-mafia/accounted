import { describe, expect, it } from 'vitest'
import { skillsToDoNow } from '../registry'

describe('skillsToDoNow', () => {
  it('tags nothing when the worklist is empty', () => {
    expect(skillsToDoNow({})).toEqual(new Set())
    expect(skillsToDoNow({ book_transaction: 0, verifikat_missing_document: 0 })).toEqual(new Set())
  })

  it('tags Kvittojakten when a verifikat is missing its document', () => {
    expect(skillsToDoNow({ verifikat_missing_document: 2 })).toEqual(new Set(['kvittojakten']))
  })

  it('tags each skill from any of its categories', () => {
    expect(skillsToDoNow({ book_skattekonto: 1, inbox_document: 3, reconciliation_due: 1 }))
      .toEqual(new Set(['bookkeep', 'kvittojakten', 'reconcile-month']))
  })

  it('ignores categories no skill answers', () => {
    expect(skillsToDoNow({ pending_operations: 4, deadline_action: 1 })).toEqual(new Set())
  })
})
