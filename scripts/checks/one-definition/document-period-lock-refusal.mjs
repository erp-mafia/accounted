export default {
  rule: 'document-period-lock-refusal',
  says: 'A document refused on a verifikat in a locked or closed year is read through isPeriodLockRefusal/classifyError and answered from one registry answer (DOCUMENT_LOCKED_YEAR: DOC_UPLOAD_PERIOD_LOCKED, DOC_ATTACH_PERIOD_LOCKED), with its reason and way forward, at every door that uploads, links, versions or attaches a document.',
  home: 'src/lib/errors/structured-errors.ts: DOCUMENT_LOCKED_YEAR (the answer); src/lib/errors/document-period-lock-refusal.ts: DOCUMENT_PERIOD_LOCK_REFUSAL (the trigger text, read by classifyError and getErrorMessage)',
  why: 'v1 upload answered the trigger with a 500 and no reason (prod 2026-11-16), while the other doors sniffed the text with their own regexes and gave three Swedish sentences and two codes, none naming a way forward.',
  match: [
    /Cannot attach documents/,
    /locked\\?\/closed fiscal period\|Bokföringen är låst/,
    /bifoga (?:underlag|dokument) till verifikationer/i,
    /bilagan kan inte länkas/i,
  ],
  sanctioned: ['lib/errors/document-period-lock-refusal.ts'],
  allowed: {},
}
