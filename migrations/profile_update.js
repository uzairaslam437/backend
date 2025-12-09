// profile_update.js

exports.up = async function (knex) {
  return knex.schema.table("users", function (table) {
    table.string("profile_picture"); // add profile_picture column
  });
};

exports.down = async function (knex) {
  return knex.schema.table("users", function (table) {
    table.dropColumn("profile_picture");
  });
};
