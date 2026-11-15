import mongoose from "mongoose";
import User from "../models/user.js";
import Role from "../models/role.js";
import Institution from "../models/institution.js";
import InstitutionMembership from "../models/institutionMembership.js";
import { buildActivationUrl, createActivationToken } from "../utils/activationToken.js";
import { sendActivationEmail } from "./emailService.js";
import { audit } from "../utils/audit.js";
import AppError from "../utils/AppError.js";

// A role holding any of these is an admin role: only the Super Admin may grant, change or remove it.
const ADMIN_PERMISSIONS = ["*", "staff:invite", "staff:manage"];
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

export const isAdminRole = (role) => (role?.permissions || []).some((key) => ADMIN_PERMISSIONS.includes(key));

const assertId = (id, label) => {
  if (!OBJECT_ID.test(String(id || ""))) throw new AppError(`Invalid ${label}`, 400);
};

const ROLE_FIELDS = "name displayName description permissions";

// Roles this actor may hand out in a college: a head gets only roles beneath Institution Admin.
export const assignableRoles = async ({ asSuperAdmin }) => {
  const roles = await Role.find({ scope: "INSTITUTION", isActive: true }).select(ROLE_FIELDS).sort({ name: 1 });
  return asSuperAdmin ? roles : roles.filter((role) => !isAdminRole(role));
};

const findAssignableRole = async (roleId, { asSuperAdmin }) => {
  assertId(roleId, "roleId");
  const role = await Role.findOne({ _id: roleId, scope: "INSTITUTION", isActive: true });
  if (!role) throw new AppError("Choose an active institution role", 400);
  if (!asSuperAdmin && isAdminRole(role)) {
    throw new AppError("Only the Super Admin can assign an admin role", 403);
  }
  return role;
};

export const listMembers = async (institution, { asSuperAdmin }) => {
  // shortcut: no pagination, a college's staff list is small; paginate if colleges reach hundreds of staff.
  const [members, roles] = await Promise.all([
    InstitutionMembership.find({ institutionId: institution._id })
      .populate("userId", "name email userType isActive emailVerified")
      .populate("roleId", ROLE_FIELDS)
      .populate("invitedBy", "name")
      .sort({ createdAt: 1 }),
    assignableRoles({ asSuperAdmin }),
  ]);

  return { members, roles, primaryAdminMembershipId: institution.primaryAdminMembershipId || null };
};

/**
 * Invite a person into one college. A new email gets an account plus a one-time activation link;
 * an existing account is invited only if its email is verified, and its owner must accept in-app.
 */
export const inviteMember = async (req, institution, body, { asSuperAdmin }) => {
  const email = String(body?.email || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();

  if (!EMAIL_PATTERN.test(email) || email.length > 200) throw new AppError("Provide a valid email address", 400);
  if (name.length > 120) throw new AppError("name must be 120 characters or fewer", 400);

  const role = await findAssignableRole(body?.roleId, { asSuperAdmin });
  let user = await User.findOne({ email });

  if (user) {
    // Never attach a college to an account just because someone typed its email (design §6.2).
    if (!user.emailVerified) {
      throw new AppError("This email belongs to an account that has not verified it yet; they must activate it first", 409);
    }
    if (!user.isActive) throw new AppError("This account is disabled", 409);

    const existing = await InstitutionMembership.findOne({ userId: user._id, institutionId: institution._id });
    if (existing) throw new AppError(`This person is already in this institution (${existing.status})`, 409);
  } else if (!name) {
    throw new AppError("name is required for someone without an account", 400);
  }

  const activation = user ? null : createActivationToken();
  let membership;
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      if (!user) {
        const studentRole = await Role.findOne({ name: "student", isActive: true }).session(session);
        if (!studentRole) throw new AppError("Default roles are not configured", 500);

        [user] = await User.create(
          [
            {
              name,
              email,
              roleId: studentRole._id,
              userType: isAdminRole(role) ? "ADMIN" : "STAFF",
              activationTokenHash: activation.hash,
              activationExpiresAt: activation.expiresAt,
            },
          ],
          { session }
        );
      }

      [membership] = await InstitutionMembership.create(
        [
          {
            userId: user._id,
            institutionId: institution._id,
            roleId: role._id,
            status: "INVITED",
            invitedBy: req.user._id,
            invitedAt: new Date(),
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  let delivery = "in_app";
  let activationUrl;

  if (activation) {
    // shortcut: sent right after commit, not through an outbox worker; add the outbox before production (P09).
    activationUrl = buildActivationUrl(activation.token);
    try {
      const result = await sendActivationEmail({ to: email, name, activationUrl });
      delivery = result.delivered ? "sent" : result.provider;
    } catch (error) {
      delivery = "failed";
      console.error("Activation email delivery failed:", error.message);
    }
  }

  await audit(req, {
    action: asSuperAdmin ? "admin.member.invite" : "institution.staff.invite",
    scope: asSuperAdmin ? "PLATFORM" : "INSTITUTION",
    institutionId: institution._id,
    targetType: "InstitutionMembership",
    targetId: membership._id,
    summary: `Invited ${email} as ${role.displayName} at ${institution.code}`,
    details: { role: role.name, newAccount: Boolean(activation), emailDelivery: delivery },
  });

  return {
    membership,
    existingAccount: !activation,
    emailDelivery: delivery,
    ...(activationUrl && process.env.NODE_ENV !== "production" && { activationUrl }),
  };
};

/**
 * Change a member's role and/or status inside one college. The primary head can never be demoted
 * or suspended (transfer the head first); a head cannot touch admins or themselves.
 */
export const updateMember = async (req, institution, membershipId, body, { asSuperAdmin }) => {
  assertId(membershipId, "membershipId");
  const { roleId, status } = body || {};

  if (roleId === undefined && status === undefined) throw new AppError("Provide roleId or status", 400);

  // Scoped to the selected college: another college's membership id is simply not found.
  const membership = await InstitutionMembership.findOne({ _id: membershipId, institutionId: institution._id }).populate("roleId");
  if (!membership) throw new AppError("Member not found in this institution", 404);

  if (!asSuperAdmin) {
    if (membership.userId.equals(req.user._id)) throw new AppError("You cannot change your own membership", 403);
    if (isAdminRole(membership.roleId)) throw new AppError("Only the Super Admin can change an Institution Admin", 403);
  }

  const isHead = institution.primaryAdminMembershipId?.equals(membership._id);
  const before = { role: membership.roleId?.name, status: membership.status };

  if (roleId !== undefined) {
    const role = await findAssignableRole(roleId, { asSuperAdmin });
    if (isHead && !isAdminRole(role)) throw new AppError("Transfer the head to someone else before changing this role", 409);
    membership.roleId = role._id;
  }

  if (status !== undefined) {
    if (!["ACTIVE", "SUSPENDED"].includes(status)) throw new AppError("status must be ACTIVE or SUSPENDED", 400);
    if (isHead && status === "SUSPENDED") throw new AppError("Transfer the head to someone else before suspending them", 409);
    // Reactivating must not skip acceptance: someone who never accepted stays out.
    if (status === "ACTIVE" && membership.status !== "ACTIVE" && !membership.acceptedAt) {
      throw new AppError("This person has not accepted the invitation yet", 409);
    }
    membership.status = status;
  }

  await membership.save();
  await membership.populate("roleId", ROLE_FIELDS);

  await audit(req, {
    action: asSuperAdmin ? "admin.member.update" : "institution.staff.update",
    scope: asSuperAdmin ? "PLATFORM" : "INSTITUTION",
    institutionId: institution._id,
    targetType: "InstitutionMembership",
    targetId: membership._id,
    summary: `Changed member at ${institution.code}: ${before.role}/${before.status} → ${membership.roleId.name}/${membership.status}`,
    details: { before, after: { role: membership.roleId.name, status: membership.status } },
  });

  return membership;
};

// Super Admin only: move the primary-head pointer to another ACTIVE admin membership of the same college.
export const transferHead = async (req, institution, body) => {
  assertId(body?.membershipId, "membershipId");
  const reason = String(body?.reason || "").trim();
  if (!reason || reason.length > 1000) throw new AppError("A reason (up to 1000 characters) is required", 400);

  const target = await InstitutionMembership.findOne({
    _id: body.membershipId,
    institutionId: institution._id,
    status: "ACTIVE",
  }).populate("roleId");

  if (!target) throw new AppError("The new head must be an ACTIVE member of this institution", 400);
  if (!target.roleId?.isActive || !isAdminRole(target.roleId)) {
    throw new AppError("The new head must hold an Institution Admin role; promote them first", 400);
  }

  const previous = institution.primaryAdminMembershipId || null;
  if (previous?.equals(target._id)) throw new AppError("This member is already the head", 409);

  // Conditional on the old pointer, so two concurrent transfers cannot both succeed.
  const updated = await Institution.findOneAndUpdate(
    { _id: institution._id, primaryAdminMembershipId: previous },
    { primaryAdminMembershipId: target._id },
    { new: true }
  );
  if (!updated) throw new AppError("The head was just changed by someone else; reload and try again", 409);

  // shortcut: the audit entry is written after the pointer change, not in the same transaction.
  await audit(req, {
    action: "admin.institution.head.transfer",
    institutionId: institution._id,
    targetType: "InstitutionMembership",
    targetId: target._id,
    summary: `Transferred head of ${institution.code}`,
    details: { from: previous, to: target._id, reason },
  });

  return updated;
};

// The invited person accepts or declines in-app (existing accounts; new accounts accept via activation).
export const respondToInvitation = async (req, membershipId, accept) => {
  assertId(membershipId, "membershipId");
  const filter = { _id: membershipId, userId: req.user._id, status: "INVITED" };
  const membership = accept
    ? await InstitutionMembership.findOneAndUpdate(filter, { status: "ACTIVE", acceptedAt: new Date() }, { new: true })
    : await InstitutionMembership.findOneAndDelete(filter);

  if (!membership) throw new AppError("Invitation not found", 404);

  await audit(req, {
    action: accept ? "account.invitation.accept" : "account.invitation.decline",
    scope: "ACCOUNT",
    institutionId: membership.institutionId,
    targetType: "InstitutionMembership",
    targetId: membership._id,
    summary: accept ? "Accepted a college invitation" : "Declined a college invitation",
  });

  return membership;
};

export const listInvitations = (user) =>
  InstitutionMembership.find({ userId: user._id, status: "INVITED" })
    .populate("institutionId", "name code status")
    .populate("roleId", "displayName")
    .populate("invitedBy", "name")
    .sort({ createdAt: -1 });
