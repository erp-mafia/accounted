export default {
  rule: 'session-company-answer',
  says: 'The session doors (withRouteContext, the extension dispatcher) answer COMPANY_CONTEXT_MISSING only to a user who has no company and TRANSIENT_ERROR when the lookup failed, never another company in its place, through one function.',
  home: 'src/lib/api/with-route-context.ts: resolveSessionCompany',
  why: 'withRouteContext answered a failed Supabase read with COMPANY_CONTEXT_MISSING ("Välj ett företag") while the extension dispatcher let both cases escape as a 500, so one resolution had three answers behind two doors.',
  match: [
    // A door building the no-company answer itself, by the envelope builder
    // or by hand. A client reading the code is not writing the rule.
    /\berrorResponseFromCode\(\s*'COMPANY_CONTEXT_MISSING'/,
    /\bcode:\s*'COMPANY_CONTEXT_MISSING'/,
  ],
  sanctioned: ['lib/api/with-route-context.ts'],
}
