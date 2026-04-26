// Re-export the zod schemas (which are values used at runtime for validation).
// Body types like CreateTaskBody are exported here as zod schemas (consumers
// can derive the TS type via `z.infer<typeof CreateTaskBody>`).
export * from "./generated/api";

// Schema model types that aren't body types (no naming collision with api.ts).
// These are ergonomic re-exports so server code can `import type { Attachment } from "@workspace/api-zod"`.
export type { Attachment } from "./generated/types/attachment";
export type { AttachmentKind } from "./generated/types/attachmentKind";
export type { AttachmentExtractionStatus } from "./generated/types/attachmentExtractionStatus";
