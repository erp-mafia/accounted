/**
 * Rutin calls what waits there a proposal ("Godkänn förslaget", "Godkänn N
 * förslag"). The texts around the list said "operation", the name of the
 * stored row, for the same thing. One word per thing on the page: no text in
 * the namespace names an operation, in either language.
 */
import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node && typeof node === 'object') return Object.values(node).flatMap(texts)
  return []
}

describe('Rutin wording', () => {
  it('no Swedish text on the page says operation', () => {
    expect(texts(sv.pending).filter((text) => /operation/i.test(text))).toEqual([])
  })

  it('no English text on the page says operation', () => {
    expect(texts(en.pending).filter((text) => /operation/i.test(text))).toEqual([])
  })

  it('the empty list says what will appear there', () => {
    expect(sv.pending.empty_pending_description).toBe('Inget väntar på din granskning. Förslag som behöver ditt godkännande visas här.')
    expect(en.pending.empty_pending_description).toBe('Nothing is waiting for your review. Proposals that need your approval appear here.')
  })
})
