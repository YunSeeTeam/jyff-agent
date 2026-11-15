import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { discoverProjectSkills, discoverSubagentRoles } from "@ctf-agent/agents"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { defaultRunSettings, mergeRunSettings } from "../../src/contracts/index.ts"
import {
  buildRunConfigSnapshot,
  frozenSubagentRoles,
} from "../../src/project/run-config-snapshot.ts"
import { openRunSkills, skillManifestHash } from "../../src/project/run-skill-snapshot.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original, writeFile: vi.fn(original.writeFile) }
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const temporary = resolve(import.meta.dirname, "../../../../../outputs/tmp")
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, "run-skills-"))
  roots.push(root)
  for (const name of ["reverse", "crypto"]) {
    const directory = join(root, ".pi/skills", name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Original ${name}\n---\n# Instructions`,
    )
    await writeFile(join(directory, "helper.py"), `print('${name} original')`)
  }
  const discovered = await discoverProjectSkills(root)
  const roles = (await discoverSubagentRoles(root)).roles
  const configuration = await buildRunConfigSnapshot({
    runId: "run-one",
    challengeId: "challenge",
    skills: discovered,
    subagentRoles: roles,
    settings: mergeRunSettings(defaultRunSettings(), {
      optimization: { skillSnapshots: true },
      skills: { solver: ["reverse"], subagents: { default: ["crypto"], roles: { explorer: [] } } },
    }),
    model: undefined,
    thinkingLevel: "high",
    sandbox: { privileged: false, networkMode: "none" },
  })
  return {
    root,
    roles,
    input: {
      discovered,
      configuration,
      runDirectory: join(root, "runs/run-one"),
      workspace: join(root, "workspace"),
      hasStarted: false,
    },
  }
}

describe("Run skill snapshots", () => {
  it("preserves an inferred skill name and original bytes through publication and resume (T20/T21)", async () => {
    const { root, input } = await fixture()
    const sourcePath = join(root, ".pi/skills/reverse/SKILL.md")
    const content = Buffer.from("---\r\ndescription: Inferred reverse\r\n---\r\n# Original 😀\r\n")
    await writeFile(sourcePath, content)
    input.discovered = await discoverProjectSkills(root)
    expect(input.discovered.find((skill) => skill.name === "reverse")?.description).toBe(
      "Inferred reverse",
    )

    const skills = await openRunSkills(input)
    const entry = skills.manifest.packages.find((pkg) => pkg.name === "reverse")!
    const manifestPath = join(input.runDirectory, "skills/manifest.json")
    const savedManifest = await readFile(manifestPath)
    const savedSkill = join(input.runDirectory, "skills", entry.hostPath, "SKILL.md")
    expect(await readFile(savedSkill)).toEqual(content)
    expect(await readFile(sourcePath)).toEqual(content)
    expect((await skills.forSolver())[0]).toMatchObject({
      name: "reverse",
      description: "Inferred reverse",
    })
    await writeFile(sourcePath, "---\nname: changed\ndescription: Updated source\n---\n")
    const resumed = await openRunSkills({ ...input, discovered: [], hasStarted: true })
    expect((await resumed.forSolver())[0]).toMatchObject({
      name: "reverse",
      description: "Inferred reverse",
    })
    expect(resumed.manifest.manifestHash).toBe(skills.manifest.manifestHash)
    expect(await readFile(manifestPath)).toEqual(savedManifest)
    expect(await readFile(savedSkill)).toEqual(content)
    expect(
      await readFile(
        join(input.workspace, ".skills", input.configuration.runId, entry.hash, "SKILL.md"),
      ),
    ).toEqual(content)
  })

  it("keeps distinct frozen names for identical packages selected by Solver and child (T20/T21)", async () => {
    const { root, input } = await fixture()
    const content = "---\ndescription: Shared instructions\n---\n# Original 😀\n"
    for (const name of ["crypto", "reverse"]) {
      await writeFile(join(root, ".pi/skills", name, "SKILL.md"), content)
      await writeFile(join(root, ".pi/skills", name, "helper.py"), "print('shared helper')")
    }
    input.discovered = await discoverProjectSkills(root)
    // Limits count each selected logical package, even if its bytes can be reused.
    await expect(openRunSkills({ ...input, limits: { maxFiles: 3 } })).rejects.toMatchObject({
      code: "skill_snapshot_limit",
    })
    expect(await readdir(input.runDirectory)).toEqual([])
    await expect(
      openRunSkills({
        ...input,
        limits: { maxBytes: Buffer.byteLength(content + "print('shared helper')") },
      }),
    ).rejects.toMatchObject({ code: "skill_snapshot_limit" })
    expect(await readdir(input.runDirectory)).toEqual([])

    const skills = await openRunSkills(input)
    expect(skills.manifest.packages.map((pkg) => pkg.name)).toEqual(["crypto", "reverse"])
    const [crypto, reverse] = skills.manifest.packages
    expect(crypto!.hash).toBe(reverse!.hash)
    expect(crypto!.hostPath).toBe(reverse!.hostPath)
    expect(await readdir(join(input.runDirectory, "skills/packages"))).toEqual([crypto!.hash])
    expect((await skills.forSolver()).map((skill) => skill.name)).toEqual(["reverse"])
    expect((await skills.forRole("general-purpose")).map((skill) => skill.name)).toEqual(["crypto"])
    expect(await skills.forRole("explorer")).toEqual([])
    const manifestPath = join(input.runDirectory, "skills/manifest.json")
    const savedManifest = await readFile(manifestPath)
    await rm(join(root, ".pi/skills"), { recursive: true })

    const resumed = await openRunSkills({ ...input, discovered: [], hasStarted: true })
    expect((await resumed.forSolver()).map((skill) => skill.name)).toEqual(["reverse"])
    expect((await resumed.forRole("general-purpose")).map((skill) => skill.name)).toEqual([
      "crypto",
    ])
    expect(await readFile(manifestPath)).toEqual(savedManifest)
    const savedSkill = join(input.runDirectory, "skills", crypto!.hostPath, "SKILL.md")
    expect(await readFile(savedSkill, "utf8")).toBe(content)
    await writeFile(savedSkill, content + "tampered")
    await expect(resumed.forSolver()).rejects.toMatchObject({ code: "skill_snapshot_changed" })
    await expect(resumed.forRole("general-purpose")).rejects.toMatchObject({
      code: "skill_snapshot_changed",
    })
  })

  it("freezes selected package bytes and reparses metadata, with replacing role overrides (T20/T21)", async () => {
    const { root, input } = await fixture()
    // Discovery metadata is intentionally stale: publication must parse the saved bytes.
    input.discovered.find((skill) => skill.name === "reverse")!.description = "stale metadata"
    const skills = await openRunSkills(input)
    expect((await skills.forSolver()).map((skill) => [skill.name, skill.description])).toEqual([
      ["reverse", "Original reverse"],
    ])
    expect((await skills.forRole("general-purpose")).map((skill) => skill.name)).toEqual(["crypto"])
    expect(await skills.forRole("explorer")).toEqual([])
    expect(skills.manifest.packages.map((entry) => entry.name)).toEqual(["crypto", "reverse"])
    await writeFile(join(root, ".pi/skills/crypto/helper.py"), "print('changed source')")
    const reopened = await openRunSkills({ ...input, discovered: [], hasStarted: true })
    const child = (await reopened.forRole("fuzzer"))[0]!
    expect(
      await readFile(
        join(input.workspace, child.sandboxBaseDir!.slice("/workspace/".length), "helper.py"),
        "utf8",
      ),
    ).toBe("print('crypto original')")
    expect(reopened.manifest.manifestHash).toBe(skills.manifest.manifestHash)
  })

  it("repairs workspace changes for a later child and isolates Runs sharing the workspace (T21)", async () => {
    const { root, input } = await fixture()
    const repaired: string[] = []
    const skills = await openRunSkills({ ...input, onRepaired: (name) => repaired.push(name) })
    const child = (await skills.forRole("fuzzer"))[0]!
    const oldHelper = join(
      input.workspace,
      child.sandboxBaseDir!.slice("/workspace/".length),
      "helper.py",
    )
    await writeFile(oldHelper, "changed by worker")
    await skills.forRole("fuzzer")
    expect(await readFile(oldHelper, "utf8")).toBe("print('crypto original')")
    expect(repaired).toEqual(["crypto", "crypto"])
    await writeFile(join(root, ".pi/skills/crypto/helper.py"), "print('next Run')")
    const next = await openRunSkills({
      ...input,
      runDirectory: join(root, "runs/run-two"),
      configuration: { ...input.configuration, runId: "run-two" },
    })
    expect((await next.forRole("fuzzer"))[0]!.sandboxPath).not.toBe(child.sandboxPath)
    expect(await readFile(oldHelper, "utf8")).toBe("print('crypto original')")
  })

  it("rejects missing or corrupted host data rather than using current sources (T22)", async () => {
    const { input } = await fixture()
    await expect(openRunSkills({ ...input, hasStarted: true })).rejects.toMatchObject({
      code: "skill_snapshot_unavailable",
    })
    const skills = await openRunSkills(input)
    const saved = skills.manifest.packages[0]!
    await writeFile(join(input.runDirectory, "skills", saved.hostPath, "helper.py"), "corrupt")
    await expect(skills.forRole("fuzzer")).rejects.toMatchObject({ code: "skill_snapshot_changed" })
    await expect(openRunSkills({ ...input, hasStarted: true })).rejects.toMatchObject({
      code: "skill_snapshot_changed",
    })
  })

  it("validates manifest identity, selections and hashes (T22)", async () => {
    const { input } = await fixture()
    const skills = await openRunSkills(input)
    const manifest = { ...skills.manifest, runId: "another-run" }
    manifest.manifestHash = skillManifestHash(manifest)
    await writeFile(join(input.runDirectory, "skills/manifest.json"), JSON.stringify(manifest))
    await expect(openRunSkills({ ...input, hasStarted: true })).rejects.toMatchObject({
      code: "skill_snapshot_changed",
    })
  })

  it("rechecks manifest authority before a later child or resume (T22)", async () => {
    const { input } = await fixture()
    const skills = await openRunSkills(input)
    const path = join(input.runDirectory, "skills/manifest.json")
    const saved = await readFile(path, "utf8")
    await rm(path)
    await expect(skills.forRole("fuzzer")).rejects.toMatchObject({
      code: "skill_snapshot_unavailable",
    })
    await writeFile(path, saved.replace('"schemaVersion": 1', '"schemaVersion": 2'))
    await expect(skills.forRole("fuzzer")).rejects.toMatchObject({ code: "skill_snapshot_changed" })
  })

  it("rejects loose Markdown packages with a linked source root", async () => {
    const { root, input } = await fixture()
    const linked = join(root, "linked-source")
    await symlink(
      join(root, ".pi/skills/reverse"),
      linked,
      process.platform === "win32" ? "junction" : "dir",
    )
    await writeFile(
      join(root, ".pi/skills/reverse/loose.md"),
      "---\nname: reverse\ndescription: Reverse\n---\nInstructions",
    )
    input.discovered.find((skill) => skill.name === "reverse")!.baseDir = linked
    input.discovered.find((skill) => skill.name === "reverse")!.filePath = join(linked, "loose.md")
    await expect(openRunSkills(input)).rejects.toMatchObject({ code: "skill_snapshot_changed" })
  })

  it("recovers a published manifest even if its event failed, without re-reading source (T22)", async () => {
    const { root, input } = await fixture()
    await expect(
      openRunSkills({
        ...input,
        onPublished: () => {
          throw new Error("event unavailable")
        },
      }),
    ).rejects.toThrow("event unavailable")
    await rm(join(root, ".pi/skills"), { recursive: true })
    let events = 0
    const recovered = await openRunSkills({
      ...input,
      discovered: [],
      hasStarted: true,
      onPublished: () => {
        events++
      },
    })
    expect(events).toBe(1)
    expect((await recovered.forSolver())[0]!.name).toBe("reverse")
  })

  it("bounds packages and removes unpublished staging directories (T22)", async () => {
    const { input } = await fixture()
    await expect(openRunSkills({ ...input, limits: { maxBytes: 1 } })).rejects.toMatchObject({
      code: "skill_snapshot_limit",
    })
    expect(await readdir(input.runDirectory)).toEqual([])
    await expect(openRunSkills({ ...input, limits: { maxFiles: 3 } })).rejects.toMatchObject({
      code: "skill_snapshot_limit",
    })
    expect(await readdir(input.runDirectory)).toEqual([])
  })

  it.each(["crypto", "reverse"])(
    "rejects a source mutation while copying %s and publishes no manifest (T22)",
    async (copyingName) => {
      const { root, input } = await fixture()
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const source = join(root, ".pi/skills/crypto/helper.py")
      const changedSource = "print('crypto modified')"
      const onPublished = vi.fn()
      let mutated = false
      vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
        await original.writeFile(path, data, options)
        const text =
          typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null
        if (
          !mutated &&
          typeof path === "string" &&
          path.includes(".skills-staging-") &&
          path.endsWith("helper.py") &&
          text === `print('${copyingName} original')`
        ) {
          mutated = true
          // Same-sized bytes change during copying, including an already copied package
          // when reverse is being staged after crypto's first source verification.
          await original.writeFile(source, changedSource)
        }
      })
      try {
        await expect(openRunSkills({ ...input, onPublished })).rejects.toMatchObject({
          code: "skill_snapshot_changed",
          message: `Skill source changed ${copyingName === "crypto" ? "during" : "before"} publication: crypto`,
        })
        expect(mutated).toBe(true)
        expect(await readFile(source, "utf8")).toBe(changedSource)
        expect(onPublished).not.toHaveBeenCalled()
        expect(await readdir(input.runDirectory)).toEqual([])
        await expect(
          readFile(join(input.runDirectory, "skills/manifest.json")),
        ).rejects.toMatchObject({ code: "ENOENT" })
        // A resumed Run must report the missing snapshot, never load the changed source.
        await expect(openRunSkills({ ...input, hasStarted: true })).rejects.toMatchObject({
          code: "skill_snapshot_unavailable",
        })
      } finally {
        vi.mocked(writeFile).mockImplementation(original.writeFile)
      }
    },
  )

  it("rejects source directory links and workspace parent links", async () => {
    const { root, input } = await fixture()
    await symlink(
      join(root, ".pi/skills/crypto"),
      join(root, ".pi/skills/reverse/link"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(openRunSkills(input)).rejects.toMatchObject({ code: "skill_snapshot_changed" })
    await rm(join(root, ".pi/skills/reverse/link"))
    const skills = await openRunSkills(input)
    await mkdir(input.workspace, { recursive: true })
    await symlink(
      join(root, ".pi/skills"),
      join(input.workspace, ".skills"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(skills.forSolver()).rejects.toMatchObject({ code: "skill_snapshot_changed" })
  })

  it("supports all and empty selections without changing Father materialization (T20/T23)", async () => {
    const { input } = await fixture()
    const all = {
      ...input.configuration,
      skills: { solver: ["crypto", "reverse"], subagentDefault: [], subagentRoles: {} },
    }
    const skills = await openRunSkills({ ...input, configuration: all })
    expect((await skills.forSolver()).map((skill) => skill.name)).toEqual(["crypto", "reverse"])
    expect(await skills.forRole("fuzzer")).toEqual([])
  })

  it("restores actual frozen role prompts instead of updated source definitions", async () => {
    const { input, roles } = await fixture()
    const original = roles.get("explorer")!.systemPrompt
    roles.get("explorer")!.systemPrompt = "changed source prompt"
    expect(frozenSubagentRoles(input.configuration, roles).get("explorer")!.systemPrompt).toBe(
      original,
    )
    const { roleDefinitions: _roles, ...legacy } = input.configuration
    expect(() => frozenSubagentRoles(legacy, roles)).toThrow("Frozen SubAgent role unavailable")
  })
})
