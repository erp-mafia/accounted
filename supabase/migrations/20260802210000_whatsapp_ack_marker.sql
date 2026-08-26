-- WhatsApp conversation layer (PR4): combined-ack bookkeeping.
--
-- The burst debounce sends ONE ack (M4/M5) covering every receipt processed
-- in the window, across webhook invocations. Burst membership must therefore
-- be derivable relationally: an ingested inbound row that no combined ack has
-- covered yet. acked_at is that marker; the winner of the pending_ack claim
-- stamps it on every row its ack covered. The alternative (staging item
-- summaries in whatsapp_conversations.context jsonb) loses items under
-- concurrent read-modify-write from parallel webhook invocations.

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS acked_at timestamptz;

-- Winner query: unacked ingested rows for one conversation, oldest first.
CREATE INDEX IF NOT EXISTS whatsapp_messages_unacked
  ON public.whatsapp_messages (conversation_id, created_at)
  WHERE direction = 'inbound' AND processing_status = 'done' AND acked_at IS NULL;

NOTIFY pgrst, 'reload schema';
