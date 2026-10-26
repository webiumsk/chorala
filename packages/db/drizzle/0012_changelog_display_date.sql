ALTER TABLE "changelog_entries" ADD COLUMN "display_date" date;--> statement-breakpoint
-- Recover only the known Satflux PR-history import identities. Their source day
-- survives owner edits to titles, bodies, labels and publication status because
-- the importer used cl_ + SHA256(JSON.stringify([projectId, sourceId]))[:40].
-- No title/body matching or replacement of publication/audit timestamps occurs.
WITH source_days(day) AS (
  VALUES
    ('2026-01-31'::date),
    ('2026-02-09'::date),
    ('2026-03-28'::date),
    ('2026-04-03'::date),
    ('2026-04-05'::date),
    ('2026-04-06'::date),
    ('2026-04-12'::date),
    ('2026-04-25'::date),
    ('2026-04-26'::date),
    ('2026-05-04'::date),
    ('2026-05-18'::date),
    ('2026-05-22'::date),
    ('2026-05-23'::date),
    ('2026-05-27'::date),
    ('2026-06-02'::date),
    ('2026-06-07'::date),
    ('2026-06-08'::date),
    ('2026-06-11'::date),
    ('2026-06-15'::date),
    ('2026-06-27'::date),
    ('2026-07-02'::date),
    ('2026-07-07'::date),
    ('2026-07-08'::date),
    ('2026-07-09'::date),
    ('2026-07-10'::date),
    ('2026-07-11'::date),
    ('2026-07-12'::date),
    ('2026-07-13'::date),
    ('2026-07-14'::date),
    ('2026-07-15'::date),
    ('2026-07-16'::date),
    ('2026-07-17'::date),
    ('2026-07-18'::date),
    ('2026-07-19'::date),
    ('2026-07-20'::date),
    ('2026-07-21'::date),
    ('2026-07-22'::date),
    ('2026-07-23'::date),
    ('2026-07-31'::date),
    ('2026-08-01'::date),
    ('2026-08-02'::date),
    ('2026-08-03'::date),
    ('2026-08-05'::date),
    ('2026-08-06'::date),
    ('2026-08-15'::date),
    ('2026-08-16'::date),
    ('2026-08-21'::date),
    ('2026-08-24'::date),
    ('2026-08-25'::date),
    ('2026-08-26'::date),
    ('2026-08-27'::date),
    ('2026-08-29'::date),
    ('2026-08-30'::date),
    ('2026-09-01'::date),
    ('2026-09-05'::date),
    ('2026-09-06'::date),
    ('2026-09-07'::date),
    ('2026-09-15'::date),
    ('2026-09-20'::date),
    ('2026-09-21'::date),
    ('2026-09-22'::date),
    ('2026-09-29'::date),
    ('2026-09-30'::date),
    ('2026-10-01'::date),
    ('2026-10-04'::date),
    ('2026-10-05'::date),
    ('2026-10-06'::date),
    ('2026-10-07'::date),
    ('2026-10-08'::date),
    ('2026-10-09'::date),
    ('2026-10-10'::date),
    ('2026-10-12'::date),
    ('2026-10-13'::date),
    ('2026-10-19'::date),
    ('2026-10-20'::date),
    ('2026-10-22'::date),
    ('2026-10-24'::date),
    ('2026-10-25'::date)
), import_identities AS (
  SELECT targets.project_id, source_days.day,
    'cl_' || substr(encode(sha256(convert_to(
      array_to_json(ARRAY[
        targets.project_id,
        'github:webiumsk/satflux:merged-pr-day:' || to_char(source_days.day, 'YYYY-MM-DD')
      ])::text, 'UTF8'
    )), 'hex'), 1, 40) AS entry_id
  FROM (
    SELECT DISTINCT project_id FROM changelog_entries
    WHERE id ~ '^cl_[0-9a-f]{40}$'
  ) AS targets
  CROSS JOIN source_days
)
UPDATE changelog_entries AS entry
SET display_date = source.day
FROM import_identities AS source
WHERE entry.project_id = source.project_id
  AND entry.id = source.entry_id
  AND entry.display_date IS NULL;
