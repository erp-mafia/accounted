-- pg-real CI bootstrap.
--
-- The Supabase Postgres image ships a partial `storage` schema; the remaining
-- columns and functions are provisioned at runtime by the storage-api
-- service, which we do not run in CI. This bootstrap aligns the schema with
-- what our migrations expect so the replay loop succeeds. It is idempotent
-- and safe to run against a freshly-initialised container.

CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  owner       uuid,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE storage.buckets
  ADD COLUMN IF NOT EXISTS public              boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_size_limit     bigint,
  ADD COLUMN IF NOT EXISTS allowed_mime_types  text[];

CREATE TABLE IF NOT EXISTS storage.objects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id         text REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name              text,
  owner             uuid,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  last_accessed_at  timestamptz DEFAULT now(),
  metadata          jsonb,
  version           text,
  owner_id          text
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- storage.foldername(): splits a slash-delimited object name into segments.
-- Migrations use `(storage.foldername(name))[n]` to derive tenant scoping
-- from the object path.
CREATE OR REPLACE FUNCTION storage.foldername(name text)
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT string_to_array(name, '/');
$$;

-- auth.identities is created by GoTrue at startup, not by the Postgres
-- image. Likewise, GoTrue's 20240214120130 migration adds is_anonymous;
-- sandbox authorization reads this server-owned flag, not user metadata.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

-- GoTrue's 2021 alter_users migration replaced confirmed_at with
-- email_confirmed_at (+ phone_confirmed_at) on every real stack; the image's
-- init script still carries the pre-2021 shape. list_users_awaiting_lifecycle_email
-- (20260905140000) reads email_confirmed_at in a LANGUAGE sql body, which is
-- validated at definition time, so the column must exist before migrations run.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

-- auth.identities is created by GoTrue at startup, not by the Postgres
-- image, and GoTrue does not run in CI. Triggers on auth.users that touch
-- identities (20260903110000 unlink_old_address_identities) need the table
-- to exist so an email change in a pg-real test does not fail with 42P01.
-- Shape mirrors GoTrue's migration (same PK, unique key, generated email).
CREATE TABLE IF NOT EXISTS auth.identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id      text NOT NULL,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data    jsonb NOT NULL,
  provider         text NOT NULL,
  last_sign_in_at  timestamptz,
  created_at       timestamptz,
  updated_at       timestamptz,
  email            text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);

-- auth.audit_log_entries ships in the Postgres image without the ip_address
-- column GoTrue adds on first boot (NOT NULL DEFAULT '' on every hosted
-- project). unlink_old_address_identities writes GoTrue's audit table with
-- that column, so the CI double must carry it too.
ALTER TABLE IF EXISTS auth.audit_log_entries
  ADD COLUMN IF NOT EXISTS ip_address varchar(64) NOT NULL DEFAULT '';
