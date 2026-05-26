-- Track when an inbox item bypassed the AI extraction step. Two paths set
-- this to true: (1) a client (MCP/agent) passing skip_extraction=true to the
-- upload endpoint, (2) the server-side page-count gate skipping extraction
-- for PDFs above MAX_PAGES_FOR_AUTO_EXTRACT (avoids minute-long Bedrock waits
-- on documents that aren't receipt-shaped, e.g. sales reports, contracts).
-- The UI uses this column to render an "Inte AI-tolkad" badge distinct from
-- the "Felaktig" failure state (status='error').

ALTER TABLE public.invoice_inbox_items
  ADD COLUMN extraction_skipped boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
