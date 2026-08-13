-- Register the behandlingshistorik events emitted when the WhatsApp intake
-- asks the sender a follow-up question, gets an answer, or lets the question
-- expire (extensions/general/whatsapp-inbox/lib/item-context.ts).
--
-- processing_history.event_type has an FK to processing_event_types, so an
-- unregistered type fails the insert. appendQuestionHistory() swallows that
-- failure by design (the reply to the sender must go out either way), which
-- is why this went unnoticed: every question asked over WhatsApp has been
-- logging "question history append failed" in production instead of leaving
-- the durable record. The conversation with the sender IS part of how the
-- underlag was obtained, so it belongs in the history (BFNAR 2013:2 kap 8).
--
-- Catalog rows only: aggregate_type 'System' is already permitted by the
-- aggregate_type CHECK, so no constraint change is needed.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('ChannelQuestionAsked'),
  ('ChannelQuestionAnswered'),
  ('ChannelQuestionExpired')
ON CONFLICT (event_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
