CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.uuid_generate_v4()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT extensions.uuid_generate_v4();
$$;

CREATE OR REPLACE FUNCTION public.gen_random_bytes(size integer)
RETURNS bytea
LANGUAGE sql
VOLATILE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT extensions.gen_random_bytes(size);
$$;

NOTIFY pgrst, 'reload schema';
