-- supabase/migrations/49_channel_any_file.sql   (applied to the live DB as "channel_any_file")
--
-- A class channel can carry any kind of file, not only images (PDFs, documents, slides, spreadsheets, audio, video,
-- archives, ...). Files are still download-only: the app never opens or previews them, and the signed link forces a
-- download, so a file cannot run in the page. Limit is now 25 MB (was 10 MB for images).
--   * send_class_message: the image-only mime list is replaced by a well-formed-mime check; size limit 25 MB
--   * storage bucket class-messages: no mime restriction, 25 MB limit

create or replace function pg_temp.patch_fn(p_schema text, p_name text, p_old text, p_new text) returns void
language plpgsql as $f$
declare v_oid oid; v_def text;
begin
  select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_name;
  v_def := pg_get_functiondef(v_oid);
  if position(p_old in v_def) = 0 then raise exception 'patch target not found in %.%: %', p_schema, p_name, p_old; end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.patch_fn('public', 'send_class_message',
  $o$p_media_mime is null or p_media_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')$o$,
  $n$p_media_mime is null or p_media_mime !~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$' or char_length(p_media_mime) > 127$n$);
select pg_temp.patch_fn('public', 'send_class_message', 'coalesce(p_media_size, 0) > 10485760', 'coalesce(p_media_size, 0) > 26214400');

update storage.buckets set allowed_mime_types = null, file_size_limit = 26214400 where id = 'class-messages';

drop function if exists pg_temp.patch_fn(text, text, text, text);
