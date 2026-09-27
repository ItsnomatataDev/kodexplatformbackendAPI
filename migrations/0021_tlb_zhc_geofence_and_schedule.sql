-- TLB (Three Little Birds) may only clock in at ZHC Helipad, Chinotimba.
-- Pin: Chinotimba Industrial Area (Zambezi Helicopter Company current helipad).
-- Refine later if a more precise Maps pin is provided.

UPDATE organizations.offices
SET
  settings = COALESCE(settings, '{}'::jsonb)
    || jsonb_build_object(
      'attendance_mode',
      COALESCE(settings->>'attendance_mode', 'time_tracked')
    )
    || jsonb_build_object(
      'geofence',
      jsonb_build_object(
        'enabled', true,
        'label', 'ZHC Helipad (Chinotimba)',
        'latitude', -17.9382,
        'longitude', 25.8325,
        'radius_meters', 200,
        'max_accuracy_meters', 150
      )
    )
    || jsonb_build_object(
      'geofences',
      jsonb_build_array(
        jsonb_build_object(
          'enabled', true,
          'label', 'ZHC Helipad (Chinotimba)',
          'latitude', -17.9382,
          'longitude', 25.8325,
          'radius_meters', 200,
          'max_accuracy_meters', 150
        )
      )
    ),
  updated_at = NOW()
WHERE slug IN ('three-little-birds', 'tlb')
   OR lower(name) LIKE '%three little bird%';

-- Org-wide attendance schedule defaults (Harare). Jobs read these.
UPDATE organizations.organizations
SET
  settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
    'attendance',
    COALESCE(settings->'attendance', '{}'::jsonb) || jsonb_build_object(
      'timezone', 'Africa/Harare',
      'workday_start', '08:00',
      'clock_in_reminder', '08:15',
      'late_after', '08:30',
      'auto_clock_out', '18:00',
      'weekdays_only', true
    )
  ),
  updated_at = NOW();
