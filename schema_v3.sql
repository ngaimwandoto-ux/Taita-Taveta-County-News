-- Video podcasts: one show per topic. (stories.audio_url is no longer used.)
CREATE TABLE IF NOT EXISTS episodes (
  id SERIAL PRIMARY KEY,
  topic VARCHAR(20) NOT NULL CHECK (topic IN ('politics','sports','business','culture','tourism','agriculture','general')),
  title VARCHAR(150) NOT NULL, video_url VARCHAR(255) NOT NULL, thumb_url VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS episodes_topic_idx ON episodes (topic, created_at DESC);
