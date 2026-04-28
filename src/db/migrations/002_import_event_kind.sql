-- Allow `imported` as a valid application_events.kind for the backfill flow.

ALTER TABLE application_events DROP CONSTRAINT application_events_kind_check;

ALTER TABLE application_events ADD CONSTRAINT application_events_kind_check
  CHECK (kind IN (
    'status_change',
    'pause_gate',
    'submitted',
    'response_received',
    'rejection',
    'offer',
    'note',
    'imported'
  ));
