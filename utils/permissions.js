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
    ],
  },
  {
    key: "credentials",
    label: "Credentials",
    description: "Issue, inspect, and confirm degree credentials.",
    permissions: [
      {
        key: "nft:read",
        label: "View credentials",
        description: "Read credential allocations and minted records.",
      },
      {
        key: "nft:create",
        label: "Create allocations",
        description: "Allocate new credentials to student wallets.",
      },
      {
        key: "nft:confirm",
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
        description: "Read uploaded student and allocation data.",
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
