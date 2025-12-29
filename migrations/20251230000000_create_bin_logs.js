// migrations/20251230000000_create_bin_logs.js
module.exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bin_logs (
      id SERIAL PRIMARY KEY,
      bin_id INTEGER REFERENCES bins(id) ON DELETE CASCADE,
      fill_level DECIMAL(5,2),
      temperature DOUBLE PRECISION,
      humidity DOUBLE PRECISION,
      smoke_level INTEGER,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bin_logs_bin_id_recorded_at ON bin_logs(bin_id, recorded_at DESC);
  `);
};

module.exports.down = async function (knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS bin_logs;
  `);
};
