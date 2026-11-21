/**
 * Fixtures for the /sandbox/wiki demo (the context view and record pages).
 * Auth-free via the /sandbox middleware exemption. sample-answers.json holds
 * answers shaped as gnubok_get_agent_briefing and gnubok_get_record give
 * them, for an invented company; the page describes them with the same code
 * the server runs, and nothing reaches a server. ?minne=tomt shows a company
 * with no saved facts, ?grupp=ja one with facts saved for its group.
 * ?graf=stor fills the context graph past its caps and ?graf=tom leaves it
 * nothing to draw (graph-fixtures.ts).
 */
import { briefingText, describeContextWindow } from '@/lib/agent-context/context-window'
import { describeRecord } from '@/lib/agent-context/wiki-record'
import { emptyGraphBriefing, largeGraphBriefing } from './graph-fixtures'
import sample from './sample-answers.json'

export const DEMO_ENTRY_ID = sample.journal_entry.journal_entry.journal_entry_id
export const DEMO_DOCUMENT_ID = sample.document.document.document_id
// REMEMBERED_FACTS_CHAR_BUDGET (lib/agent-context/remembered-facts.ts), copied: that module is server-only.
const MEMORY_BUDGET = 60_000

const GROUP_MEMORY = {
  group_name: 'Exempelbyrån',
  group_kind: 'byra',
  facts: [{ fact_id: 'b1000000-0000-4000-8000-000000000001', kind: 'fact', content: 'Månadsstängning senast den 10:e varje månad.', saved_at: '2026-02-02T08:00:00Z', created_by: 'Byråchefen' }],
}

/** The briefing in the order the tool builds it: identity, skills, memory, then the digests. */
function demoBriefing(): Record<string, unknown> {
  const sp = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
  if (sp.get('graf') === 'tom') return emptyGraphBriefing()
  if (sp.get('graf') === 'stor') return largeGraphBriefing()
  const { company, user_name, atoms, ...rest } = sample.briefing
  return {
    company,
    user_name,
    atoms,
    ...(sp.get('grupp') === 'ja' ? { group_memory: GROUP_MEMORY } : {}),
    memory: sp.get('minne') === 'tomt' ? [] : sample.memory,
    ...rest,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** The wiki's API calls, answered in the browser. */
export function wikiSandboxApi(url: URL, init?: RequestInit): Response | null {
  if (url.pathname === '/api/wiki/context') {
    const briefing = demoBriefing()
    return json(200, { data: { window: describeContextWindow(briefing, MEMORY_BUDGET), text: briefingText(briefing), scopes: 'default_connector' } })
  }
  const record = url.pathname.match(/^\/api\/wiki\/records\/([a-z_]+)\/([0-9a-f-]+)$/)
  if (record) {
    const [, kind, id] = record
    const answer =
      kind === 'journal_entry' && id === DEMO_ENTRY_ID ? sample.journal_entry : kind === 'document' && id === DEMO_DOCUMENT_ID ? sample.document : null
    if (!answer) return json(404, { error: { code: 'NOT_FOUND', message: 'Posten finns inte i det här företaget.', message_en: 'The record does not exist in this company.' } })
    return json(200, { data: { record: describeRecord(kind as 'journal_entry' | 'document', id, answer), text: JSON.stringify(answer, null, 2) } })
  }
  // Glöm and Ångra on a remembered fact: accepted, nothing is stored.
  if (url.pathname.startsWith('/api/agent/memory/') && init?.method === 'PATCH') return json(200, { data: { id: url.pathname.split('/').pop() } })
  return null
}
