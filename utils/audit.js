import AuditLog from "../models/auditLog.js";

/**
 * Records one activity entry. Never throws: the action itself already happened, so a failed
 * log write is reported to the console instead of failing the request.
 * Never put secrets (passwords, tokens, signatures) in `details`.
 */
export const audit = async (
  req,
  {
    action,
    scope = "PLATFORM",
    outcome = "SUCCESS",
    actor = req.user,
    institutionId = req.institution?._id,
    targetType = "",
    targetId = "",
    summary = "",
    details,
  }
) => {
  try {
    await AuditLog.create({
      action,
      scope,
      outcome,
      actorId: actor?._id,
      actorName: actor?.name || "",
      institutionId,
      targetType,
      targetId: targetId ? String(targetId) : "",
      summary,
      details,
      ip: req.ip || "",
      userAgent: (req.get?.("user-agent") || "").slice(0, 300),
    });
  } catch (error) {
    console.error(`Audit log write failed for ${action}:`, error.message);
  }
};

// Wraps a handler so any error it throws is also logged as a FAILURE (e.g. a rejected sign-in).
export const auditFailures = (action, scope, describe = () => ({})) => (handler) =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      await audit(req, { action, scope, outcome: "FAILURE", summary: error.message, ...describe(req) });
      throw error;
    }
  };
