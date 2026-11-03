import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  cloneTemplateRoot,
  projectStateDirectory,
  templateFingerprint,
} from "../src/sample-root.ts"
import { removeTempDirs, tempDir, writeTemplateRoot } from "./helpers.ts"

afterEach(removeTempDirs)

const OTHER_KEY = "0123456789abcdef0123456789abcdef"

async function put(root: string, path: string, content = "x"): Promise<void> {
  const absolute = join(root, ...path.split("/"))
  await mkdir(join(absolute, ".."), { recursive: true })
  await writeFile(absolute, content)
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else files.push(relative(root, absolute).split(sep).join("/"))
    }
  }
  await walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

async function templateWithState(): Promise<string> {
  const template = await tempDir("template")
  await writeTemplateRoot(template, "root-project")
  for (const path of [
    ".ctf-agent/runtime-config.json",
    ".ctf-agent/model-config.json",
    ".ctf-agent/extensions/demo/active.json",
    ".ctf-agent/runs.sqlite",
    ".ctf-agent/runs.sqlite-wal",
    ".ctf-agent/runs/run-1/session.jsonl",
    ".ctf-agent/challenges/key/workspace/flag.txt",
    ".ctf-agent/audits.sqlite",
    `.ctf-agent/projects/${OTHER_KEY}/project-config.json`,
    `.ctf-agent/projects/${OTHER_KEY}/runtime-config.json`,
    `.ctf-agent/projects/${OTHER_KEY}/runs.sqlite`,
    `.ctf-agent/projects/${OTHER_KEY}/runs/run-2/session.jsonl`,
    `.ctf-agent/projects/${OTHER_KEY}/challenges/key/workspace/notes.txt`,
    ".pi/skills/triage/SKILL.md",
    "unrelated/notes.txt",
  ]) {
    await put(template, path)
  }
  return template
}

describe("cloneTemplateRoot", () => {
  it("keeps configuration and skills but drops every Project's solver state", async () => {
    const template = await templateWithState()
    const sample = join(await tempDir("sample"), "root")

    await cloneTemplateRoot(template, sample)

    expect(await listFiles(sample)).toEqual([
      ".ctf-agent/extensions/demo/active.json",
      ".ctf-agent/model-config.json",
      ".ctf-agent/project-config.json",
      ".ctf-agent/project-registry.json",
      `.ctf-agent/projects/${OTHER_KEY}/project-config.json`,
      `.ctf-agent/projects/${OTHER_KEY}/runtime-config.json`,
      ".ctf-agent/runtime-config.json",
      ".ctf-agent/secrets.json",
      ".pi/skills/triage/SKILL.md",
    ])
  })

  it("refuses to write into a non-empty sample root", async () => {
    const template = await templateWithState()
    const sample = await tempDir("occupied")
    await put(sample, "leftover.txt")

    await expect(cloneTemplateRoot(template, sample)).rejects.toThrow(/必须为空/)
  })

  it("rejects a template without a state directory", async () => {
    const template = await tempDir("empty-template")
    await expect(cloneTemplateRoot(template, join(template, "out"))).rejects.toThrow(/\.ctf-agent/)
  })
})

describe("projectStateDirectory", () => {
  it("resolves root and nested Projects from the registry", async () => {
    const root = await tempDir("registry")
    await put(
      root,
      ".ctf-agent/project-registry.json",
      JSON.stringify({
        version: 1,
        projects: [
          { id: "root-project", directory: "." },
          { id: "other", directory: `projects/${OTHER_KEY}` },
        ],
      }),
    )

    expect(await projectStateDirectory(root, "root-project")).toBe(join(root, ".ctf-agent"))
    expect(await projectStateDirectory(root, "other")).toBe(
      join(root, ".ctf-agent", "projects", OTHER_KEY),
    )
    await expect(projectStateDirectory(root, "missing")).rejects.toThrow(/不存在/)
  })

  it("rejects a directory that escapes the state root", async () => {
    const root = await tempDir("registry-escape")
    await put(
      root,
      ".ctf-agent/project-registry.json",
      JSON.stringify({ version: 1, projects: [{ id: "bad", directory: "../outside" }] }),
    )

    await expect(projectStateDirectory(root, "bad")).rejects.toThrow(/无效/)
  })
})

describe("templateFingerprint", () => {
  it("changes with configuration but not with solver state or secret contents", async () => {
    const template = await templateWithState()
    const first = await templateFingerprint(template)
    expect(first.sensitiveFilesPresent).toEqual([".ctf-agent/secrets.json"])

    await put(template, ".ctf-agent/runs/run-9/session.jsonl", "new run")
    await put(template, ".ctf-agent/secrets.json", "rotated secret")
    expect((await templateFingerprint(template)).sha256).toBe(first.sha256)

    await put(template, ".ctf-agent/runtime-config.json", "changed")
    expect((await templateFingerprint(template)).sha256).not.toBe(first.sha256)
  })
})
