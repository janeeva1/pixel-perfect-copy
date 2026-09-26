import { z } from "zod";
import type { DownloadRequest } from "@/server/downloads";

/**
 * The one place a download request is read from the query string, shared by the
 * preview and the file itself. The two must not be able to disagree: an operator
 * shown "present only, 412 rows" has to get exactly that file, so both go through
 * this and then through the same `buildDownload`.
 */
export const downloadSchema = z.object({
  group: z.enum(["student", "staff"]),
  scopeType: z.enum(["event", "day", "week", "month", "range"]),
  eventId: z.string().uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  category: z.enum(["community_mass", "other", "all"]).default("all"),
  detail: z.enum(["present", "absent", "combined"]).default("combined"),
  department: z.string().trim().max(120).optional(),
});

export function toDownloadRequest(params: z.output<typeof downloadSchema>): DownloadRequest {
  return {
    group: params.group,
    scopeType: params.scopeType,
    eventId: params.eventId ?? null,
    date: params.date ?? null,
    from: params.from ?? null,
    to: params.to ?? null,
    category: params.category,
    detail: params.detail,
    department: params.department ?? null,
  };
}

export function readDownloadRequest(request: Request): DownloadRequest {
  const params = downloadSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return toDownloadRequest(params);
}
