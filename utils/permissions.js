export const PERMISSION_GROUPS = [
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
