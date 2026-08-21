/** dataCli.ts's subcommands as an enum instead of hand-typed string literals in its switch. */
export const DataCliCommand = {
  Status: "status",
  Sessions: "sessions",
  Show: "show",
  Read: "read",
  Search: "search",
  Rename: "rename",
  Gc: "gc",
} as const;
export type DataCliCommand = (typeof DataCliCommand)[keyof typeof DataCliCommand];
