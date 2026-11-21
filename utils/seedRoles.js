import Role from "../models/role.js";

const seedRoles = async () => {
  const operations = Role.DEFAULT_ROLES.map(({ permissions, ...role }) => ({
    updateOne: {
      filter: { name: role.name },
      // Existing roles keep their fields, but pick up permissions added in later releases.
      update: { $setOnInsert: role, $addToSet: { permissions: { $each: permissions } } },
      upsert: true,
    },
  }));

  return Role.bulkWrite(operations);
};

export default seedRoles;
