UPDATE organizations.offices
SET
  settings = jsonb_set(
    jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      '{geofence,radius_meters}',
      to_jsonb(
        GREATEST(
          COALESCE((settings->'geofence'->>'radius_meters')::int, 0),
          250
        )
      ),
      true
    ),
    '{geofence,max_accuracy_meters}',
    '300'::jsonb,
    true
  ),
  updated_at = NOW()
WHERE slug IN ('swtech', 'shearwater-office', 'shearwater', 'shearwater-tech')
   OR lower(name) LIKE '%shearwater%';

UPDATE organizations.offices o
SET
  settings = jsonb_set(
    COALESCE(o.settings, '{}'::jsonb),
    '{geofences}',
    (
      SELECT COALESCE(jsonb_agg(
        CASE
          WHEN COALESCE(elem->>'enabled', 'true') = 'false' THEN elem
          ELSE elem
            || jsonb_build_object(
              'radius_meters',
              GREATEST(COALESCE((elem->>'radius_meters')::int, 0), 250),
              'max_accuracy_meters',
              GREATEST(COALESCE((elem->>'max_accuracy_meters')::int, 0), 300)
            )
        END
      ), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(o.settings->'geofences', '[]'::jsonb)) AS elem
    ),
    true
  ),
  updated_at = NOW()
WHERE slug IN ('swtech', 'shearwater-office', 'shearwater', 'shearwater-tech')
   OR lower(name) LIKE '%shearwater%';
