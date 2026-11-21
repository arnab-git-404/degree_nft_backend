import AuditLog, { AUDIT_METHODS, AUDIT_SCOPES } from "../models/auditLog.js";
import AppError from "../utils/AppError.js";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OBJECT_ID = /^[a-f0-9]{24}$/i;

const assertId = (value, label) => {
  if (!OBJECT_ID.test(String(value))) throw new AppError(`Invalid ${label}`, 400);
};

/**
 * One page of the activity log plus its stats. `base` is the fixed scope: {} for the Super Admin,
 * { institutionId } for a college's own log (then a query institutionId cannot widen it).
 * hideNetwork drops IP and browser, which a college has no need to see (they include the Super Admin's).
 */
export const listAuditLogs = async (req, { base = {}, hideNetwork = false } = {}) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const { type, method, search, institutionId, actorId } = req.query;
  const filter = { ...base };

  if (type === "FAILURE") {
    filter.outcome = "FAILURE";
  } else if (AUDIT_SCOPES.includes(type)) {
    filter.scope = type;
  }

  if (AUDIT_METHODS.includes(method)) filter.method = method;

  if (institutionId && !base.institutionId) {
    assertId(institutionId, "institutionId");
    filter.institutionId = institutionId;
  }

  if (actorId) {
    assertId(actorId, "actorId");
    filter.actorId = actorId;
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ action: regex }, { summary: regex }, { actorName: regex }, { targetId: regex }];
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [logs, total, allLogs, failures, last24h, ...methodCounts] = await Promise.all([
    AuditLog.find(filter)
      .select(hideNetwork ? "-ip -userAgent" : "")
      .populate("institutionId", "name code")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments(base),
    AuditLog.countDocuments({ ...base, outcome: "FAILURE" }),
    AuditLog.countDocuments({ ...base, createdAt: { $gte: dayAgo } }),
    ...AUDIT_METHODS.map((name) => AuditLog.countDocuments({ ...base, method: name })),
  ]);

  return {
    logs,
    stats: {
      total: allLogs,
      failures,
      last24h,
      methods: Object.fromEntries(AUDIT_METHODS.map((name, i) => [name, methodCounts[i]])),
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
};
