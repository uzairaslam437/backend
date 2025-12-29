exports.up = async function (knex) {
  const exists = await knex.schema.hasColumn("users", "profile_picture");
  if (!exists) {
    await knex.schema.table("users", function (table) {
      table.string("profile_picture");
    });
  }
};

exports.down = async function (knex) {
  const exists = await knex.schema.hasColumn("users", "profile_picture");
  if (exists) {
    await knex.schema.table("users", function (table) {
      table.dropColumn("profile_picture");
    });
  }
};
