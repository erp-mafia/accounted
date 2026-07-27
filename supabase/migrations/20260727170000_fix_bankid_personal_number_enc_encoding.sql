-- Fix bankid_identities.personal_number_enc rows written through supabase-js
-- with a raw Buffer (issue #1232). PostgREST serialized the Buffer as JSON,
-- so the bytea column holds the literal UTF-8 text
--   {"type":"Buffer","data":[...]}
-- instead of the raw iv|tag|ciphertext bytes that decryptPersonalNumber()
-- expects. Rewrite those rows to the raw bytes recovered from the JSON
-- "data" array.
--
-- The WHERE guard uses CASE, not AND: Postgres does not guarantee AND
-- evaluation order, and convert_from() must never run on a row already
-- holding raw ciphertext (not valid UTF-8), such as one written by the
-- fixed code between deploy and apply, or any row on a re-run. CASE
-- guarantees the byte-prefix check gates the convert_from call, keeping
-- the migration idempotent and race-safe.

UPDATE bankid_identities
SET personal_number_enc = (
  SELECT decode(string_agg(lpad(to_hex(elem::int), 2, '0'), '' ORDER BY ord), 'hex')
  FROM jsonb_array_elements_text(
    convert_from(personal_number_enc, 'UTF8')::jsonb -> 'data'
  ) WITH ORDINALITY AS t(elem, ord)
)
WHERE CASE
  WHEN substring(personal_number_enc FROM 1 FOR 16) = convert_to('{"type":"Buffer"', 'UTF8')
  THEN jsonb_array_length(convert_from(personal_number_enc, 'UTF8')::jsonb -> 'data') > 0
  ELSE false
END;
