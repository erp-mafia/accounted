export interface SubmitFeedbackInput {
  message: string
  subject?: string
}

export type SupportChannel = 'email'

export interface SubmitFeedbackResult {
  ok: boolean
  channels: SupportChannel[]
  error?: string
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  try {
    const res = await fetch('/api/support/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: input.subject, message: input.message }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, channels: [], error: data.error || 'Kunde inte skicka meddelandet' }
    }
    return { ok: true, channels: ['email'] }
  } catch (err) {
    return {
      ok: false,
      channels: [],
      error: err instanceof Error ? err.message : 'Nätverksfel',
    }
  }
}
