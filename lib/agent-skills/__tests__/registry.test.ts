import { describe, expect, it } from 'vitest'
import { skillsToDoNow } from '../registry'

describe('skillsToDoNow', () => {
  it('tags nothing when the worklist is empty', () => {
    expect(skillsToDoNow({})).toEqual(new Map())
    expect(skillsToDoNow({ book_transaction: 0, verifikat_missing_document: 0 })).toEqual(new Map())
  })

  it('tags Kvittojakten when a verifikat is missing its document', () => {
    expect(skillsToDoNow({ verifikat_missing_document: 2 })).toEqual(new Map([['kvittojakten', 2]]))
  })

  it('adds up every category a skill answers', () => {
    expect(skillsToDoNow({ book_transaction: 5, book_skattekonto: 1, verifikat_missing_document: 2, inbox_document: 3, reconciliation_due: 1 }))
      .toEqual(new Map([['bookkeep', 6], ['kvittojakten', 5], ['reconcile-month', 1]]))
  })

  it('ignores categories no skill answers', () => {
    expect(skillsToDoNow({ pending_operations: 4, deadline_action: 1 })).toEqual(new Map())
  })
})
