import { join, resolve } from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { parseEvaluationConfig } from "../src/config.ts"

const base = resolve("/eval")

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group: "A-original",
    templateRoot: "template",
    outputDir: "out/a-original",
    projectId: "contest",
    challenges: ["web-1", { id: "pwn-2", label: "pwn" }],
    wallClockMs: 3_600_000,
    backend: { cwd: "../checkouts/jyff-5ae3b9d" },
    ...overrides,
  }
}

describe("parseEvaluationConfig", () => {
  it("resolves paths against the config directory and fills defaults", () => {
    const config = parseEvaluationConfig(minimal(), base)

    expect(config.templateRoot).toBe(join(base, "template"))
    expect(config.outputDir).toBe(join(base, "out", "a-original"))
    expect(config.backend.cwd).toBe(resolve(base, "../checkouts/jyff-5ae3b9d"))
    expect(config.challenges).toEqual([{ id: "web-1" }, { id: "pwn-2", label: "pwn" }])
    expect(config).toMatchObject({
      repeats: 3,
      idleSettleMs: 60_000,
      removeLeftoverContainers: true,
      pricing: {},
      backend: { host: "127.0.0.1", port: 3_900, extraArgs: [] },
    })
    expect(config.backend.command.slice(1)).toEqual([
      "--experimental-transform-types",
      "apps/backend/src/main.ts",
    ])
  })

  it("requires an explicit strict wall clock", () => {
    expect(() => parseEvaluationConfig(minimal({ wallClockMs: undefined }), base)).toThrow(
      /wallClockMs/,
    )
  })

  it("keeps sample roots with copied secrets out of the checkout under test", () => {
    expect(() =>
      parseEvaluationConfig(
        minimal({
          outputDir: "../checkouts/jyff-5ae3b9d/eval-out",
          backend: { cwd: "../checkouts/jyff-5ae3b9d" },
        }),
        base,
      ),
    ).toThrow(/不能位于被测仓库内/)
  })

  it("rejects backend arguments the evaluator manages", () => {
    expect(() =>
      parseEvaluationConfig(
        minimal({ backend: { cwd: "../checkouts/jyff", extraArgs: ["--auto-start"] } }),
        base,
      ),
    ).toThrow(/--auto-start/)
  })

  it("validates pricing keys and rates", () => {
    expect(() =>
      parseEvaluationConfig(minimal({ pricing: { "gpt-x": { input: 1 } } }), base),
    ).toThrow(/provider\/model/)
    expect(() =>
      parseEvaluationConfig(minimal({ pricing: { "openai/gpt-x": { input: -1 } } }), base),
    ).toThrow(/非负数/)
    expect(
      parseEvaluationConfig(minimal({ pricing: { "openai/gpt-x": { input: 2, output: 8 } } }), base)
        .pricing,
    ).toEqual({ "openai/gpt-x": { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } })
  })

  it("rejects duplicate challenges", () => {
    expect(() => parseEvaluationConfig(minimal({ challenges: ["a", { id: "a" }] }), base)).toThrow(
      /重复/,
    )
  })
})
