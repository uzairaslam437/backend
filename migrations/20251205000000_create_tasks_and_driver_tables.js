// migrations/20251205000000_create_tasks_and_driver_tables.js
module.exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      bin_id INTEGER REFERENCES bins(id) ON DELETE SET NULL,
      society_id INTEGER REFERENCES societies(id) ON DELETE SET NULL,
      fill_level DECIMAL(5,2) DEFAULT 0.00,
      priority VARCHAR(50) DEFAULT 'normal',
      status VARCHAR(50) DEFAULT 'created',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS driver_tasks (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TIMESTAMP,
      completed_at TIMESTAMP,
      status VARCHAR(50) DEFAULT 'assigned',
      notes JSONB DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      event_type VARCHAR(100),
      payload JSONB DEFAULT '{}'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS driver_locations (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      latitude DECIMAL(10,6) DEFAULT 0.000000,
      longitude DECIMAL(10,6) DEFAULT 0.000000,
      heading DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_society_status ON tasks(society_id, status);
    CREATE INDEX IF NOT EXISTS idx_driver_tasks_driver_status ON driver_tasks(driver_id, status);
    CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_recorded_at ON driver_locations(driver_id, recorded_at DESC);
  `);
};

module.exports.down = async function (knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS driver_locations CASCADE;
    DROP TABLE IF EXISTS task_events CASCADE;
    DROP TABLE IF EXISTS driver_tasks CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
  `);
};
