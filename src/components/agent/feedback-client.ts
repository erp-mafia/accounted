/**
 * Send one thumbs vote on an assistant answer.
 *
 * Kept out of the component so it is testable without a React harness (this
 * repo's unit project is node-only), and so the failure contract is stated in
 * one place: this resolves false rather than throwing, because a vote that
 * cannot be sent must never interrupt reading the answer it was about.
 */
export type FeedbackSentiment = 'positive' | 'negative'

export async function sendFeedback(args: {
  conversationId: string
  sentiment: FeedbackSentiment
  messageIndex?: number
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const { conversationId, sentiment, messageIndex, fetchImpl = fetch } = args
  try {
    const res = await fetchImpl('/api/agent/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: conversationId,
        sentiment,
        ...(messageIndex === undefined ? {} : { message_index: messageIndex }),
      }),
    })
    return res.ok
  } catch {
    // Offline, or the request was cut off by a navigation. Reported as a
    // failed vote so the button can go back to unpressed rather than claiming
    // a report that never arrived.
    return false
  }
}
