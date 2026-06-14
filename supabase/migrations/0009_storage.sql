-- ============================================================================
-- 0009_storage.sql
-- Supabase Storage: buckets + RLS policies for the audio layer.
-- ----------------------------------------------------------------------------
-- This migration creates the TWO storage buckets the app needs and their access
-- policies. Storage in Supabase is just two tables in the `storage` schema:
--   * storage.buckets  — one row per bucket (id == name); `public` flag controls
--                        whether objects are readable without auth via the public
--                        CDN URL.
--   * storage.objects  — one row per uploaded file. RLS on this table is how we
--                        scope who may read/write which object. Policies match on
--                        `bucket_id` and on the object `name` (the path/key).
--
-- BUCKETS
--   1. unit-audio       (PUBLIC read, service-role write):
--        Pre-generated, immutable TTS for every unit's fixed words / example
--        sentences / listening transcripts, plus foundations + word-of-the-day.
--        These are NON-secret learning assets that must be installable and
--        cacheable, so the bucket is PUBLIC (anyone can GET the CDN URL). Writes
--        are restricted to the service role (the generate-audio.mjs pipeline);
--        no anon/authenticated client may upload here. This is the storage side
--        of integrity rule 6 (ONE audio catalog: audio_clips rows point at paths
--        in THIS bucket).
--
--   2. user-recordings  (PRIVATE, per-user folder):
--        Each user's pronunciation recordings. PRIVATE — never public. A user may
--        only read/write/delete objects under their OWN top-level folder, which
--        is named after their auth uid:  {uid}/...  . Enforced by matching
--        auth.uid()::text against the first path segment via
--        (storage.foldername(name))[1]. pronunciation_attempts.recording_path
--        points here. 30-DAY RETENTION applies (see note at bottom).
--
-- ----------------------------------------------------------------------------
-- PATH CONVENTIONS (the storage_path / recording_path values the app stores)
-- ----------------------------------------------------------------------------
-- unit-audio  (PUBLIC, written by service role; audio_clips.storage_path = these)
--   units/{unitId}/words/{wordId}.mp3
--       the word's own pronunciation        (audio_clips.owner_type='word',
--                                             owner_id={wordId})
--   units/{unitId}/examples/{exampleId}.mp3
--       an example sentence for a word       (owner_type='word_example',
--                                             owner_id={exampleId})
--   units/{unitId}/listening/{clipId}.mp3
--       a listening-exercise clip transcript (owner_type='listening_clip',
--                                             owner_id={clipId})
--   word-of-the-day/{wotdId}.mp3
--       Home word-of-the-day audio           (owner_type='word_of_the_day',
--                                             owner_id={wotdId})
--   foundations/{lessonId}.mp3
--       phonics / simple-word audio. NOTE: audio_owner_type has NO 'foundations'
--       member (see 0001_enums.sql), so foundations audio lives in this bucket
--       at the path above but is NOT catalogued in audio_clips. The client
--       resolves it by deterministic path, not via the audio_clips table.
--
--   Words/examples are nested under their unit so a unit's assets can be listed,
--   cache-warmed, or purged as a group. A word that belongs to multiple units is
--   synthesized ONCE and uploaded under each owning unit's folder by the
--   pipeline (idempotent skip-by-path keeps cost at one synthesis per unique
--   text — see generate-audio.mjs).
--
-- user-recordings  (PRIVATE; pronunciation_attempts.recording_path = these)
--   {uid}/pronunciation/{unitId}/{wordId}/{attemptNo}-{timestamp}.webm
--       per-user pronunciation attempt audio. The FIRST segment MUST be the
--       caller's auth uid — the RLS policies below enforce exactly that.
--
-- NOTE on file extensions: unit-audio is `.mp3` (TTS output, audio/mpeg).
-- user-recordings is whatever the browser MediaRecorder produces (commonly
-- `.webm`/audio/webm on Chromium, `.m4a`/audio/mp4 on Safari/iOS); the policies
-- below are extension-agnostic.
-- ============================================================================


-- ============================================================================
-- BUCKET 1 — unit-audio (PUBLIC read, service-role write)
-- ============================================================================
-- `public = true` makes objects readable via the public CDN URL without auth.
-- We still add an explicit SELECT policy so authenticated/anon reads through the
-- RLS path also succeed. Inserts/updates/deletes get NO anon/authenticated
-- policy, so only the service role (which BYPASSES RLS) can write — exactly the
-- generate-audio.mjs pipeline using the service-role key.
insert into storage.buckets (id, name, public)
values ('unit-audio', 'unit-audio', true)
on conflict (id) do update set public = excluded.public;

-- Public read: anyone may SELECT (download) objects in unit-audio. Combined with
-- `public = true`, the assets are also served over the CDN URL.
drop policy if exists "unit-audio public read" on storage.objects;
create policy "unit-audio public read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'unit-audio');

-- (Deliberately NO insert/update/delete policy for anon or authenticated on
-- unit-audio. The service-role key bypasses RLS, so ONLY the pipeline can write.
-- Documenting the intent for any future reviewer.)


-- ============================================================================
-- BUCKET 2 — user-recordings (PRIVATE, per-user folder)
-- ============================================================================
-- Private bucket: objects are NOT publicly downloadable. Access is granted ONLY
-- to the authenticated owner of the top-level folder, where the folder name is
-- the user's auth uid. storage.foldername(name) splits the object key on '/';
-- element [1] is the FIRST segment (Postgres arrays are 1-based) and must equal
-- auth.uid()::text.
insert into storage.buckets (id, name, public)
values ('user-recordings', 'user-recordings', false)
on conflict (id) do update set public = excluded.public;

-- Read own recordings.
drop policy if exists "user-recordings owner read" on storage.objects;
create policy "user-recordings owner read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'user-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Upload into own folder. The WITH CHECK clause forces every new object's first
-- path segment to be the caller's uid, so a user cannot write into someone
-- else's folder.
drop policy if exists "user-recordings owner insert" on storage.objects;
create policy "user-recordings owner insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'user-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Update own recordings (e.g. overwrite/upsert). Both USING (which rows are
-- visible to update) and WITH CHECK (what the row may become) are scoped to the
-- owner's folder.
drop policy if exists "user-recordings owner update" on storage.objects;
create policy "user-recordings owner update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'user-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'user-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Delete own recordings.
drop policy if exists "user-recordings owner delete" on storage.objects;
create policy "user-recordings owner delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'user-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  );


-- ============================================================================
-- 30-DAY RETENTION for user-recordings  (DECISIONS.md: recordings 30-day TTL)
-- ----------------------------------------------------------------------------
-- pronunciation_attempts.score/passed/assessment are server-trusted and persist
-- as the durable record of a user's pronunciation; the raw AUDIO in
-- user-recordings is transient and must be purged after 30 days. Supabase does
-- not ship a built-in object-TTL, so retention is enforced by a scheduled job
-- that deletes objects older than 30 days. Two supported options — pick ONE at
-- deploy time:
--
--   (A) pg_cron + a SECURITY DEFINER cleanup function (in-database, preferred):
--       Requires the `pg_cron` extension (Supabase: enable in the dashboard or
--       `create extension pg_cron;`). Define a cleanup function owned by a role
--       that may delete from storage.objects, then schedule it daily, e.g.:
--
--         -- runs daily at 03:30 UTC; removes recordings older than 30 days
--         select cron.schedule(
--           'purge-user-recordings',
--           '30 3 * * *',
--           $cron$
--             delete from storage.objects
--             where bucket_id = 'user-recordings'
--               and created_at < now() - interval '30 days';
--           $cron$
--         );
--
--       NOTE: deleting the storage.objects ROW removes the database record; on
--       Supabase the storage API/worker reconciles the underlying S3 object.
--       For guaranteed byte deletion, prefer option (B) which calls the Storage
--       API directly.
--
--   (B) Scheduled Edge Function (service role) calling the Storage API:
--       A daily-triggered function lists user-recordings, filters by
--       `created_at < now()-30d`, and calls storage.remove([...paths]) with the
--       service-role key (which bypasses these RLS policies). This guarantees the
--       physical object is removed, not just the metadata row.
--
-- Whichever option ships, it is OWNED BY THE STORAGE/OPS AGENT and lives outside
-- this migration (scheduling primitives are environment-specific). This comment
-- is the authoritative spec for that job: bucket='user-recordings', age>30 days,
-- daily cadence, no grace period (matches the streak/no-grace philosophy).
-- ============================================================================
