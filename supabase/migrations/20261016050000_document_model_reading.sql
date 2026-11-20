-- document_attachments.model_reading: the model's own reading of a document,
-- kept when a person's correction replaces extracted_data.
--
-- document_attachments.extracted_data is what every document reader takes as
-- the reading of an underlag: Arkiv's get_record (underlag_extraction), the
-- classifier's inbox kind, the agent intents' "what do we already know". A
-- person's correction in the inbox (or an agent's set_inbox_extracted_data)
-- only reached invoice_inbox_items.extracted_data, so those readers kept the
-- model's value after a person had fixed it. The correction is now mirrored
-- onto the document row too (lib/documents/reading-correction.ts).
--
-- The suggestion log (suggestion_log, migration 20261011140008) needs the
-- opposite: what the MODEL read, to pair it with what was booked. It read that
-- from extracted_data, which only the model wrote. So the mirror first copies
-- the model's reading here, once, as {extracted_data, extraction_model,
-- extracted_at}; the snapshot (lib/suggestion-log/inbox.ts) prefers it while
-- its extracted_at still matches the row's, i.e. until a new extraction
-- replaces both.
--
-- NULL for every existing row and nothing is backfilled: until a person
-- corrects a reading, extracted_data is still the model's. Not räkenskaps-
-- information and not guarded by the immutability triggers (like
-- extracted_data); enforce_period_lock_documents still refuses the write on a
-- document whose verifikat sits in a locked period, and the mirror skips it.

ALTER TABLE public.document_attachments
  ADD COLUMN IF NOT EXISTS model_reading jsonb;

COMMENT ON COLUMN public.document_attachments.model_reading IS
  'The model''s own reading ({extracted_data, extraction_model, extracted_at}) kept when a person''s correction replaced extracted_data. Valid while extracted_at matches the row''s. NULL while extracted_data is still the model''s.';

NOTIFY pgrst, 'reload schema';
