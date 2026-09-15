-- =============================================================================
-- Apartment register of a bostadsrättsförening (BRL 1991:614 9 kap. 8-11 §§)
-- with the minimum a KU55 needs (SFL 22 kap.; Skatteverket, "Kontrolluppgift
-- om överlåtelse av bostadsrätt", KU55, XML schema Kontrolluppgifter 12.0).
--
-- BRL 9 kap. 8 §: the board keeps a medlemsförteckning and a lägenhets-
-- förteckning. 9 kap. 9 §: the medlemsförteckning states every member's name
-- and postal address, the date of admission and the bostadsrätt the member
-- holds; that register is association_members from 20260915160000 (EFL 5
-- kap. applies to a BRF, BRL 1 kap. 1 §), so no second member table is
-- created. 9 kap. 10 §: the lägenhetsförteckning states for every apartment
-- (1) beteckning, belägenhet, rumsantal and övriga utrymmen, (2) the date
-- Bolagsverket registered the ekonomisk plan behind the upplåtelse, (3) the
-- bostadsrättshavare's name and (4) the insats; a pantsättning is noted in
-- the register with its date. 9 kap. 11 §: both registers are kept available
-- at the association; a bostadsrättshavare may ask for an extract.
-- 6 kap. 5 §: a transfer is void if the acquirer is refused membership, and
-- 2 kap. 3 § gives the acquirer a right to membership when the stadgar
-- conditions are met: record_brf_transfer() therefore refuses a buyer who is
-- not an admitted member of the association on the transfer date.
--
-- Four tables, company-scoped and RLS-protected like association_members:
--   brf_apartments: the lägenhetsförteckning rows (no DELETE: an apartment
--     that ceases to exist gets a note, the register is history).
--   brf_apartment_holdings: who holds which share of an apartment and when;
--     joint holders are several open rows, history is closed rows (to_date).
--     A trigger keeps the open shares of one apartment at or below 1.
--   brf_apartment_transfers: append-only (no UPDATE or DELETE grant) record
--     of every överlåtelse with the KU55 data points, the överlåtelseavtal
--     as a WORM document_attachments reference (BRL 9 kap. 10 § third
--     paragraph, retained seven years, BFL 7 kap.).
--   brf_pledges: pantsättning notices (BRL 9 kap. 10 §), released by date,
--     never deleted.
-- association_members gains personal_number_ciphertext: the KU55 identifies
-- the överlåtare by personnummer (fältkod 215); it is stored encrypted with
-- the same helper as customers.personal_number and never selected by the
-- register listings.
--
-- Avisering, autogiro, the member ledger and mäklarbild (research doc phase
-- B3) are out of scope; the register above is what phase B1 needs for the
-- lägenhetsförteckning extract, the member-capital reconciliation and KU55.
-- =============================================================================

ALTER TABLE public.association_members
  ADD COLUMN IF NOT EXISTS personal_number_ciphertext TEXT
    CHECK (personal_number_ciphertext IS NULL OR char_length(personal_number_ciphertext) <= 512);

COMMENT ON COLUMN public.association_members.personal_number_ciphertext IS
  'Personnummer of the member, encrypted with encryptPersonnummer (never plaintext): needed for KU55 fältkod 215 of a bostadsrättsförening. NULL when unknown.';

-- -----------------------------------------------------------------------------
-- brf_apartments
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_apartments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- BRL 9 kap. 10 § p. 1: the association's own beteckning; unique per company.
  apartment_number TEXT NOT NULL CHECK (char_length(apartment_number) BETWEEN 1 AND 40),
  -- Lantmäteriet's lägenhetsnummer (four digits, lag 2006:378) when known.
  lantmateriet_number TEXT CHECK (lantmateriet_number IS NULL OR lantmateriet_number ~ '^[0-9]{4}$'),
  -- Belägenhet: address, entrance, floor as free text.
  location TEXT NOT NULL CHECK (char_length(location) BETWEEN 1 AND 300),
  rooms NUMERIC(4, 1) CHECK (rooms IS NULL OR rooms >= 0),
  kvm NUMERIC(10, 2) CHECK (kvm IS NULL OR kvm >= 0),
  -- Övriga utrymmen (förråd, balkong, uteplats) as free text.
  other_spaces TEXT CHECK (other_spaces IS NULL OR char_length(other_spaces) <= 500),
  upplaten_med TEXT NOT NULL CHECK (upplaten_med IN ('bostadsratt', 'hyresratt')),
  -- Andelstal: the apartment's share of årsavgifter and of the association's
  -- capital (stadgar and ekonomisk plan); fractions 0-1 with six decimals.
  andelstal_arsavgift NUMERIC(9, 6) CHECK (andelstal_arsavgift IS NULL OR (andelstal_arsavgift >= 0 AND andelstal_arsavgift <= 1)),
  andelstal_kapital NUMERIC(9, 6) CHECK (andelstal_kapital IS NULL OR (andelstal_kapital >= 0 AND andelstal_kapital <= 1)),
  -- BRL 9 kap. 10 § p. 4 and ÅRL 3 kap. 10 b §: the insats and the
  -- upplåtelseavgift paid at the first upplåtelse (ledger 2083 and 2087).
  insats NUMERIC(15, 2) CHECK (insats IS NULL OR insats >= 0),
  upplatelseavgift NUMERIC(15, 2) CHECK (upplatelseavgift IS NULL OR upplatelseavgift >= 0),
  upplatelse_date DATE,
  -- BRL 9 kap. 10 § p. 2: Bolagsverket's registration date of the ekonomisk plan.
  ekonomisk_plan_registered_on DATE,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brf_apartments_number_unique UNIQUE (company_id, apartment_number)
);

COMMENT ON TABLE public.brf_apartments IS
  'Lägenhetsförteckning för bostadsrättsförening (BRL 9 kap. 10 §): beteckning, belägenhet, rum, övriga utrymmen, ekonomisk plan, insats. Never deleted.';

CREATE INDEX IF NOT EXISTS idx_brf_apartments_company
  ON public.brf_apartments (company_id, apartment_number);

-- -----------------------------------------------------------------------------
-- brf_apartment_transfers (append-only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_apartment_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  apartment_id UUID NOT NULL REFERENCES public.brf_apartments(id) ON DELETE RESTRICT,
  -- KU55 fältkod 631: the date the parties signed the överlåtelseavtal.
  transfer_date DATE NOT NULL,
  -- sale: köp; gift, arv, bodelning: KU55 fältkod 633 is set; other: e.g.
  -- byte or testamente (also 633 per Skatteverket, "arv, gåva, bodelning eller liknande").
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'gift', 'arv', 'bodelning', 'other')),
  -- KU55 632: the share of the bostadsrätt that changed hands, 0 < share <= 1.
  share NUMERIC(9, 6) NOT NULL CHECK (share > 0 AND share <= 1),
  from_member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  to_member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  -- KU55 634 (whole kronor at filing; stored with ören as agreed). NULL for a
  -- gift, arv or bodelning.
  price NUMERIC(15, 2) CHECK (price IS NULL OR price >= 0),
  -- KU55 639 Tilläggsköpeskilling.
  additional_price NUMERIC(15, 2) CHECK (additional_price IS NULL OR additional_price >= 0),
  -- KU55 640, 642, 643: how and when the överlåtare acquired the share.
  forvarv_date DATE,
  forvarv_genom_arv_gava_bodelning BOOLEAN NOT NULL DEFAULT false,
  forvarv_price NUMERIC(15, 2) CHECK (forvarv_price IS NULL OR forvarv_price >= 0),
  -- KU55 636: the bostadsrätt's share of the association's amortisation and
  -- financed improvements during the överlåtare's holding (IL 46 kap. 7 §);
  -- computed by the board or its förvaltare, entered here.
  kapitaltillskott NUMERIC(15, 2) CHECK (kapitaltillskott IS NULL OR kapitaltillskott >= 0),
  -- KU55 635 and 644: inre reparationsfond at överlåtelse and at förvärv.
  inre_fond_vid_overlatelse NUMERIC(15, 2) CHECK (inre_fond_vid_overlatelse IS NULL OR inre_fond_vid_overlatelse >= 0),
  inre_fond_vid_forvarv NUMERIC(15, 2) CHECK (inre_fond_vid_forvarv IS NULL OR inre_fond_vid_forvarv >= 0),
  -- KU55 645: share of the association's net wealth on 1974-01-01 (only for
  -- bostadsrätter acquired before 1974).
  andel_formogenhet_1974 NUMERIC(15, 2) CHECK (andel_formogenhet_1974 IS NULL OR andel_formogenhet_1974 >= 0),
  -- KU55 646: G when the figures are shared by joint holders, I when each
  -- överlåtare's figures are individual.
  ku55_uppgifter TEXT NOT NULL DEFAULT 'I' CHECK (ku55_uppgifter IN ('G', 'I')),
  -- The signed överlåtelseavtal in the WORM archive (BRL 9 kap. 10 §).
  agreement_document_id UUID REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brf_apartment_transfers_parties_differ CHECK (from_member_id <> to_member_id),
  CONSTRAINT brf_apartment_transfers_price_kind CHECK (kind = 'sale' OR price IS NULL OR price = 0)
);

COMMENT ON TABLE public.brf_apartment_transfers IS
  'Överlåtelser av bostadsrätt (BRL 6 kap.) with the KU55 data points (SFL 22 kap.). Append-only: no update, no delete.';

CREATE INDEX IF NOT EXISTS idx_brf_apartment_transfers_company_date
  ON public.brf_apartment_transfers (company_id, transfer_date);
CREATE INDEX IF NOT EXISTS idx_brf_apartment_transfers_apartment
  ON public.brf_apartment_transfers (apartment_id, transfer_date);

-- -----------------------------------------------------------------------------
-- brf_apartment_holdings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_apartment_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  apartment_id UUID NOT NULL REFERENCES public.brf_apartments(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  share NUMERIC(9, 6) NOT NULL CHECK (share > 0 AND share <= 1),
  from_date DATE NOT NULL,
  to_date DATE CHECK (to_date IS NULL OR to_date >= from_date),
  -- The transfer that opened this holding; NULL for the first upplåtelse.
  acquired_by_transfer_id UUID REFERENCES public.brf_apartment_transfers(id) ON DELETE RESTRICT,
  -- The transfer that closed it; NULL while open or when closed by hand.
  closed_by_transfer_id UUID REFERENCES public.brf_apartment_transfers(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.brf_apartment_holdings IS
  'Who holds which share of a bostadsrätt and when (BRL 9 kap. 10 § p. 3). Joint holders are several open rows; history is kept as closed rows.';

CREATE INDEX IF NOT EXISTS idx_brf_apartment_holdings_apartment_open
  ON public.brf_apartment_holdings (apartment_id) WHERE to_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_brf_apartment_holdings_member
  ON public.brf_apartment_holdings (member_id);

-- The open shares of one apartment never exceed the whole. Serialised per
-- apartment by the advisory lock in record_brf_transfer(); the trigger is the
-- backstop for direct inserts through the API.
CREATE OR REPLACE FUNCTION public.brf_apartment_holdings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_open NUMERIC;
  v_apartment_company UUID;
  v_member_company UUID;
BEGIN
  SELECT company_id INTO v_apartment_company FROM public.brf_apartments WHERE id = NEW.apartment_id;
  SELECT company_id INTO v_member_company FROM public.association_members WHERE id = NEW.member_id;
  IF v_apartment_company IS NULL OR v_apartment_company <> NEW.company_id
     OR v_member_company IS NULL OR v_member_company <> NEW.company_id THEN
    RAISE EXCEPTION 'brf_apartment_holdings: apartment and member must belong to the holding''s company'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.to_date IS NULL THEN
    SELECT COALESCE(SUM(share), 0) INTO v_open
    FROM public.brf_apartment_holdings
    WHERE apartment_id = NEW.apartment_id
      AND to_date IS NULL
      AND id <> NEW.id;
    IF v_open + NEW.share > 1.000001 THEN
      RAISE EXCEPTION 'brf_apartment_holdings: open shares of apartment % would exceed 1 (% + %)',
        NEW.apartment_id, v_open, NEW.share
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brf_apartment_holdings_guard ON public.brf_apartment_holdings;
CREATE TRIGGER brf_apartment_holdings_guard
  BEFORE INSERT OR UPDATE ON public.brf_apartment_holdings
  FOR EACH ROW EXECUTE FUNCTION public.brf_apartment_holdings_guard();

-- -----------------------------------------------------------------------------
-- brf_pledges (pantsättning, BRL 9 kap. 10 §)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_pledges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  apartment_id UUID NOT NULL REFERENCES public.brf_apartments(id) ON DELETE RESTRICT,
  -- The pantsättare when known (a holder of the apartment).
  member_id UUID REFERENCES public.association_members(id) ON DELETE RESTRICT,
  creditor TEXT NOT NULL CHECK (char_length(creditor) BETWEEN 1 AND 200),
  -- The date the association was notified (denuntiation); BRL 9 kap. 10 §
  -- requires the date of the note in the register.
  notified_on DATE NOT NULL,
  reference TEXT CHECK (reference IS NULL OR char_length(reference) <= 120),
  released_on DATE CHECK (released_on IS NULL OR released_on >= notified_on),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.brf_pledges IS
  'Pantsättningar antecknade i lägenhetsförteckningen (BRL 9 kap. 10 §): creditor, notification date, release date. Never deleted.';

CREATE INDEX IF NOT EXISTS idx_brf_pledges_apartment_open
  ON public.brf_pledges (apartment_id) WHERE released_on IS NULL;

-- updated_at triggers
DROP TRIGGER IF EXISTS brf_apartments_updated_at ON public.brf_apartments;
CREATE TRIGGER brf_apartments_updated_at
  BEFORE UPDATE ON public.brf_apartments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS brf_apartment_holdings_updated_at ON public.brf_apartment_holdings;
CREATE TRIGGER brf_apartment_holdings_updated_at
  BEFORE UPDATE ON public.brf_apartment_holdings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS brf_pledges_updated_at ON public.brf_pledges;
CREATE TRIGGER brf_pledges_updated_at
  BEFORE UPDATE ON public.brf_pledges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- RLS: company members read; owner/admin/member write as themselves; no DELETE
-- anywhere; transfers have no UPDATE either.
-- -----------------------------------------------------------------------------
ALTER TABLE public.brf_apartments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brf_apartment_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brf_apartment_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brf_pledges ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['brf_apartments', 'brf_apartment_holdings', 'brf_apartment_transfers', 'brf_pledges'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (company_id IN (SELECT public.user_company_ids()))',
      t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
         user_id = auth.uid()
         AND company_id IN (
           SELECT cm.company_id FROM public.company_members cm
           WHERE cm.user_id = auth.uid() AND cm.role IN (''owner'', ''admin'', ''member'')
         ))',
      t || '_insert', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['brf_apartments', 'brf_apartment_holdings', 'brf_pledges'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (
         company_id IN (
           SELECT cm.company_id FROM public.company_members cm
           WHERE cm.user_id = auth.uid() AND cm.role IN (''owner'', ''admin'', ''member'')
         ))
       WITH CHECK (
         company_id IN (
           SELECT cm.company_id FROM public.company_members cm
           WHERE cm.user_id = auth.uid() AND cm.role IN (''owner'', ''admin'', ''member'')
         ))',
      t || '_update', t);
  END LOOP;
END $$;

REVOKE DELETE ON TABLE public.brf_apartments, public.brf_apartment_holdings, public.brf_pledges FROM anon, authenticated;
REVOKE UPDATE, DELETE ON TABLE public.brf_apartment_transfers FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- record_brf_transfer(): one överlåtelse, atomically.
--
-- Guards: the caller writes for the company (owner, admin or member); the
-- apartment belongs to the company; the överlåtare holds an open share of at
-- least the transferred share on the apartment and the transfer date is not
-- before that holding began; the förvärvare is an admitted member of the
-- association on the transfer date (BRL 6 kap. 5 §: a transfer to someone
-- refused membership is void; 2 kap. 3 §), not the överlåtare, and not
-- exited. Effects: the transfer row, the överlåtare's holding closed on the
-- transfer date (a remaining share reopened from that date), the
-- förvärvare's holding opened or enlarged, one 'transfer' event per party in
-- association_member_events. Serialised per apartment by an advisory lock.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_brf_transfer(
  p_apartment_id uuid,
  p_input jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_role         text;
  v_apartment    public.brf_apartments%ROWTYPE;
  v_from         uuid;
  v_to           uuid;
  v_share        numeric;
  v_date         date;
  v_kind         text;
  v_seller       public.brf_apartment_holdings%ROWTYPE;
  v_buyer        public.brf_apartment_holdings%ROWTYPE;
  v_buyer_member public.association_members%ROWTYPE;
  v_transfer_id  uuid;
  v_remaining    numeric;
  v_buyer_share  numeric;
  v_price        numeric;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_FORBIDDEN');
  END IF;
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
  END IF;

  SELECT * INTO v_apartment FROM public.brf_apartments WHERE id = p_apartment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_APARTMENT_NOT_FOUND');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = v_apartment.company_id AND user_id = v_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_APARTMENT_NOT_FOUND');
  END IF;
  IF v_role NOT IN ('owner', 'admin', 'member') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_FORBIDDEN');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('brf_transfer:' || p_apartment_id::text, 0));

  v_from  := (p_input->>'from_member_id')::uuid;
  v_to    := (p_input->>'to_member_id')::uuid;
  v_share := (p_input->>'share')::numeric;
  v_date  := (p_input->>'transfer_date')::date;
  v_kind  := p_input->>'kind';
  v_price := NULLIF(p_input->>'price', '')::numeric;
  IF v_from IS NULL OR v_to IS NULL OR v_share IS NULL OR v_date IS NULL OR v_kind IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
  END IF;
  IF v_from = v_to THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_SAME_MEMBER');
  END IF;
  IF v_share <= 0 OR v_share > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR');
  END IF;

  -- The överlåtare: exactly one open holding per member and apartment.
  SELECT * INTO v_seller
  FROM public.brf_apartment_holdings
  WHERE apartment_id = p_apartment_id AND member_id = v_from AND to_date IS NULL
  ORDER BY from_date DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_SELLER_NOT_HOLDER');
  END IF;
  IF v_seller.share + 0.000001 < v_share THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_SHARE_EXCEEDS_HOLDING',
      'held_share', v_seller.share);
  END IF;
  IF v_date < v_seller.from_date THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_DATE_BEFORE_HOLDING',
      'holding_from', v_seller.from_date);
  END IF;

  -- The förvärvare: an admitted member of this association on the date.
  SELECT * INTO v_buyer_member
  FROM public.association_members
  WHERE id = v_to AND company_id = v_apartment.company_id;
  IF NOT FOUND OR v_buyer_member.admitted_on > v_date
     OR (v_buyer_member.exited_on IS NOT NULL AND v_buyer_member.exited_on <= v_date) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BRF_TRANSFER_BUYER_NOT_MEMBER');
  END IF;

  INSERT INTO public.brf_apartment_transfers (
    company_id, user_id, apartment_id, transfer_date, kind, share,
    from_member_id, to_member_id, price, additional_price,
    forvarv_date, forvarv_genom_arv_gava_bodelning, forvarv_price,
    kapitaltillskott, inre_fond_vid_overlatelse, inre_fond_vid_forvarv,
    andel_formogenhet_1974, ku55_uppgifter, agreement_document_id, notes
  ) VALUES (
    v_apartment.company_id, v_actor, p_apartment_id, v_date, v_kind, v_share,
    v_from, v_to,
    CASE WHEN v_kind = 'sale' THEN v_price ELSE NULL END,
    NULLIF(p_input->>'additional_price', '')::numeric,
    NULLIF(p_input->>'forvarv_date', '')::date,
    COALESCE((p_input->>'forvarv_genom_arv_gava_bodelning')::boolean, false),
    NULLIF(p_input->>'forvarv_price', '')::numeric,
    NULLIF(p_input->>'kapitaltillskott', '')::numeric,
    NULLIF(p_input->>'inre_fond_vid_overlatelse', '')::numeric,
    NULLIF(p_input->>'inre_fond_vid_forvarv', '')::numeric,
    NULLIF(p_input->>'andel_formogenhet_1974', '')::numeric,
    COALESCE(NULLIF(p_input->>'ku55_uppgifter', ''), 'I'),
    NULLIF(p_input->>'agreement_document_id', '')::uuid,
    NULLIF(p_input->>'notes', '')
  ) RETURNING id INTO v_transfer_id;

  -- Close the överlåtare's holding; reopen the remainder from the same date.
  UPDATE public.brf_apartment_holdings
  SET to_date = v_date, closed_by_transfer_id = v_transfer_id
  WHERE id = v_seller.id;
  v_remaining := round(v_seller.share - v_share, 6);
  IF v_remaining > 0.000001 THEN
    INSERT INTO public.brf_apartment_holdings (
      company_id, user_id, apartment_id, member_id, share, from_date, acquired_by_transfer_id
    ) VALUES (
      v_apartment.company_id, v_actor, p_apartment_id, v_from, v_remaining, v_date, NULL
    );
  END IF;

  -- Open or enlarge the förvärvare's holding.
  SELECT * INTO v_buyer
  FROM public.brf_apartment_holdings
  WHERE apartment_id = p_apartment_id AND member_id = v_to AND to_date IS NULL
  ORDER BY from_date DESC
  LIMIT 1
  FOR UPDATE;
  v_buyer_share := v_share;
  IF FOUND THEN
    UPDATE public.brf_apartment_holdings
    SET to_date = v_date, closed_by_transfer_id = v_transfer_id
    WHERE id = v_buyer.id;
    v_buyer_share := round(v_buyer.share + v_share, 6);
  END IF;
  INSERT INTO public.brf_apartment_holdings (
    company_id, user_id, apartment_id, member_id, share, from_date, acquired_by_transfer_id
  ) VALUES (
    v_apartment.company_id, v_actor, p_apartment_id, v_to, v_buyer_share, v_date, v_transfer_id
  );

  INSERT INTO public.association_member_events (company_id, user_id, member_id, event_type, occurred_on, details)
  VALUES
    (v_apartment.company_id, v_actor, v_from, 'transfer', v_date,
     jsonb_build_object('direction', 'out', 'apartment_id', p_apartment_id,
       'apartment_number', v_apartment.apartment_number, 'share', v_share, 'transfer_id', v_transfer_id)),
    (v_apartment.company_id, v_actor, v_to, 'transfer', v_date,
     jsonb_build_object('direction', 'in', 'apartment_id', p_apartment_id,
       'apartment_number', v_apartment.apartment_number, 'share', v_share, 'transfer_id', v_transfer_id));

  RETURN jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer_id,
    'seller_remaining_share', GREATEST(v_remaining, 0),
    'buyer_share', v_buyer_share
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_brf_transfer(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_brf_transfer(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
