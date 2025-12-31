/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
    return knex.schema.table('users', function (table) {
        table.decimal('latitude', 10, 8).nullable();
        table.decimal('longitude', 11, 8).nullable();
        table.timestamp('last_location_update').nullable();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
    return knex.schema.table('users', function (table) {
        table.dropColumn('latitude');
        table.dropColumn('longitude');
        table.dropColumn('last_location_update');
    });
};
