export const PERMISSION_GROUPS = [
  {
    key: "platform",
    label: "Platform",
    description: "Run the DegreeNFT platform.",
    permissions: [
      {
        key: "platform:manage",
        label: "Admin panel",
        description:
          "Open the admin panel: manage users, roles, institutions, credentials, reports and registration links.",
      },
    ],
  },
  {
    key: "staff",
    label: "College staff",
    description: "Manage the people who work in a college (institution roles only).",
    permissions: [
      {
        key: "staff:read",
        label: "View staff",
        description: "See the college's members, their roles and invitations.",
      },
      {
        key: "staff:invite",
        label: "Invite staff",
        description: "Invite people into the college with a role below Institution Admin.",
      },
      {
        key: "staff:manage",
        label: "Manage staff",
        description: "Change staff roles, suspend and reactivate members (never admins).",
      },
      {
        key: "role:manage",
        label: "Manage college roles",
        description: "Create the college's own roles from college permissions (an admin power: only the Super Admin grants it).",
      },
    ],
  },
  {
    key: "catalog",
    label: "Academic catalog",
    description: "The courses (programs) a college offers and their batches (one per intake).",
    permissions: [
      {
        key: "program:read",
        label: "View programs",
        description: "See the college's programs (courses).",
      },
      {
        key: "program:create",
        label: "Create programs",
        description: "Add a program with a code unique in the college.",
      },
      {
        key: "program:update",
        label: "Update programs",
        description: "Rename, edit details, or deactivate a program (the code stays fixed).",
      },
      {
        key: "programSession:read",
        label: "View batches",
        description: "See the batches (e.g. CSE 2022-2026) of the college's programs.",
      },
      {
        key: "programSession:create",
        label: "Create batches",
        description: "Tick an intake on a program to create its batch; the same batch cannot be added twice.",
      },
      {
        key: "programSession:update",
        label: "Update batches",
        description: "Change a batch's end year or status, or remove a batch by unticking its intake.",
      },
      {
        key: "credentialType:read",
        label: "View credential types",
        description: "See the kinds of credential the college issues (Degree, Marksheet...), and pick one when issuing.",
      },
      {
        key: "credentialType:create",
        label: "Create credential types",
        description: "Add a credential type with a code unique in the college.",
      },
      {
        key: "credentialType:update",
        label: "Update credential types",
        description: "Rename, edit details, or deactivate a credential type (the code stays fixed).",
      },
    ],
  },
  {
    key: "administration",
    label: "College administration",
    description: "College-wide settings such as academic sessions.",
    permissions: [
      {
        key: "academicSession:read",
        label: "View academic sessions",
        description: "See the college's academic sessions (e.g. 2024-25).",
      },
      {
        key: "academicSession:manage",
        label: "Manage academic sessions",
        description: "Add academic sessions, or remove ones no program takes intake in.",
      },
      {
        key: "audit:read",
        label: "View college activity log",
        description: "See who did what in this college: staff, roles, programs, credentials and Super Admin changes.",
      },
    ],
  },
  {
    key: "credentials",
    label: "Credentials",
    description: "Issue, inspect, and confirm degree credentials.",
    permissions: [
      {
        key: "credential:read",
        label: "View credentials",
        description: "Read credential allocations and minted records.",
      },
      {
        key: "credential:create",
        label: "Create allocations",
        description: "Allocate new credentials to student wallets.",
      },
      {
        key: "credential:confirm",
        label: "Confirm credentials",
        description: "Confirm minted credentials and student claims.",
      },
    ],
  },
  {
    key: "students",
    label: "Batches & students",
    description: "Manage credential batches and student records.",
    permissions: [
      {
        key: "batch:upload",
        label: "Upload batches",
        description: "Import and process bulk credential batches.",
      },
      {
        key: "student:read",
        label: "View student records",
        description: "See the college's student profiles and uploaded allocation data.",
      },
      {
        key: "student:create",
        label: "Add students",
        description: "Add student profiles (one per student; courses are added as enrollments).",
      },
      {
        key: "student:update",
        label: "Update students",
        description: "Edit a student's name, registration no., contact details or status.",
      },
      {
        key: "enrollment:read",
        label: "View enrollments",
        description: "See which students are in which batch.",
      },
      {
        key: "enrollment:create",
        label: "Enroll students",
        description: "Put a student into a batch, one by one or from Excel.",
      },
      {
        key: "enrollment:update",
        label: "Update enrollments",
        description: "Change an enrollment's status (completed, cancelled) or its codes.",
      },
    ],
  },
  {
    key: "reports",
    label: "Issue reports",
    description: "Review and resolve credential issue reports.",
    permissions: [
      {
        key: "report:read",
        label: "View reports",
        description: "Read institution and student issue reports.",
      },
      {
        key: "report:create",
        label: "Create reports",
        description: "Report a problem with a credential.",
      },
      {
        key: "report:resolve",
        label: "Resolve reports",
        description: "Close reports with a resolution note.",
      },
    ],
  },
];

export const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key)
);

export const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);

// What a college may put in its own roles: never platform rights, admin powers (staff/role management,
// which only the Super Admin grants, P04) or a student's own actions (confirm, report).
const NOT_FOR_COLLEGE_ROLES = new Set(["platform:manage", "staff:invite", "staff:manage", "role:manage", "credential:confirm", "report:create"]);

export const COLLEGE_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => ({
  ...group,
  permissions: group.permissions.filter((permission) => !NOT_FOR_COLLEGE_ROLES.has(permission.key)),
})).filter((group) => group.permissions.length > 0);

export const COLLEGE_PERMISSION_KEY_SET = new Set(
  COLLEGE_PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.key))
);
