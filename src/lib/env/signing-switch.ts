/**
 * SIGNING_ENABLED: BankID document signing (signing requests, the /signera
 * page and their API and MCP doors). Unset = off until the founder flips it.
 *
 * The switch only opens the doors; signing also needs a BankID provider
 * (lib/signing/bankid-provider.ts), which is hosted-only. What the switch
 * never stops: reading a request or its signed copy and evidence package,
 * which are the company's records once a signature exists.
 */
export function signingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.SIGNING_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}
