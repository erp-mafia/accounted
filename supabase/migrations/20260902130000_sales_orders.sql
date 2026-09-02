-- Kundorder (sales orders): the document between "agreed" and "faktura".
--
-- A sales order is a NON-ledger document: it never books, carries no BFL
-- sequence or immutability obligation, and exists so a company that delivers
-- or invoices in parts has one place that says what was ordered, what has
-- been delivered and what has been invoiced. Invoices created from an order
-- go through the ordinary invoice path (draft, F-number at finalize, booking
-- in the engine); the order only remembers which invoice lines came from
-- which order lines.
--
-- Design (kundorder plan, 2026-09-02):
--   * status is a four-state header machine: draft, confirmed, completed,
--     cancelled. Delivery state and invoicing state are two independent axes
--     DERIVED from line quantities, never stored as status values: an order
--     is normally both partially delivered and partially invoiced at once.
--   * invoiced quantity is NOT a stored counter. Every invoice line created
--     from an order line carries invoice_items.sales_order_item_id, and the
--     invoiced quantity is the sum over linked lines whose invoice is neither
--     cancelled nor credited. A BEFORE trigger on invoice_items locks the
--     order line and refuses over-invoicing, so a counter cannot drift and a
--     credited invoice automatically frees its quantity for re-invoicing.
--   * completion (confirmed <-> completed) is maintained by AFTER triggers on
--     invoice_items and invoices.status from the same derived quantity, so a
--     cancelled or deleted draft reopens the order without application code.
--   * delivered_qty IS stored (there is no delivery document to derive it
--     from); delivery registration is an explicit user action.
--   * no inventory. Articles stay a non-inventory register; lines freeze the
--     article's description/unit/price/vat/revenue_account like invoice_items.
--
-- Naming note: the existing /orders page and the `sales_orders` nav label
-- key belong to webshop_orders (store-sync mirror, service-role INSERT only).
-- This table is user-authored and lives at /sales-orders.

-- =============================================================================
-- 1. sales_orders
-- =============================================================================
CREATE TABLE public.sales_orders (
  id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id             uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  order_number            text,
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'confirmed', 'completed', 'cancelled')),
  -- The proforma this order was created from (proforma -> order conversion);
  -- informational back-pointer only.
  source_invoice_id       uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  order_date              date NOT NULL DEFAULT CURRENT_DATE,
  requested_delivery_date date,
  -- Latest registered delivery date; becomes the invoice's delivery_date
  -- (taxable event, ML 8 kap 21-23 §) when an invoice is created from the order.
  last_delivery_date      date,
  currency                text NOT NULL DEFAULT 'SEK' REFERENCES public.currencies(code),
  subtotal                numeric NOT NULL DEFAULT 0,
  vat_amount              numeric NOT NULL DEFAULT 0,
  total                   numeric NOT NULL DEFAULT 0,
  your_reference          text,
  our_reference           text,
  notes                   text,
  -- Dimensions bag applied to every invoice created from the order.
  default_dimensions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at            timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company sales_orders"
  ON public.sales_orders FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company sales_orders"
  ON public.sales_orders FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company sales_orders"
  ON public.sales_orders FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company sales_orders"
  ON public.sales_orders FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_sales_orders_company_id ON public.sales_orders (company_id);
CREATE INDEX idx_sales_orders_company_status ON public.sales_orders (company_id, status, order_date DESC);
CREATE INDEX idx_sales_orders_customer_id ON public.sales_orders (customer_id);
CREATE INDEX idx_sales_orders_source_invoice_id ON public.sales_orders (source_invoice_id);
CREATE UNIQUE INDEX uq_sales_orders_company_number
  ON public.sales_orders (company_id, order_number) WHERE order_number IS NOT NULL;

CREATE TRIGGER set_updated_at_sales_orders
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. sales_order_items
-- =============================================================================
CREATE TABLE public.sales_order_items (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Own company_id (defense in depth alongside the parent join): the
  -- over-invoice trigger compares it against the invoice's company.
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  sales_order_id   uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  sort_order       integer NOT NULL DEFAULT 0,
  line_type        text NOT NULL DEFAULT 'product' CHECK (line_type IN ('product', 'text')),
  description      text NOT NULL DEFAULT '',
  quantity         numeric NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  delivered_qty    numeric NOT NULL DEFAULT 0 CHECK (delivered_qty >= 0),
  unit             text NOT NULL DEFAULT 'st',
  unit_price       numeric NOT NULL DEFAULT 0,
  discount_percent numeric NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  vat_rate         numeric NOT NULL DEFAULT 25,
  -- NET of discount, order currency (same formula as invoice_items.line_total).
  line_total       numeric NOT NULL DEFAULT 0,
  article_id       uuid REFERENCES public.articles(id) ON DELETE SET NULL,
  -- Frozen copy of the article's posting-account override at line-create time.
  revenue_account  text,
  dimensions       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_items_delivered_within_ordered CHECK (delivered_qty <= quantity)
);

ALTER TABLE public.sales_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company sales_order_items"
  ON public.sales_order_items FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company sales_order_items"
  ON public.sales_order_items FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company sales_order_items"
  ON public.sales_order_items FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company sales_order_items"
  ON public.sales_order_items FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_sales_order_items_order ON public.sales_order_items (sales_order_id, sort_order);
CREATE INDEX idx_sales_order_items_company_id ON public.sales_order_items (company_id);
CREATE INDEX idx_sales_order_items_article_id ON public.sales_order_items (article_id);

CREATE TRIGGER set_updated_at_sales_order_items
  BEFORE UPDATE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. company_settings: module toggle + per-company order-number counter
-- =============================================================================
-- sales_orders_enabled is a UI-visibility gate only (same contract as
-- dimensions_enabled / mileage_enabled): the pages and APIs work regardless.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS sales_orders_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_sales_order_number integer NOT NULL DEFAULT 1;

-- =============================================================================
-- 4. invoices / invoice_items back-links
-- =============================================================================
-- RESTRICT on both: an order with invoices can be cancelled but never
-- deleted, so the invoice's provenance survives (the invoice is
-- räkenskapsinformation; its source order is context a revisor may ask for).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoices_sales_order_id
  ON public.invoices (sales_order_id) WHERE sales_order_id IS NOT NULL;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS sales_order_item_id uuid REFERENCES public.sales_order_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_items_sales_order_item_id
  ON public.invoice_items (sales_order_item_id) WHERE sales_order_item_id IS NOT NULL;

-- =============================================================================
-- 5. generate_sales_order_number RPC: atomic + idempotent
--    (clone of generate_article_number incl. the 20260901100000 hardening:
--     membership check, empty search_path, no anon/PUBLIC execute).
--    Orders are not verifikationer, so gaps are legally irrelevant; the
--    number is allocated at creation.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_sales_order_number(
  p_company_id uuid,
  p_order_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing text;
  v_number integer;
  v_final text;
  v_trusted boolean;
BEGIN
  -- Same fail-closed gate as generate_article_number after 20260901100000:
  -- a JWT with a role but no sub (the anon key) is refused; a direct DB
  -- connection with no claims at all (migrations, pg tests) is trusted.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );
  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT order_number INTO v_existing
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order % not found in company %', p_order_id, p_company_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  UPDATE public.company_settings
  SET next_sales_order_number = next_sales_order_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_sales_order_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_final := 'OR-' || v_number::text;

  UPDATE public.sales_orders
  SET order_number = v_final
  WHERE id = p_order_id AND company_id = p_company_id;

  RETURN v_final;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_sales_order_number(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_sales_order_number(uuid, uuid) TO authenticated, service_role;

-- =============================================================================
-- 6. Derived invoiced quantity (read side, SECURITY INVOKER: RLS applies)
-- =============================================================================
-- One row per order line with the quantity already invoiced. Linked lines on
-- cancelled or credited invoices do not count, so a makulerad draft or a
-- fully credited invoice frees the quantity again. Credit notes never link
-- to order lines (they reference the invoice they credit), but the
-- credited_invoice_id guard keeps a hand-linked one from netting a line.
CREATE OR REPLACE FUNCTION public.sales_order_invoiced_quantities(p_order_ids uuid[])
RETURNS TABLE (sales_order_id uuid, sales_order_item_id uuid, invoiced_qty numeric)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT soi.sales_order_id,
         soi.id AS sales_order_item_id,
         COALESCE(SUM(ii.quantity) FILTER (
           WHERE i.id IS NOT NULL
             AND i.status NOT IN ('cancelled', 'credited')
             AND i.credited_invoice_id IS NULL
         ), 0) AS invoiced_qty
  FROM public.sales_order_items soi
  LEFT JOIN public.invoice_items ii ON ii.sales_order_item_id = soi.id
  LEFT JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE soi.sales_order_id = ANY (p_order_ids)
  GROUP BY soi.sales_order_id, soi.id
$$;

REVOKE EXECUTE ON FUNCTION public.sales_order_invoiced_quantities(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_order_invoiced_quantities(uuid[]) TO authenticated, service_role;

-- =============================================================================
-- 7. Over-invoicing guard on invoice_items (BEFORE INSERT/UPDATE)
-- =============================================================================
-- Locks the order line so two concurrent invoice creations serialize, then
-- refuses a linked line whose quantity would push the invoiced total past the
-- ordered quantity. SECURITY DEFINER because the sum must see every linked
-- line regardless of the caller's RLS view; the company check keeps a line
-- from linking across tenants.
CREATE OR REPLACE FUNCTION public.enforce_sales_order_item_invoiced_qty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_ordered numeric;
  v_item_company uuid;
  v_invoice_company uuid;
  v_invoice_status text;
  v_other numeric;
BEGIN
  IF NEW.sales_order_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT soi.quantity, soi.company_id
  INTO v_ordered, v_item_company
  FROM public.sales_order_items soi
  WHERE soi.id = NEW.sales_order_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALES_ORDER_ITEM_NOT_FOUND: order line % does not exist', NEW.sales_order_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT i.company_id, i.status
  INTO v_invoice_company, v_invoice_status
  FROM public.invoices i
  WHERE i.id = NEW.invoice_id;

  IF v_invoice_company IS DISTINCT FROM v_item_company THEN
    RAISE EXCEPTION 'SALES_ORDER_ITEM_COMPANY_MISMATCH: invoice and order line belong to different companies'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A line on an already cancelled/credited invoice does not count and is
  -- not counted against; nothing to enforce.
  IF v_invoice_status IN ('cancelled', 'credited') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0)
  INTO v_other
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE ii.sales_order_item_id = NEW.sales_order_item_id
    AND ii.id <> NEW.id
    AND i.status NOT IN ('cancelled', 'credited')
    AND i.credited_invoice_id IS NULL;

  IF v_other + NEW.quantity > v_ordered THEN
    RAISE EXCEPTION 'SALES_ORDER_OVER_INVOICED: order line % has % of % already invoiced, cannot add %',
      NEW.sales_order_item_id, v_other, v_ordered, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_sales_order_item_invoiced_qty
  BEFORE INSERT OR UPDATE OF quantity, sales_order_item_id, invoice_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_order_item_invoiced_qty();

-- =============================================================================
-- 8. Order line guards: quantity never below what is invoiced; a line with
--    linked invoice lines cannot be deleted (RESTRICT FK already does that).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_sales_order_item_quantity_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_invoiced numeric;
BEGIN
  IF NEW.quantity >= OLD.quantity THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(ii.quantity), 0)
  INTO v_invoiced
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE ii.sales_order_item_id = NEW.id
    AND i.status NOT IN ('cancelled', 'credited')
    AND i.credited_invoice_id IS NULL;

  IF NEW.quantity < v_invoiced THEN
    RAISE EXCEPTION 'SALES_ORDER_QUANTITY_BELOW_INVOICED: order line % has % invoiced, cannot reduce to %',
      NEW.id, v_invoiced, NEW.quantity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_sales_order_item_quantity_floor
  BEFORE UPDATE OF quantity ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_order_item_quantity_floor();

-- =============================================================================
-- 9. Completion maintenance: confirmed <-> completed from derived quantities
-- =============================================================================
-- An order is completed when it has at least one product line with a
-- positive quantity and every such line is fully invoiced. Runs after any
-- change to a linked invoice line or to a linked invoice's status, so
-- makulering / crediting / draft deletion reopens the order. Draft and
-- cancelled orders are never touched.
CREATE OR REPLACE FUNCTION public.refresh_sales_order_completion(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_company uuid;
  v_trusted boolean;
  v_has_lines boolean;
  v_open_lines boolean;
  v_complete boolean;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN;
  END IF;

  -- Callable by authenticated (the confirm transition invokes it directly),
  -- so it carries the same fail-closed membership gate as the numbering
  -- RPCs. Trigger invocations run under the DML user's claims (a member's)
  -- or under a trusted no-claims connection.
  SELECT company_id INTO v_company FROM public.sales_orders WHERE id = p_order_id;
  IF v_company IS NULL THEN
    RETURN;
  END IF;
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );
  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = v_company
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', v_company
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sales_order_items soi
    WHERE soi.sales_order_id = p_order_id AND soi.line_type = 'product' AND soi.quantity > 0
  ) INTO v_has_lines;

  SELECT EXISTS (
    SELECT 1
    FROM public.sales_order_items soi
    WHERE soi.sales_order_id = p_order_id
      AND soi.line_type = 'product'
      AND soi.quantity > 0
      AND soi.quantity > (
        SELECT COALESCE(SUM(ii.quantity), 0)
        FROM public.invoice_items ii
        JOIN public.invoices i ON i.id = ii.invoice_id
        WHERE ii.sales_order_item_id = soi.id
          AND i.status NOT IN ('cancelled', 'credited')
          AND i.credited_invoice_id IS NULL
      )
  ) INTO v_open_lines;

  v_complete := v_has_lines AND NOT v_open_lines;

  UPDATE public.sales_orders so
  SET status = CASE WHEN v_complete THEN 'completed' ELSE 'confirmed' END,
      completed_at = CASE WHEN v_complete THEN COALESCE(so.completed_at, now()) ELSE NULL END
  WHERE so.id = p_order_id
    AND so.status IN ('confirmed', 'completed')
    AND so.status IS DISTINCT FROM (CASE WHEN v_complete THEN 'completed' ELSE 'confirmed' END);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_sales_order_completion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_sales_order_completion(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sales_order_completion_from_invoice_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_item uuid;
  v_order uuid;
BEGIN
  v_item := COALESCE(NEW.sales_order_item_id, OLD.sales_order_item_id);
  IF v_item IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT sales_order_id INTO v_order FROM public.sales_order_items WHERE id = v_item;
  PERFORM public.refresh_sales_order_completion(v_order);
  -- A re-link from one order line to another refreshes both orders.
  IF TG_OP = 'UPDATE' AND NEW.sales_order_item_id IS DISTINCT FROM OLD.sales_order_item_id
     AND OLD.sales_order_item_id IS NOT NULL THEN
    SELECT sales_order_id INTO v_order FROM public.sales_order_items WHERE id = OLD.sales_order_item_id;
    PERFORM public.refresh_sales_order_completion(v_order);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER sales_order_completion_from_invoice_items
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_completion_from_invoice_items();

CREATE OR REPLACE FUNCTION public.sales_order_completion_from_invoice_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Resolve the affected orders through the LINE links, not the header
    -- back-pointer, so a hand-linked line on an invoice without
    -- sales_order_id still keeps its order's completion honest.
    PERFORM public.refresh_sales_order_completion(o.sales_order_id)
    FROM (
      SELECT DISTINCT soi.sales_order_id
      FROM public.invoice_items ii
      JOIN public.sales_order_items soi ON soi.id = ii.sales_order_item_id
      WHERE ii.invoice_id = NEW.id
    ) o;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER sales_order_completion_from_invoice_status
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_completion_from_invoice_status();

-- Confirming an order whose lines are already fully invoiced (hand-linked
-- lines) or changing line quantities also re-evaluates completion.
CREATE OR REPLACE FUNCTION public.sales_order_completion_from_order_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.refresh_sales_order_completion(COALESCE(NEW.sales_order_id, OLD.sales_order_id));
  RETURN NULL;
END;
$function$;

CREATE TRIGGER sales_order_completion_from_order_items
  AFTER INSERT OR UPDATE OF quantity, line_type OR DELETE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_completion_from_order_items();

COMMENT ON TABLE public.sales_orders IS
  'Kundorder: non-ledger sales document between quote/agreement and invoice. Never books; invoices created from it go through the normal invoice path.';
COMMENT ON COLUMN public.invoice_items.sales_order_item_id IS
  'Order line this invoice line was created from. The invoiced quantity of an order line is derived from these links (sales_order_invoiced_quantities); never stored.';

NOTIFY pgrst, 'reload schema';
