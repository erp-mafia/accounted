export default {
  rule: 'read-only-refusal-envelope',
  says: 'A write refused to a read-only caller answers one code and one shape at every door, so a client can branch on it.',
  home: 'src/lib/auth/require-write.ts: readOnlyRefusal',
  why: 'The session answered a bare string, the agent routes a code outside the registry, v1 a nested code and MCP dropped the reason, for one refusal.',
  match: [/\{ error: 'Du har endast läsbehörighet/, /message: 'Du har endast läsbehörighet/, /WRITE_PERMISSION_REQUIRED/, /\bcode: '(?:ROLE|CONNECTION)_READ_ONLY'/],
  sanctioned: ['lib/auth/require-write.ts'],
}
