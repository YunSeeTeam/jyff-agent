import type { ExecutionReportKind } from "@ctf-agent/agents"
import { describe, expect, it } from "vite-plus/test"
import type { SubagentResultKind } from "../../src/contracts/index.ts"

// Compile-time checks: every kind agents can produce is a kind core can store,
// and the only extra stored kind is `legacy` (records from before executions).
type Produced = [ExecutionReportKind] extends [SubagentResultKind] ? true : false
type StoredOnly = Exclude<SubagentResultKind, ExecutionReportKind>
const producedFits: Produced = true
const storedOnly: StoredOnly[] = ["legacy"]

describe("frozen interfaces", () => {
  it("keeps the agents report kinds a subset of the stored result kinds", () => {
    expect(producedFits).toBe(true)
    expect(storedOnly).toEqual(["legacy"])
  })
})
