export default {
  rule: 'api-key-actor-identity',
  says: 'One credential is named the same way in every record it writes, whichever door it came through.',
  home: 'src/lib/auth/api-keys.ts: credentialActor',
  why: 'Each door worked out who a key is for itself, so one connector read as api_key or mcp_oauth, under the reserved name or the client name, by door.',
  match: [/[=!]==\s*OAUTH_MCP_KEY_NAME/, /\.apiKeyName\b/, /\btype:\s*'api_key',\s*id:/],
  sanctioned: ['lib/auth/api-keys.ts'],
  allowed: {
    'app/api/settings/api-keys/route.ts': 'the key list says how a key was made, and the name is reserved; no record',
  },
}
