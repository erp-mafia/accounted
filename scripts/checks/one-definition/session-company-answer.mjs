export default {
  rule: 'session-company-answer',
  says: 'A cookie-session door answers COMPANY_CONTEXT_MISSING only to a user who has no company and TRANSIENT_ERROR when the resolution failed, and never resolves another company in its place.',
  home: 'src/lib/api/with-route-context.ts: resolveSessionCompany',
  why: 'withRouteContext answered a failed Supabase read with COMPANY_CONTEXT_MISSING ("Välj ett företag") while the extension dispatcher let both cases escape as a 500, so one resolution had three answers behind two doors.',
  match: [/'COMPANY_CONTEXT_MISSING'/],
  sanctioned: ['lib/api/with-route-context.ts'],
}
