export default {
  rule: 'user-session-auth-fetch',
  says: 'A user-session Supabase client gets its fetch from userSessionFetch: the refresh and the /user check are answered from memory within their budget, so a repeated request does not repeat them.',
  home: 'src/lib/supabase/auth-call-budget.ts: userSessionFetch',
  why: 'Each client took the forwarding fetch directly, so every request asked Supabase Auth again. On 2026-11-11 one session repeating GET /import nine times a second drew 1,665 refresh 429s in 135 seconds on a bucket its whole IP shares, and the 429 was read as signed out.',
  match: [/\bauthForwardingFetch\s*\(/],
  sanctioned: ['lib/supabase/auth-call-budget.ts', 'lib/supabase/auth-forwarding.ts'],
}
