// migrations/20251210000000_create_bin_assignments.js
module.exports.up = async function (knex) {
    await knex.raw(`
    -- Create bin_assignments table if it doesn't exist
    CREATE TABLE IF NOT EXISTS bin_assignments (
      id SERIAL PRIMARY KEY,
      bin_id INTEGER NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
      driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
      priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      notes TEXT,
      collection_weight DECIMAL(10,2),
      distance_km DECIMAL(10,2),
      estimated_time_minutes INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes for better query performance
    CREATE INDEX IF NOT EXISTS idx_bin_assignments_bin_id ON bin_assignments(bin_id);
    CREATE INDEX IF NOT EXISTS idx_bin_assignments_driver_id ON bin_assignments(driver_id);
    CREATE INDEX IF NOT EXISTS idx_bin_assignments_status ON bin_assignments(status);
    CREATE INDEX IF NOT EXISTS idx_bin_assignments_assigned_at ON bin_assignments(assigned_at);
    CREATE INDEX IF NOT EXISTS idx_bin_assignments_driver_status ON bin_assignments(driver_id, status);

    -- Create driver_locations table if it doesn't exist
    CREATE TABLE IF NOT EXISTS driver_locations (
      id SERIAL PRIMARY KEY,
      driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      latitude DECIMAL(10, 8) NOT NULL,
      longitude DECIMAL(11, 8) NOT NULL,
      accuracy DECIMAL(10, 2),
      heading DECIMAL(5, 2),
      speed DECIMAL(5, 2),
      is_active BOOLEAN DEFAULT TRUE,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes for driver_locations
    CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_id ON driver_locations(driver_id);
    CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_active ON driver_locations(driver_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded_at ON driver_locations(recorded_at);

    -- Create trigger to update bin_assignments updated_at
    CREATE OR REPLACE FUNCTION update_bin_assignments_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trigger_update_bin_assignments_updated_at
        BEFORE UPDATE ON bin_assignments
        FOR EACH ROW
        EXECUTE FUNCTION update_bin_assignments_updated_at();

    -- Function to calculate distance between two points (Haversine formula)
    CREATE OR REPLACE FUNCTION calculate_distance(
        lat1 DECIMAL, lon1 DECIMAL,
        lat2 DECIMAL, lon2 DECIMAL
    )
    RETURNS DECIMAL AS $$
    DECLARE
        R DECIMAL := 6371; -- Earth's radius in kilometers
        dLat DECIMAL;
        dLon DECIMAL;
        a DECIMAL;
        c DECIMAL;
    BEGIN
        dLat := RADIANS(lat2 - lat1);
        dLon := RADIANS(lon2 - lon1);
        
        a := SIN(dLat/2) * SIN(dLat/2) +
             COS(RADIANS(lat1)) * COS(RADIANS(lat2)) *
             SIN(dLon/2) * SIN(dLon/2);
        
        c := 2 * ATAN2(SQRT(a), SQRT(1-a));
        
        RETURN R * c;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);
};

module.exports.down = async function (knex) {
    await knex.raw(`
    -- Drop triggers
    DROP TRIGGER IF EXISTS trigger_update_bin_assignments_updated_at ON bin_assignments;
    
    -- Drop functions
    DROP FUNCTION IF EXISTS update_bin_assignments_updated_at();
    DROP FUNCTION IF EXISTS calculate_distance(DECIMAL, DECIMAL, DECIMAL, DECIMAL);
    
    -- Drop tables
    DROP TABLE IF EXISTS bin_assignments CASCADE;
    DROP TABLE IF EXISTS driver_locations CASCADE;
  `);
};
