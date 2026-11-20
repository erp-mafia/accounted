import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadWikiRecord } from '@/lib/agent-context/wiki-load'
import { isRecordId, isWikiRecordKind } from '@/lib/agent-context/wiki-record'

// GET /api/wiki/records/[kind]/[id]
//
// One wiki record page: the record as gnubok_get_record answers it for the
// active company (lib/agent-context/wiki-load.ts), with its fields, links and
// who kept it current, plus the raw answer the agent reads. Read-only.

function notFound(code: string, message: string, messageEn: string) {
  return NextResponse.json({ error: { code, message, message_en: messageEn } }, { status: 404 })
}

export const GET = withRouteContext<{ params: Promise<{ kind: string; id: string }> }>(
  'wiki.record.get',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { kind, id } = await params
    if (!isWikiRecordKind(kind) || !isRecordId(id)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Okänd post. Adressen ska vara /wiki/<typ>/<id>.',
            message_en: 'Unknown record. The address is /wiki/<kind>/<id>.',
          },
        },
        { status: 400 },
      )
    }
    const result = await loadWikiRecord(supabase, companyId, user.id, kind, id)
    switch (result.status) {
      case 'ok':
        return NextResponse.json({ data: { record: result.record, text: result.text } })
      case 'not_found':
        return notFound('NOT_FOUND', 'Posten finns inte i det här företaget.', 'The record does not exist in this company.')
      case 'not_enabled':
        return notFound(
          'ARKIV_NOT_ENABLED',
          'Den här typen av post visas när företagshjärnan är påslagen för företaget.',
          'This kind of record shows once the company brain is switched on for the company.',
        )
      case 'unavailable':
        return notFound('AGENT_CONTEXT_UNAVAILABLE', 'Agentkopplingen finns inte i den här installationen.', 'The agent connection is not part of this installation.')
    }
  },
)
