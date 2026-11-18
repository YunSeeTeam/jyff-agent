import {
  migrateStoredRunSettings,
  REVIEW_MAX_CONCURRENT_LIMIT,
  REVIEW_MAX_PER_GOAL_LIMIT,
  type RunSettingsPatch,
} from "@ctf-agent/core/contracts"
import { z } from "zod"

const skillName = z
  .string({ message: "Skill 名称必须是字符串" })
  .trim()
  .min(1, { message: "Skill 名称不能为空" })
  .max(128, { message: "Skill 名称长度不能超过 128" })
const skillSelection = z.union([
  z.literal("all"),
  z.array(skillName).max(256, { message: "单个 Skill 选择最多 256 项" }),
])
const roleName = z.string().trim().min(1).max(64)

/**
 * Run settings as a partial update. `strict` rejects unknown keys for API input;
 * stored files are read leniently so a newer file still loads after a rollback.
 */
function runSettingsPatchSchema(strict: boolean) {
  const object = <T extends z.ZodRawShape>(shape: T) =>
    strict ? z.strictObject(shape) : z.object(shape)
  return object({
    optimization: object({
      schemaVersion: z.literal(1).optional(),
      blackboardReaderV2: z.boolean().optional(),
      fullSubagentReports: z.boolean().optional(),
      skillSnapshots: z.boolean().optional(),
      localProcesses: z.union([z.boolean(), z.literal("fixed-attachments")]).optional(),
      review: object({
        enabled: z.boolean().optional(),
        maxPerGoal: z.number().int().min(0).max(REVIEW_MAX_PER_GOAL_LIMIT).optional(),
        maxConcurrent: z.number().int().min(1).max(REVIEW_MAX_CONCURRENT_LIMIT).optional(),
      }).optional(),
    }).optional(),
    skills: object({
      version: z.literal(1).optional(),
      solver: skillSelection.optional(),
      subagents: object({
        default: skillSelection.optional(),
        roles: z.record(roleName, skillSelection).optional(),
      }).optional(),
    }).optional(),
  })
}

/** API input: unknown keys and `null` are rejected rather than ignored. */
export const runSettingsUpdateSchema = runSettingsPatchSchema(true)

const storedRunSettingsSchema = runSettingsPatchSchema(false)

/** Parse the run settings stored in a runtime configuration file. */
export function parseStoredRunSettings(value: unknown): RunSettingsPatch | undefined {
  const parsed = storedRunSettingsSchema.safeParse(migrateStoredRunSettings(value))
  return parsed.success ? parsed.data : undefined
}
