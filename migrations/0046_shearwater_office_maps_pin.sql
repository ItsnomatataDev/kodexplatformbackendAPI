UPDATE organizations.offices
SET
  settings = COALESCE(settings, '{}'::jsonb)
    || jsonb_build_object(
      'geofence',
      jsonb_build_object(
        'enabled', true,
        'label', 'Shearwater Office',
        'latitude', -17.927709,
        'longitude', 25.837663,
        'radius_meters', 120,
        'max_accuracy_meters', 150
      )
    )
    || jsonb_build_object(
      'geofences',
      (
        SELECT COALESCE(jsonb_agg(fence), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'enabled', true,
            'label', 'Shearwater Office',
            'latitude', -17.927709,
            'longitude', 25.837663,
            'radius_meters', 120,
            'max_accuracy_meters', 150
          ) AS fence
          UNION ALL
          SELECT elem AS fence
          FROM jsonb_array_elements(
            COALESCE(settings->'geofences', '[]'::jsonb)
          ) AS elem
          WHERE COALESCE(elem->>'label', '') NOT IN (
            'Shearwater Office',
            'Shearwater / Sopers Arcade'
          )
        ) rewritten
      )
    ),
  updated_at = NOW()
WHERE slug IN ('swtech', 'shearwater-office', 'shearwater', 'shearwater-tech')
   OR lower(name) LIKE '%shearwater%';
