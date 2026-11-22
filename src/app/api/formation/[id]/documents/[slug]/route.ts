import { fileResponse } from '@/lib/api/file-response'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { renderDocx } from '@/lib/formation/docx'
import { FORMATION_DOCUMENTS, buildFormationDocument } from '@/lib/formation/documents'
import { shareholderAgreementEnabled } from '@/lib/formation/flags'
import { renderFormationPdf } from '@/lib/formation/pdf'
import { formationRoute } from '@/lib/formation/route'
import { FormationStateError, getFormation, isReady, openAnswers, parseStoredAnswers } from '@/lib/formation/store'
import { codedRefusal } from '@/lib/errors/refusal'

/**
 * GET /api/formation/:id/documents/:slug?format=pdf|docx: one document of
 * the formation package, built from the founder's answers on every request
 * (nothing is stored before the company exists). The package is free; a
 * formation whose answers still break a rule is refused.
 */
export const GET = formationRoute<{ params: Promise<{ id: string; slug: string }> }>('formation.document', async (request, { user, service }, { params }) => {
  const { id, slug } = await params
  const format = new URL(request.url).searchParams.get('format') === 'docx' ? 'docx' : 'pdf'
  const formation = await getFormation(service, user.id, id)
  if (!formation) throw new FormationStateError('FORMATION_NOT_FOUND')
  if (!isReady(formation)) throw new FormationStateError('FORMATION_INCOMPLETE')

  const entry = FORMATION_DOCUMENTS.find((d) => d.slug === slug)
  const answers = openAnswers(parseStoredAnswers(formation.answers))
  if (!entry || !entry.formats.includes(format) || !entry.available(answers) || (slug === 'aktieagaravtal' && !shareholderAgreementEnabled())) {
    throw codedRefusal('FORMATION_DOCUMENT_UNAVAILABLE', `No ${format} document ${slug} for this formation.`)
  }
  const doc = buildFormationDocument(slug, answers, { today: todayIsoStockholm(), deedDate: formation.deed_date, registration: null })
  if (!doc) throw codedRefusal('FORMATION_DOCUMENT_UNAVAILABLE', `No document ${slug} for this formation.`)

  if (format === 'docx') {
    const bytes = await renderDocx(doc)
    return fileResponse(bytes, {
      filename: `${doc.slug}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      cacheControl: 'private, no-store',
    })
  }
  const bytes = await renderFormationPdf(doc)
  return fileResponse(bytes, { filename: `${doc.slug}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
