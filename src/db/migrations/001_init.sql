-- Job Hunt — initial schema
-- Tables: users, searches, job_listings, search_listings, applications, cover_letters, application_events

CREATE TABLE IF NOT EXISTS users (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT         UNIQUE NOT NULL,
  display_name TEXT,
  resume_text TEXT,
  skills      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  api_token_hash TEXT      UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS searches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query        TEXT        NOT NULL,
  location     TEXT        NOT NULL,
  job_type     TEXT,
  country_code TEXT        NOT NULL,
  raw_response TEXT,
  result_count INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_searches_user_id      ON searches(user_id);
CREATE INDEX idx_searches_created_at   ON searches(created_at DESC);

CREATE TABLE IF NOT EXISTS job_listings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  indeed_job_id   TEXT        UNIQUE NOT NULL,
  title           TEXT        NOT NULL,
  company         TEXT        NOT NULL,
  location        TEXT,
  apply_url       TEXT        NOT NULL,
  description_md  TEXT,
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_currency TEXT,
  job_type        TEXT,
  remote          BOOLEAN,
  posted_at       TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_listings_company ON job_listings(company);
CREATE INDEX idx_job_listings_first_seen_at ON job_listings(first_seen_at DESC);

CREATE TABLE IF NOT EXISTS search_listings (
  search_id   UUID        NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  listing_id  UUID        NOT NULL REFERENCES job_listings(id) ON DELETE CASCADE,
  rank        INTEGER     NOT NULL,
  PRIMARY KEY (search_id, listing_id)
);

CREATE INDEX idx_search_listings_listing_id ON search_listings(listing_id);

CREATE TABLE IF NOT EXISTS applications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id    UUID        NOT NULL REFERENCES job_listings(id),
  status        TEXT        NOT NULL DEFAULT 'drafting'
                  CHECK (status IN
                    ('drafting','pending_review','submitted','responded','rejected','offer','withdrawn')),
  fit_score     INTEGER     CHECK (fit_score IS NULL OR (fit_score >= 0 AND fit_score <= 100)),
  fit_reasoning TEXT,
  notes         TEXT,
  applied_at    TIMESTAMPTZ,
  responded_at  TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, listing_id)
);

CREATE INDEX idx_applications_user_status ON applications(user_id, status);
CREATE INDEX idx_applications_status      ON applications(status);
CREATE INDEX idx_applications_created_at  ON applications(created_at DESC);

CREATE TABLE IF NOT EXISTS cover_letters (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  body_md         TEXT        NOT NULL,
  word_count      INTEGER     NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, version)
);

CREATE INDEX idx_cover_letters_application_id ON cover_letters(application_id);

CREATE TABLE IF NOT EXISTS application_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL
                    CHECK (kind IN
                      ('status_change','pause_gate','submitted','response_received','rejection','offer','note')),
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_application_events_application_id ON application_events(application_id, created_at DESC);
CREATE INDEX idx_application_events_kind ON application_events(kind);

-- Auto-update updated_at on rows that have it
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER applications_set_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
