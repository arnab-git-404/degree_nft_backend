import Role from "../models/role.js";

const seedRoles = async () => {
  const operations = Role.DEFAULT_ROLES.map((role) => ({
    updateOne: {
      filter: { name: role.name },
      update: { $setOnInsert: role },
      upsert: true,
    },
  }));

  return Role.bulkWrite(operations);
};

export default seedRoles;
