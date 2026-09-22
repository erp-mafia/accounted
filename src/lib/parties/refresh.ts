interface SuggestResult { created: number }
interface ResolveResult { written: number }

export interface CounterpartRefreshResult {
  status: 'success' | 'partial' | 'failed'
  count: number
}

/** Both writes can succeed independently, or commit work before failing. */
export async function refreshCounterparts(
  post: <T>(url: string) => Promise<T>,
): Promise<CounterpartRefreshResult> {
  const [suggested, resolved] = await Promise.allSettled([
    post<SuggestResult>('/api/parties/suggest'),
    post<ResolveResult>('/api/parties/resolver/run'),
  ])
  const successes = Number(suggested.status === 'fulfilled') + Number(resolved.status === 'fulfilled')
  return {
    status: successes === 2 ? 'success' : successes === 1 ? 'partial' : 'failed',
    count: (suggested.status === 'fulfilled' ? suggested.value.created : 0) +
      (resolved.status === 'fulfilled' ? resolved.value.written : 0),
  }
}
