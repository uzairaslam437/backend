const binAssignmentModel = require('../models/binAssignment');
const driverLocationModel = require('../models/driverLocation');
const binModel = require('../models/bin');
const { pool } = require('../config/db');
const websocketService = require('./websocketService');

class BinAssignmentService {
    /**
     * Find the best driver for a bin based on proximity and workload
     * @param {Object} bin - The bin object with latitude, longitude, society
     * @returns {Object|null} - Best driver or null if none available
     */
    async findBestDriver(bin) {
        try {
            // Get all drivers in the same society
            const driversQuery = await pool.query(
                `SELECT id, first_name, last_name, society_id
         FROM users
         WHERE role = 'driver' 
           AND is_verified = TRUE 
           AND is_blocked = FALSE
           AND society_id = (SELECT id FROM societies WHERE society_name = $1 LIMIT 1)`,
                [bin.society]
            );

            if (driversQuery.rows.length === 0) {
                console.log(`No available drivers found for society: ${bin.society}`);
                return null;
            }

            const drivers = driversQuery.rows;
            const driverScores = [];

            for (const driver of drivers) {
                // Get driver's current location
                const location = await driverLocationModel.getDriverLocation(driver.id);

                // Get driver's current workload
                const workload = await binAssignmentModel.getDriverWorkload(driver.id);

                let distance = null;
                let proximityScore = 0;

                if (location && bin.latitude && bin.longitude) {
                    // Calculate distance using the database function
                    const distanceQuery = await pool.query(
                        `SELECT calculate_distance($1, $2, $3, $4) as distance`,
                        [location.latitude, location.longitude, bin.latitude, bin.longitude]
                    );
                    distance = parseFloat(distanceQuery.rows[0].distance);

                    // Proximity score: closer is better (inverse relationship)
                    // Max distance considered: 50km, beyond that score is 0
                    proximityScore = distance <= 50 ? (50 - distance) / 50 * 100 : 0;
                } else {
                    // If no location data, give a neutral proximity score
                    proximityScore = 50;
                }

                // Workload score: fewer tasks is better
                // Assuming max reasonable workload is 10 tasks
                const workloadScore = workload <= 10 ? (10 - workload) / 10 * 100 : 0;

                // Combined score: 60% proximity, 40% workload
                const totalScore = (proximityScore * 0.6) + (workloadScore * 0.4);

                driverScores.push({
                    driver,
                    distance,
                    workload,
                    proximityScore,
                    workloadScore,
                    totalScore
                });
            }

            // Sort by total score (highest first)
            driverScores.sort((a, b) => b.totalScore - a.totalScore);

            if (driverScores.length > 0 && driverScores[0].totalScore > 0) {
                const best = driverScores[0];
                console.log(`Best driver for bin ${bin.id}:`, {
                    driverId: best.driver.id,
                    driverName: `${best.driver.first_name} ${best.driver.last_name}`,
                    distance: best.distance ? `${best.distance.toFixed(2)} km` : 'unknown',
                    workload: best.workload,
                    score: best.totalScore.toFixed(2)
                });

                return {
                    ...best.driver,
                    distance: best.distance,
                    workload: best.workload,
                    score: best.totalScore
                };
            }

            return null;
        } catch (error) {
            console.error('Error finding best driver:', error);
            throw error;
        }
    }

    /**
     * Automatically assign bins that need collection
     * @param {number|null} binId - Specific bin ID to assign, or null to check all bins
     */
    async autoAssignBins(binId = null) {
        try {
            let binsToAssign = [];

            if (binId) {
                // Assign specific bin
                const bin = await binModel.getBinById(binId);
                if (bin && bin.fill_level >= 80) {
                    binsToAssign = [bin];
                }
            } else {
                // Find all bins needing assignment
                binsToAssign = await binAssignmentModel.getUnassignedBins(null, 80);
            }

            console.log(`Found ${binsToAssign.length} bins needing assignment`);

            const assignments = [];

            for (const bin of binsToAssign) {
                try {
                    // Find best driver
                    const bestDriver = await this.findBestDriver(bin);

                    if (!bestDriver) {
                        console.log(`No suitable driver found for bin ${bin.id}`);
                        continue;
                    }

                    // Determine priority based on fill level
                    let priority = 'medium';
                    if (bin.fill_level >= 95) {
                        priority = 'urgent';
                    } else if (bin.fill_level >= 90) {
                        priority = 'high';
                    }

                    // Estimate collection time (in minutes)
                    const estimatedTime = bestDriver.distance
                        ? Math.ceil((bestDriver.distance / 30) * 60) + 15 // Assume 30 km/h + 15 min collection
                        : 30; // Default 30 minutes if no distance

                    // Create assignment
                    const assignment = await binAssignmentModel.createAssignment(
                        bin.id,
                        bestDriver.id,
                        priority,
                        bestDriver.distance,
                        estimatedTime
                    );

                    assignments.push(assignment);

                    // Send WebSocket notification to driver
                    websocketService.sendToUser(bestDriver.id, 'bin:assigned', {
                        assignment_id: assignment.id,
                        bin_id: bin.id,
                        bin_name: bin.name,
                        bin_address: bin.address,
                        fill_level: bin.fill_level,
                        priority,
                        distance_km: bestDriver.distance,
                        estimated_time_minutes: estimatedTime
                    });

                    console.log(`Assigned bin ${bin.id} to driver ${bestDriver.id}`);
                } catch (error) {
                    console.error(`Error assigning bin ${bin.id}:`, error);
                }
            }

            return assignments;
        } catch (error) {
            console.error('Error in autoAssignBins:', error);
            throw error;
        }
    }

    /**
     * Complete a bin assignment
     * @param {number} assignmentId - Assignment ID
     * @param {Object} data - Completion data (notes, weight)
     */
    async completeAssignment(assignmentId, data = {}) {
        try {
            // Update assignment status
            const assignment = await binAssignmentModel.updateAssignmentStatus(
                assignmentId,
                'completed',
                data
            );

            if (!assignment) {
                throw new Error('Assignment not found');
            }

            // Reset bin fill level to 0
            await binModel.updateBin(assignment.bin_id, {
                fill_level: 0,
                status: 'idle'
            });

            // Send WebSocket notification
            websocketService.sendToAll('bin:collected', {
                bin_id: assignment.bin_id,
                assignment_id: assignmentId,
                driver_id: assignment.driver_id
            });

            console.log(`Completed assignment ${assignmentId}, reset bin ${assignment.bin_id} fill level`);

            return assignment;
        } catch (error) {
            console.error('Error completing assignment:', error);
            throw error;
        }
    }
}

module.exports = new BinAssignmentService();
