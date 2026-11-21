import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
import Institution from "../models/institution.js";
import Credential from "../models/credential.js";
import Reports from "../models/reports.js";
import StudentDetails from "../models/studentDetails.js";
import AppError from "../utils/AppError.js";

const deriveUserName = (address) =>
  `User ${address.slice(0, 4)}...${address.slice(-4)}`;

export const backfillInstitutionReferences = async (institution, wallet) => {
  const address = wallet.address;

  await Promise.all([
    Credential.updateMany(
      {
        institutionWallet: address,
        $or: [
          { institutionId: { $exists: false } },
          { institutionId: null },
        ],
      },
      {
        $set: {
          institutionId: institution._id,
          institutionWalletId: wallet._id,
        },
      }
    ),
    Reports.updateMany(
      {
        institutionWallet: address,
        $or: [
          { institutionId: { $exists: false } },
          { institutionId: null },
        ],
      },
      {
        $set: {
          institutionId: institution._id,
          institutionWalletId: wallet._id,
        },
      }
    ),
    StudentDetails.updateMany(
      { institutionWalletAddress: address },
      {
        $set: {
          institutionId: institution._id,
          institutionWalletId: wallet._id,
        },
      }
    ),
  ]);
};

export const backfillWalletReferences = async (userId, wallet) => {
  const address = wallet.address;

  await Promise.all([
    Credential.updateMany(
      {
        studentWallet: address,
        $or: [{ userId: { $exists: false } }, { userId: null }],
      },
      {
        $set: {
          userId: userId,
          studentWalletId: wallet._id,
        },
      }
    ),
    Reports.updateMany(
      {
        studentWallet: address,
        $or: [{ userId: { $exists: false } }, { userId: null }],
      },
      {
        $set: {
          userId: userId,
          studentWalletId: wallet._id,
        },
      }
    ),
    StudentDetails.updateMany(
      { studentWalletAddress: address },
      {
        $set: {
          userId: userId,
          studentWalletId: wallet._id,
        },
      }
    ),
  ]);

  const institution = await Institution.findOne({ userId });

  if (institution) {
    await backfillInstitutionReferences(institution, wallet);
  }
};

export const findOrCreateUserByWallet = async (
  walletAddress,
  { name, verified = false, roleName, account } = {}
) => {
  let wallet = await Wallet.findOne({
    chain: "solana",
    address: walletAddress,
  });
  let user;
  let created = false;
  let assignedRole = null;

  if (roleName) {
    assignedRole = await Role.findOne({ name: roleName, isActive: true });

    if (!assignedRole) {
      throw new AppError(`Role '${roleName}' is not configured`, 500);
    }
  }

  if (wallet) {
    user = await User.findById(wallet.userId);

    if (!user) {
      throw new AppError("Wallet is not linked to a valid user", 401);
    }

    if (assignedRole) user.roleId = assignedRole._id;
    if (account) Object.assign(user, account);
    if (user.isModified()) await user.save();
  } else {
    const role =
      assignedRole ||
      (await Role.findOne({ name: "student", isActive: true }));

    if (!role) {
      throw new AppError("Role 'student' is not configured", 500);
    }

    user = await User.create({
      name: name ? String(name).trim() : deriveUserName(walletAddress),
      roleId: role._id,
      ...account,
    });

    wallet = await Wallet.create({
      userId: user._id,
      address: walletAddress,
      isPrimary: true,
      isVerified: verified,
      verifiedAt: verified ? new Date() : undefined,
    });
    created = true;
  }

  if (verified && !wallet.isVerified) {
    wallet.isVerified = true;
    wallet.verifiedAt = new Date();
    await wallet.save();
  }

  return { user, wallet, created };
};

export const getWalletAddresses = async (userId) => {
  const wallets = await Wallet.find({ userId }).select("address").lean();

  return wallets.map((wallet) => wallet.address);
};
