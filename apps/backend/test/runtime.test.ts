import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { defaultRunSettings } from "@ctf-agent/core/contracts"
import {
  ConfigurationDependencyError,
  createFileProjectRuntimeConfiguration,
  RuntimeConfigurationConflictError,
} from "../src/domain/runtime.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ctf-project-runtime-config-"))
  roots.push(root)
  return join(root, "runtime-config.json")
}

describe("ProjectRuntimeConfiguration", () => {
  it("旧配置缺少远程环境配额时使用回退值", async () => {
    const storagePath = await fixture()
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 1,
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
      }),
    )

    const configuration = await createFileProjectRuntimeConfiguration({
      storagePath,
      fallback: {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
        maxRemoteEnvironments: 2,
      },
      availableModelIds: () => new Set(["solver"]),
    })

    expect(configuration.snapshot().maxRemoteEnvironments).toBe(2)
  })

  it("按 Project 持久化 Agent 模型绑定和并发量", async () => {
    const storagePath = await fixture()
    const options = {
      storagePath,
      fallback: {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
        maxRemoteEnvironments: 1,
      },
      availableModelIds: () => new Set(["solver", "worker"]),
    }
    const configuration = await createFileProjectRuntimeConfiguration(options)
    expect(configuration.snapshot()).toMatchObject({
      solverModelId: "solver",
      maxConcurrent: 8,
    })

    await configuration.update({
      solverModelId: "worker",
      tldrModelId: "solver",
      subagentModels: { explorer: "worker" },
      maxConcurrent: 3,
      maxRemoteEnvironments: 2,
    })
    expect(JSON.parse(await readFile(storagePath, "utf8"))).toMatchObject({
      version: 1,
      solverModelId: "worker",
      maxConcurrent: 3,
    })
    expect((await createFileProjectRuntimeConfiguration(options)).snapshot()).toEqual(
      configuration.snapshot(),
    )
  })

  it("拒绝不存在的模型和越界并发量且不污染当前值", async () => {
    const configuration = await createFileProjectRuntimeConfiguration({
      storagePath: await fixture(),
      fallback: {
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
        maxRemoteEnvironments: 1,
      },
      availableModelIds: () => new Set(["solver"]),
    })
    await expect(
      configuration.update({
        solverModelId: "missing",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
        maxRemoteEnvironments: 1,
      }),
    ).rejects.toThrow("Solver 模型不存在")
    await expect(
      configuration.update({
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 65,
        maxRemoteEnvironments: 1,
      }),
    ).rejects.toThrow("maxConcurrent 必须是 1–64")
    await expect(
      configuration.update({
        solverModelId: "solver",
        tldrModelId: "solver",
        subagentModels: {},
        maxConcurrent: 8,
        maxRemoteEnvironments: 0,
      }),
    ).rejects.toThrow("maxRemoteEnvironments 必须是 1–64")
    expect(configuration.snapshot().solverModelId).toBe("solver")
  })

  describe("run settings", () => {
    const base = {
      solverModelId: "solver",
      tldrModelId: "solver",
      subagentModels: {},
      maxConcurrent: 8,
      maxRemoteEnvironments: 1,
    }
    const create = (storagePath: string, capabilities: string[] = []) =>
      createFileProjectRuntimeConfiguration({
        storagePath,
        fallback: base,
        availableModelIds: () => new Set(["solver"]),
        availableCapabilities: () => new Set(capabilities as never[]),
      })

    it("reads a file written before run settings existed as defaults at revision 0", async () => {
      const storagePath = await fixture()
      await writeFile(storagePath, JSON.stringify({ version: 1, ...base }))
      const configuration = await create(storagePath)
      expect(configuration.snapshot()).toEqual({ ...base, ...defaultRunSettings(), revision: 0 })
    })

    it("keeps stored settings when an older client omits them", async () => {
      const storagePath = await fixture()
      const capabilities = ["skill-snapshots"]
      const configuration = await create(storagePath, capabilities)
      await configuration.update({
        ...base,
        optimization: { skillSnapshots: true },
        skills: { solver: ["reverse"], subagents: { roles: { web: ["recon"] } } },
      })
      await configuration.update({ ...base, maxConcurrent: 4 })
      const reopened = (await create(storagePath, capabilities)).snapshot()
      expect(reopened).toMatchObject({
        maxConcurrent: 4,
        optimization: { skillSnapshots: true },
        skills: { solver: ["reverse"], subagents: { default: "all", roles: { web: ["recon"] } } },
        revision: 2,
      })
      // A full round trip of the snapshot changes nothing but the revision.
      const { revision, ...view } = reopened
      const echoed = await configuration.update({ ...view, expectedRevision: revision })
      expect({ ...echoed, revision: 0 }).toEqual({ ...reopened, revision: 0 })
    })

    it("rejects an update based on a stale revision without saving it", async () => {
      const storagePath = await fixture()
      const configuration = await create(storagePath)
      await configuration.update({ ...base, expectedRevision: 0 })
      const stale = configuration.update({ ...base, maxConcurrent: 2, expectedRevision: 0 })
      await expect(stale).rejects.toBeInstanceOf(RuntimeConfigurationConflictError)
      expect(configuration.snapshot()).toMatchObject({ maxConcurrent: 8, revision: 1 })
    })

    it("rejects switches this build cannot provide and leaves the file untouched", async () => {
      const storagePath = await fixture()
      const configuration = await create(storagePath)
      await configuration.update(base)
      const before = await readFile(storagePath, "utf8")
      await expect(
        configuration.update({ ...base, optimization: { blackboardReaderV2: true } }),
      ).rejects.toBeInstanceOf(ConfigurationDependencyError)
      await expect(
        configuration.update({ ...base, skills: { solver: ["reverse"] } }),
      ).rejects.toThrow("skills requires optimization.skillSnapshots")
      expect(await readFile(storagePath, "utf8")).toBe(before)
      expect(configuration.snapshot().optimization.blackboardReaderV2).toBe(false)
    })
  })
})
