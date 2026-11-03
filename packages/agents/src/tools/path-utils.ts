import { type ExecutionEnv, getOrThrow } from "@ctf-agent/sandbox"

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = "\u202F"

function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, " ")
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

/** Resolve a model-supplied path inside the execution environment, never on the host. */
export async function resolveToolPath(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  return getOrThrow(await env.absolutePath(normalizeToolPath(path), signal))
}

/** Like resolveToolPath, but also tries the spelling variants screenshots and macOS produce. */
export async function resolveReadToolPath(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const resolved = await resolveToolPath(env, path, signal)
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ]
  for (const variant of new Set(variants)) {
    if (getOrThrow(await env.exists(variant, signal))) return variant
  }
  return resolved
}
