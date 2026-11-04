import {
  BUDGET_MAX_CONCURRENT_MODEL_REQUESTS_LIMIT,
  BUDGET_POSTPROCESS_MAX_MS,
  BUDGET_POSTPROCESS_MIN_MS,
  BUDGET_WALL_CLOCK_MAX_MS,
  BUDGET_WALL_CLOCK_MIN_MS,
  REVIEW_MAX_CONCURRENT_LIMIT,
  REVIEW_MAX_PER_BUDGET_LIMIT,
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
// Millionths of the budget currency; null (where allowed) means no limit.
const costMicros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

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
      localProcesses: z.boolean().optional(),
      review: object({
        enabled: z.boolean().optional(),
        maxPerBudget: z.number().int().min(0).max(REVIEW_MAX_PER_BUDGET_LIMIT).optional(),
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
    budgetPolicy: object({
      schemaVersion: z.literal(1).optional(),
      enabled: z.boolean().optional(),
      clockMode: z.literal("strict_wall_clock").optional(),
      wallClockMs: z
        .number()
        .int()
        .min(BUDGET_WALL_CLOCK_MIN_MS)
        .max(BUDGET_WALL_CLOCK_MAX_MS)
        .optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/, { message: "currency 必须是 3 位大写 ISO 4217 货币代码" })
        .optional(),
      maxCostMicros: costMicros.nullable().optional(),
      maxConcurrentModelRequests: z
        .number()
        .int()
        .min(1)
        .max(BUDGET_MAX_CONCURRENT_MODEL_REQUESTS_LIMIT)
        .optional(),
      postprocessMs: z
        .number()
        .int()
        .min(BUDGET_POSTPROCESS_MIN_MS)
        .max(BUDGET_POSTPROCESS_MAX_MS)
        .optional(),
      postprocessMaxCostMicros: costMicros.nullable().optional(),
    }).optional(),
  })
}

/** API input: unknown keys and `null` are rejected rather than ignored. */
export const runSettingsUpdateSchema = runSettingsPatchSchema(true)

const storedRunSettingsSchema = runSettingsPatchSchema(false)

/** Parse the run settings stored in a runtime configuration file. */
export function parseStoredRunSettings(value: unknown): RunSettingsPatch | undefined {
  const parsed = storedRunSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
