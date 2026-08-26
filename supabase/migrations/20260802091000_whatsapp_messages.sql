-- WhatsApp channel, part 2/3: conversations, message log, sender quota.
--
-- whatsapp_messages doubles as the durable job record for inbound
-- processing (persist-first webhook: insert row, ack 200, process via
-- after(), per-minute sweep cron re-claims stuck rows). The partial unique
-- index on inbound wamid is THE idempotency key: Meta redelivers with
-- backoff for up to 7 days, so duplicates are normal operation.
--
-- All three tables are service-role only (RLS enabled, no policies):
-- rows contain third-party PII (phone hashes, chat text) with no company
-- scope, and no UI reads them directly in v1. A retention cron purges
-- body_text/raw_payload after 90 days and unknown-sender rows after 30.

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_link_id             uuid NOT NULL REFERENCES public.whatsapp_phone_links(id) ON DELETE CASCADE,

  -- Deterministic state machine (LLM-last). unlinked/muted are NOT states:
  -- unlinked = no whatsapp_phone_links row, muted = phone_links.muted_at.
  state                     text NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle','awaiting_company','awaiting_representation','awaiting_context','awaiting_resend')),
  -- Pending question payload, staged media refs, question budget counters.
  context                   jsonb NOT NULL DEFAULT '{}',

  -- Company pinned by an in-chat choice (8h sliding TTL enforced in code).
  company_id                uuid REFERENCES public.companies(id) ON DELETE SET NULL,

  -- last inbound + 24h: outside it the bot must not send (no templates in v1).
  service_window_expires_at timestamptz,
  -- Image-burst debounce: each media message pushes this forward; the
  -- invocation whose deadline survives claims the combined ack via
  -- UPDATE ... WHERE pending_ack AND debounce_until <= now().
  debounce_until            timestamptz,
  pending_ack               boolean NOT NULL DEFAULT false,

  last_inbound_at           timestamptz,
  last_outbound_at          timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_conversations_link
  ON public.whatsapp_conversations (phone_link_id);

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER whatsapp_conversations_updated_at
  BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  direction          text NOT NULL CHECK (direction IN ('inbound','outbound')),
  -- Meta's message id. Outbound rows get theirs from the send response.
  wamid              text,
  -- HMAC phone hash, set even for unknown senders (pre-binding rate limit
  -- + greeting throttle key). Never the raw number.
  sender_phone_hash  text,
  phone_link_id      uuid REFERENCES public.whatsapp_phone_links(id) ON DELETE SET NULL,
  conversation_id    uuid REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL,

  message_type       text NOT NULL,
  body_text          text,
  media_id           text,
  media_mime         text,
  media_sha256       text,
  media_filename     text,
  -- value.messages[i] verbatim for known senders; NULL for unknown senders
  -- (no content retention pre-binding). Purged by the retention cron.
  raw_payload        jsonb,

  -- The durable-job half: received -> processing -> done|skipped|error.
  processing_status  text NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processing','done','skipped','error')),
  attempts           integer NOT NULL DEFAULT 0,
  error_message      text,

  -- Set once intake created the Underlag row (quoted-reply resolution:
  -- a reply quoting an ack maps back to its receipt through this).
  inbox_item_id      uuid REFERENCES public.invoice_inbox_items(id) ON DELETE SET NULL,
  -- Outbound delivery lifecycle from statuses[] webhooks.
  delivery_status    text,
  correlation_id     uuid,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: at-least-once delivery dedupes here (inbound only; outbound
-- wamids are ours and unique by construction, but stay unconstrained since
-- a failed send may never get one).
CREATE UNIQUE INDEX whatsapp_messages_inbound_wamid
  ON public.whatsapp_messages (wamid)
  WHERE wamid IS NOT NULL AND direction = 'inbound';

-- Sweep cron: claim received rows and processing rows stuck >90s.
CREATE INDEX whatsapp_messages_sweep
  ON public.whatsapp_messages (processing_status, created_at)
  WHERE processing_status IN ('received','processing');

CREATE INDEX whatsapp_messages_sender
  ON public.whatsapp_messages (sender_phone_hash, created_at);

CREATE INDEX whatsapp_messages_conversation
  ON public.whatsapp_messages (conversation_id, created_at);

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER whatsapp_messages_updated_at
  BEFORE UPDATE ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Pre-binding sender quota: the missing limiter keyed by phone hash (the
-- per-company inbox quota can't apply before a sender resolves to a
-- company). Clone of check_and_increment_inbox_quota (20260512083712).
CREATE TABLE IF NOT EXISTS public.whatsapp_sender_rate_counters (
  phone_hash   text NOT NULL,
  window_kind  text NOT NULL CHECK (window_kind IN ('minute','day')),
  window_key   text NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_hash, window_kind, window_key)
);

ALTER TABLE public.whatsapp_sender_rate_counters ENABLE ROW LEVEL SECURITY;
-- No user-facing policies: only the SECURITY DEFINER fn below writes this.

CREATE OR REPLACE FUNCTION public.check_and_increment_whatsapp_sender_quota(
  p_phone_hash  text,
  p_minute_max  integer,
  p_day_max     integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
BEGIN
  INSERT INTO public.whatsapp_sender_rate_counters (phone_hash, window_kind, window_key, count)
  VALUES (p_phone_hash, 'minute', v_minute_key, 1)
  ON CONFLICT (phone_hash, window_kind, window_key)
  DO UPDATE SET count = whatsapp_sender_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.whatsapp_sender_rate_counters
      SET count = count - 1
      WHERE phone_hash = p_phone_hash
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  INSERT INTO public.whatsapp_sender_rate_counters (phone_hash, window_kind, window_key, count)
  VALUES (p_phone_hash, 'day', v_day_key, 1)
  ON CONFLICT (phone_hash, window_kind, window_key)
  DO UPDATE SET count = whatsapp_sender_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    UPDATE public.whatsapp_sender_rate_counters
      SET count = count - 1
      WHERE phone_hash = p_phone_hash
        AND window_kind = 'day'
        AND window_key = v_day_key;
    UPDATE public.whatsapp_sender_rate_counters
      SET count = count - 1
      WHERE phone_hash = p_phone_hash
        AND window_kind = 'minute'
        AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Only the webhook path (service role) calls this. A SECURITY DEFINER fn
-- reachable from anon/authenticated would be a quota-drain primitive
-- (lesson from check_and_increment_agent_quota, migration 20260726090000).
REVOKE ALL ON FUNCTION public.check_and_increment_whatsapp_sender_quota(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_and_increment_whatsapp_sender_quota(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_and_increment_whatsapp_sender_quota(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_whatsapp_sender_quota(text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
