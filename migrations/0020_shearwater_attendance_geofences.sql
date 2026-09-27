-- Plant Shearwater IT allowed clock-in sites (3 pins only).
-- 1) Shearwater office pin from Maps
-- 2) Econet / Sopers Arcade (adjacent)
-- 3) Shearwater Explorers Village

UPDATE organizations.offices
SET
  settings = COALESCE(settings, '{}'::jsonb)
    || jsonb_build_object(
      'attendance_mode',
      COALESCE(settings->>'attendance_mode', 'presence_only')
    )
    || jsonb_build_object(
      'geofence',
      jsonb_build_object(
        'enabled', true,
        'label', 'Shearwater / Sopers Arcade',
        'latitude', -17.9274197,
        'longitude', 25.8377384,
        'radius_meters', 120,
        'max_accuracy_meters', 150
      )
    )
    || jsonb_build_object(
      'geofences',
      jsonb_build_array(
        jsonb_build_object(
          'enabled', true,
          'label', 'Shearwater / Sopers Arcade',
          'latitude', -17.9274197,
          'longitude', 25.8377384,
          'radius_meters', 120,
          'max_accuracy_meters', 150
        ),
        jsonb_build_object(
          'enabled', true,
          'label', 'Econet Sopers Arcade',
          'latitude', -17.9277918,
          'longitude', 25.8379225,
          'radius_meters', 100,
          'max_accuracy_meters', 150
        ),
        jsonb_build_object(
          'enabled', true,
          'label', 'Shearwater Explorers Village',
          'latitude', -17.9239069,
          'longitude', 25.8410469,
          'radius_meters', 150,
          'max_accuracy_meters', 150
        )
      )
    ),
  updated_at = NOW()
WHERE slug IN ('swtech', 'shearwater-office', 'shearwater', 'shearwater-tech')
   OR lower(name) LIKE '%shearwater%';
