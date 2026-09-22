/** Token endpoint failures retain machine-readable evidence without logging response bodies. */
export class FortnoxOAuthError extends Error {
  constructor(
    readonly operation: 'refresh' | 'exchange',
    readonly status: number,
    readonly providerCode?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Fortnox token ${operation} failed: HTTP ${status}${providerCode ? ` (${providerCode})` : ''}`)
    this.name = 'FortnoxOAuthError'
  }

  static async fromResponse(response: Response, operation: 'refresh' | 'exchange'): Promise<FortnoxOAuthError> {
    const body: unknown = await response.json().catch(() => null)
    const raw = body && typeof body === 'object' && 'error' in body ? body.error : undefined
    const code = typeof raw === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(raw) ? raw : undefined
    return new FortnoxOAuthError(operation, response.status, code, fortnoxRetryAfter(response.headers.get('Retry-After')))
  }
}

export function fortnoxRetryAfter(value: string | null): number | undefined {
  if (!value || /^-\d/.test(value.trim())) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined
}
