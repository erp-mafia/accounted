export interface ArelleValidationIssue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface ArelleValidationResult {
  status: 'passed' | 'warnings' | 'failed' | 'unavailable'
  validator_version: string | null
  issues: ArelleValidationIssue[]
}

interface ArelleValidatorResponse {
  ok?: boolean
  validator_version?: string
  issues?: Array<{
    code?: string
    severity?: string
    message?: string
  }>
}

/**
 * Validate exact iXBRL bytes through the configured Arelle service. The
 * service boundary keeps the Vercel application free from a Python runtime
 * while still making taxonomy validation mandatory for connected filing.
 */
export async function validateIxbrlWithArelle(
  xhtml: string,
  options: {
    url?: string
    token?: string
    timeoutMs?: number
  } = {},
): Promise<ArelleValidationResult> {
  const url = options.url ?? process.env.BOLAGSVERKET_ARELLE_VALIDATOR_URL
  if (!url) {
    return {
      status: 'unavailable',
      validator_version: null,
      issues: [
        {
          code: 'ARELLE-NOT-CONFIGURED',
          severity: 'error',
          message: 'Arelle validator service is not configured.',
        },
      ],
    }
  }

  try {
    const token = options.token ?? process.env.BOLAGSVERKET_ARELLE_VALIDATOR_TOKEN
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        filename: 'arsredovisning.xhtml',
        content_base64: Buffer.from(xhtml, 'utf8').toString('base64'),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    })
    if (!response.ok) {
      return {
        status: 'unavailable',
        validator_version: null,
        issues: [
          {
            code: `ARELLE-HTTP-${response.status}`,
            severity: 'error',
            message: `Arelle validator returned HTTP ${response.status}.`,
          },
        ],
      }
    }

    const body = (await response.json()) as ArelleValidatorResponse
    const issues: ArelleValidationIssue[] = (body.issues ?? []).map((item) => ({
      code: item.code?.trim() || 'ARELLE',
      severity:
        item.severity === 'warning' || item.severity === 'info'
          ? item.severity
          : 'error',
      message: item.message?.trim() || 'Arelle reported a validation issue.',
    }))
    const hasErrors = body.ok === false || issues.some((item) => item.severity === 'error')
    return {
      status: hasErrors ? 'failed' : issues.length > 0 ? 'warnings' : 'passed',
      validator_version: body.validator_version ?? null,
      issues,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      validator_version: null,
      issues: [
        {
          code: 'ARELLE-UNAVAILABLE',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Arelle validator is unavailable.',
        },
      ],
    }
  }
}
