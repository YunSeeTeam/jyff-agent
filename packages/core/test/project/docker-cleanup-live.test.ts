import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DockerSandbox, executeDockerCommand, removeManagedContainers } from "@ctf-agent/sandbox"
import * as shellpoop from "@ctf-agent/shellpoop"
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { CtfSubagentManager } from "../../src/collaboration/subagent-manager.ts"
import { RunStore } from "../../src/persistence/run-store.ts"
import { challengeWorkspacePath } from "../../src/project/challenge-workspace.ts"
import { Project } from "../../src/project/project.ts"
import { TestPlatformPlugin } from "../fake-platform.ts"
import {
  type FixedReceipt,
  fixedSampleMounts,
  fixedReadsRequested,
  inspectFixedReads,
  startFixedReads,
} from "./fixtures/fixed-attachment-witness.ts"

async function docker(args: string[]): Promise<string> {
  const result = await executeDockerCommand(args, { timeoutMs: 30_000 })
  if (result.code !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function saveFixedRead(
  project: Project,
  runId: string,
  session: FixedReceipt["sessions"][number],
) {
  const refs: string[] = []
  let pages = 0
  for (const [index, stream] of (["stdout", "stderr"] as const).entries()) {
    const { bytes, sha256 } = session.streams[index]!
    const ref = await project.evidence.capture(runId, {
      path: `.fixed-attachment-receipts/copy-${session.id}-${stream}.bin`,
      prefixBytes: bytes,
      expectedSha256: sha256,
    })
    const observed = createHash("sha256")
    let offset = 0
    do {
      const page = await project.evidence.content(runId, ref.refId, { offset, limitBytes: 4093 })
      const chunk = Buffer.from(page.content, "base64")
      expect(page.offset).toBe(offset)
      expect(page.nextOffset).toBe(offset + chunk.length)
      expect(page.hasMore).toBe(page.nextOffset < bytes)
      if (page.hasMore) expect(chunk.length).toBeGreaterThan(0)
      observed.update(chunk)
      offset = page.nextOffset
      pages++
    } while (offset < bytes)
    expect(observed.digest("hex")).toBe(sha256)
    refs.push(ref.refId)
  }
  const status =
    session.state === "exited"
      ? "exited"
      : session.state === "interrupted"
        ? "interrupted"
        : "unknown"
  const record = await project.evidence.record(runId, {
    status,
    ...(session.exitCode !== null && { exitCode: session.exitCode }),
    stdoutRef: refs[0],
    stderrRef: refs[1],
  })
  return {
    experimentId: record.id,
    status: record.status,
    exitCode: record.exitCode,
    stdoutRef: refs[0],
    stderrRef: refs[1],
    pages,
  }
}

// The grandchild writes its PID after reparenting and exits. The observer stays
// in the same PID namespace and checks the actual /proc entry disappeared.
const orphanProbe = `import os, time
r, w = os.pipe()
parent = os.fork()
if parent == 0:
    os.close(r)
    if os.fork():
        os._exit(0)
    deadline = time.monotonic() + 4
    while os.getppid() != 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    os.write(w, ("%d %d" % (os.getpid(), os.getppid())).encode())
    os._exit(0)
os.close(w)
os.waitpid(parent, 0)
pid, adopter = map(int, os.read(r, 64).split())
deadline = time.monotonic() + 4
while os.path.exists("/proc/%d" % pid) and time.monotonic() < deadline:
    time.sleep(0.01)
print(adopter, "present" if os.path.exists("/proc/%d" % pid) else "reaped")`

describe.runIf(process.env.DOCKER_LIVE === "1")("offline Docker container cleanup", () => {
  let root: string
  let projectId: string
  let image: string
  const label = () => "ctf-agent.test.cleanup=" + projectId
  const config = () => ({
    version: 1 as const,
    project: { id: projectId, name: "Offline container cleanup" },
    platform: { plugin: "test", config: {} },
    sandbox: { image, networkMode: "none" as const, privileged: false },
  })
  async function ids(all = true) {
    const list = await docker([
      "ps",
      ...(all ? ["--all"] : []),
      "--quiet",
      "--no-trunc",
      "--filter",
      "label=" + label(),
    ])
    return list.split(/\s+/).filter(Boolean).sort()
  }
  async function managedForRun(runId: string) {
    // Read-only preflight before letting Project use its production remover.
    const list = await docker([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      "label=ctf-agent.managed=true",
      "--filter",
      "label=ctf-agent.project=" + projectId,
      "--filter",
      "label=ctf-agent.run=" + runId,
    ])
    return list.split(/\s+/).filter(Boolean)
  }
  function idleContainer(extraLabels: string[] = []) {
    return docker([
      "run",
      "--detach",
      "--pull=never",
      "--network=none",
      "--init",
      "--label",
      label(),
      ...extraLabels.flatMap((value) => ["--label", value]),
      "--entrypoint",
      "sleep",
      image,
      "300",
    ])
  }
  async function sample(challenge: "misc1" | "misc2") {
    const workspace = challengeWorkspacePath(join(root, ".ctf-agent"), challenge)
    await mkdir(workspace, { recursive: true })
    const path = join(workspace, "sample.bin")
    const samples = process.env.DOCKER_CLEANUP_SAMPLES
    if (fixedReadsRequested && !samples)
      throw new Error("Fixed reads require DOCKER_CLEANUP_SAMPLES")
    if (samples) await copyFile(join(samples, challenge, challenge + "_attachment.zip"), path)
    else await writeFile(path, "local cleanup fixture " + challenge)
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
  }
  async function pending() {
    const store = await RunStore.open(join(root, ".ctf-agent", "runs.sqlite"))
    try {
      return store
        .pendingSandboxCleanup()
        .map((r) => r.id)
        .sort()
    } finally {
      store.close()
    }
  }
  function reopen() {
    return Project.openLocal({ root, config: config(), platforms: [] })
  }
  beforeEach(async () => {
    projectId = "cleanup-live-" + randomUUID()
    root = await mkdtemp(join(tmpdir(), "ctf-cleanup-live-"))
    image = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest",
    ])
    expect(image).toMatch(/^sha256:[0-9a-f]{64}$/)
  }, 45_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    // All fixtures, including the out-of-scope controls, have this unique label.
    // The tests assert the product's removals before this final sweep.
    try {
      const remaining = await ids()
      if (remaining.length) await docker(["rm", "--force", ...remaining])
      expect(await ids()).toEqual([])
      console.info(
        "cleanup-live teardown",
        JSON.stringify({ projectId, removedControlsOrLeftovers: remaining.length, remaining: 0 }),
      )
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }, 60_000)

  it("T36 recovers containers after owner death, retries a refused removal and preserves facts and label isolation", async () => {
    const failed = randomUUID(),
      writeup = randomUUID()
    const hashes = [await sample("misc1"), await sample("misc2")]
    const owner = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        fileURLToPath(new URL("./fixtures/docker-cleanup-owner.ts", import.meta.url)),
        root,
        projectId,
        image,
        failed,
        writeup,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 60_000 },
    )
    let stderr = ""
    owner.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const [code, signal] = await once(owner, "close")
    const ready = JSON.parse(
      await readFile(join(root, "owner-ready.json"), "utf8").catch(() => {
        throw new Error("Owner did not finish setup: " + stderr)
      }),
    ) as {
      pid: number
      containers: [string, string]
      hashes: string[]
      exitedExperimentId: string
      unknownExperimentId: string
      acceptedAt: string
    }
    expect(ready.pid).toBe(owner.pid)
    expect(signal === "SIGKILL" || (process.platform === "win32" && code === 1)).toBe(true)
    expect(ready.hashes).toEqual(hashes)
    const [failedBox, writeupBox] = ready.containers
    expect(await ids(false)).toEqual([...ready.containers].sort())
    const fixedReads: FixedReceipt[][] = []
    const savedReads: Awaited<ReturnType<typeof saveFixedRead>>[] = []
    const auditReads = (reconcile: boolean) =>
      Promise.all(
        ["misc1", "misc2"].map((sample) =>
          inspectFixedReads(
            image,
            challengeWorkspacePath(join(root, ".ctf-agent"), sample),
            label(),
            reconcile,
          ),
        ),
      )
    if (fixedReadsRequested) {
      const initial = await auditReads(false)
      expect(initial.map((r) => r.sessions.map((s) => s.held))).toEqual([[false, true], [true]])
      fixedReads.push(initial)
    }
    const controls = [
      await idleContainer([
        "ctf-agent.project=" + projectId + "-other",
        "ctf-agent.run=" + failed,
        "ctf-agent.managed=true",
      ]),
      await idleContainer([
        "ctf-agent.project=" + projectId,
        "ctf-agent.run=" + failed,
        "ctf-agent.managed=false",
      ]),
    ].sort()
    expect(await managedForRun(failed)).toEqual([failedBox])
    expect(await managedForRun(writeup)).toEqual([writeupBox])
    const attempted: string[] = []
    // Fault injection changes only the first rm on the failed Run. The real
    // daemon refuses to remove a running container without force.
    const first = await Project.openLocal({
      root,
      config: config(),
      platforms: [],
      removeManagedSandboxes: async (runIds) => {
        attempted.push(...runIds)
        await removeManagedContainers(
          runIds,
          (args, options) => {
            if (args[0] === "rm") {
              const expected = runIds.includes(failed) ? failedBox : writeupBox
              expect(args).toHaveLength(3)
              expect(args[2]).toMatch(/^[0-9a-f]{12,64}$/)
              expect(expected.startsWith(args[2]!)).toBe(true)
              if (runIds.includes(failed)) return executeDockerCommand(["rm", args[2]!], options)
            }
            return executeDockerCommand(args, options)
          },
          projectId,
        )
      },
    })
    try {
      expect(attempted).toEqual([failed, writeup])
      expect(first.diagnostics()).toContainEqual(
        expect.objectContaining({
          code: "sandbox",
          runId: failed,
          message: expect.stringMatching(/Docker remove failed:.*running/is),
        }),
      )
      expect(await ids()).toEqual([failedBox, ...controls].sort())
      expect(await ids(false)).toEqual([failedBox, ...controls].sort())
    } finally {
      await first.close()
    }
    expect(await pending()).toEqual([failed])
    expect(await managedForRun(failed)).toEqual([failedBox])
    if (fixedReadsRequested) {
      const firstScan = await auditReads(true)
      expect(firstScan.map((r) => r.sessions.map((s) => [s.held, s.pending]))).toEqual([
        [
          [false, false],
          [true, true],
        ],
        [[false, false]],
      ])
      fixedReads.push(firstScan)
    }
    // No injected executor on the next startup. It uses the production Project
    // selector and real Docker. Both similarly labelled control containers survive.
    const recovered = await reopen()
    try {
      expect(recovered.diagnostics().filter((d) => d.code === "sandbox")).toEqual([])
      expect(await ids()).toEqual(controls)
      expect(recovered.runs()).toContainEqual(
        expect.objectContaining({
          id: failed,
          status: "failed",
          closeReason: "failed",
          error: "original fixture failure",
          cleanupError: "cleanup unconfirmed",
        }),
      )
      expect(recovered.runs()).toContainEqual(
        expect.objectContaining({
          id: writeup,
          status: "interrupted",
          solveOutcome: "accepted",
          observedAcceptedAt: ready.acceptedAt,
          writeupStatus: "interrupted",
        }),
      )
      expect(await recovered.evidence.experiment(failed, ready.exitedExperimentId)).toMatchObject({
        status: "exited",
        exitCode: 1,
        inputs: [{ sha256: hashes[0] }],
      })
      expect(await recovered.evidence.experiment(writeup, ready.unknownExperimentId)).toMatchObject(
        {
          status: "unknown",
          exitCode: null,
          inputs: [{ sha256: hashes[1] }],
        },
      )
    } finally {
      await recovered.close()
    }
    expect(await pending()).toEqual([])
    if (fixedReadsRequested) {
      const secondScan = await auditReads(true)
      expect(secondScan.map((r) => r.visited)).toEqual([[2], []])
      expect(secondScan.map((r) => r.sessions.map((s) => [s.state, s.exitCode]))).toEqual([
        [
          ["exited", 2],
          ["interrupted", null],
        ],
        [["interrupted", null]],
      ])
      for (const receipt of secondScan) {
        for (const s of receipt.sessions) {
          expect(s).toMatchObject({ held: false, pending: false, boots: 1 })
        }
      }
      const stable = (set: FixedReceipt[]) =>
        set.map((r) => r.sessions.map((s) => [s.id, s.pid, s.streams]))
      expect(stable(secondScan)).toEqual(stable(fixedReads[0]!))
      fixedReads.push(secondScan)
      expect((await auditReads(true)).map((r) => r.visited)).toEqual([[], []])
    }
    const again = await reopen()
    try {
      expect(await ids(false)).toEqual(controls)
      if (fixedReadsRequested) {
        for (const receipt of fixedReads.at(-1)!) {
          for (const session of receipt.sessions) {
            savedReads.push(
              await saveFixedRead(again, receipt.phase === "failed" ? failed : writeup, session),
            )
          }
        }
        expect(savedReads.map((r) => r.exitCode)).toEqual([2, null, null])
      }
    } finally {
      await again.close()
    }
    console.info(
      "cleanup-live T36",
      JSON.stringify({
        projectId,
        image,
        ownerPid: ready.pid,
        ownerExit: { code, signal },
        failedBox,
        writeupBox,
        sampleSha256: hashes,
        firstRemovalRefused: true,
        pendingAfterRetry: 0,
        controlsSurvived: controls.length,
        preservedExit: 1,
        unobservedExit: null,
        ...(fixedReadsRequested && { fixedReads, savedReads }),
        acceptedAt: ready.acceptedAt,
      }),
    )
  }, 120_000)

  it("T38 reclaims the leased container and sandbox after a session fails to close", async () => {
    const digest = await sample("misc2")
    const workspace = challengeWorkspacePath(join(root, ".ctf-agent"), "misc2")
    const fixedReads: FixedReceipt[] = []
    const savedReads: Awaited<ReturnType<typeof saveFixedRead>>[] = []
    const platform = new TestPlatformPlugin()
    // Keep the platform and its lease offline, with a real, separate resource
    // behind instance.destroy(). Both container removals must precede teardown.
    let leasedBox: string | undefined
    const connect = platform.connect.bind(platform)
    vi.spyOn(platform, "connect").mockImplementationOnce(async (options) => {
      const offline = await connect(options)
      const bind = offline.bindChallenge.bind(offline)
      offline.bindChallenge = async (challengeId) => {
        const capability = await bind(challengeId)
        const instance = capability.instance
        if (!instance) throw new Error("Missing offline fixture instance")
        capability.instance = {
          status: () => instance.status(),
          start: async (signal) => {
            leasedBox ??= await idleContainer()
            return instance.start(signal)
          },
          destroy: async () => {
            if (leasedBox && (await instance.status())) await docker(["rm", "--force", leasedBox])
            await instance.destroy()
          },
        }
        return capability
      }
      return offline
    })
    const closeSession = vi.fn(async () => {
      throw new Error("offline session cleanup failure")
    })
    vi.spyOn(shellpoop, "createShellPoopSession").mockReturnValue({
      tools: [],
      close: closeSession,
    })
    const closeManager = vi.spyOn(CtfSubagentManager.prototype, "close")
    const stream = vi.fn(() => {
      throw new Error("Unexpected model call")
    })
    const project = await Project.open({
      root,
      config: {
        ...config(),
        platform: {
          plugin: "test",
          config: {
            challenges: [
              {
                id: "misc2",
                title: "Offline resource fixture",
                description: "Local file only",
                category: "misc",
                score: 0,
                attachments: [],
                flag: "",
                remote: true,
              },
            ],
          },
        },
      },
      platforms: [platform],
      shellpoopConfig: async (_signal, context) => ({
        baseUrl: "http://unused.invalid",
        challengeId: context.challengeId,
      }),
      sandboxFactory: (options) =>
        DockerSandbox.create(options, (args, opts) =>
          executeDockerCommand(
            args[0] === "create"
              ? [
                  "create",
                  "--pull=never",
                  "--label",
                  label(),
                  ...fixedSampleMounts(options.workspace, "misc2"),
                  ...args.slice(1),
                ]
              : args,
            { timeoutMs: 30_000, ...opts },
          ),
        ),
    })
    let runId: string
    let box: string
    try {
      const solver = await project.createSolver("misc2", {
        agent: {
          initialState: { model: createFauxCore({ provider: "offline-cleanup" }).getModel() },
          streamFn: stream,
        },
      })
      runId = solver.runId
      // The offline lease emits a readiness message. Observe it at delivery
      // without waking an idle model during a cleanup-only test.
      const notification = vi.spyOn(solver, "promptOrSteer").mockResolvedValue(undefined)
      const running = await ids(false)
      expect(running).toHaveLength(1)
      box = running[0]!
      expect(
        await docker([
          "inspect",
          "--format",
          "{{.HostConfig.Init}} {{.HostConfig.NetworkMode}} {{.HostConfig.Privileged}}",
          box,
        ]),
      ).toBe("true none false")
      expect(await docker(["exec", box, "cat", "/proc/1/comm"])).toMatch(/^(docker-init|tini)$/)
      expect(await docker(["exec", box, "python3", "-c", orphanProbe])).toBe("1 reaped")
      expect(
        (await docker(["exec", box, "sha256sum", "/workspace/sample.bin"])).split(/\s+/)[0],
      ).toBe(digest)
      const startLocalLease = solver.state.tools.find((t) => t.name === "ctf_instance_start")
      if (!startLocalLease) throw new Error("Missing fixture instance lifecycle")
      await startLocalLease.execute("offline-lease", {})
      expect(notification).toHaveBeenCalledWith(expect.stringContaining("远程环境已就绪"))
      expect(platform.diagnostics().activeEnvironments).toBe(1)
      expect(leasedBox).toMatch(/^[0-9a-f]{64}$/)
      const activeContainers = await ids(false)
      expect(activeContainers).toHaveLength(2)
      expect(activeContainers).toEqual(expect.arrayContaining([box, leasedBox]))
      if (fixedReadsRequested) {
        await startFixedReads(box, workspace, "close")
        const initial = await inspectFixedReads(image, workspace, label())
        expect(initial.sessions.map((s) => s.held)).toEqual([true, true])
        expect(new Set(initial.sessions.map((s) => s.pid)).size).toBe(2)
        fixedReads.push(initial)
        savedReads.push(await saveFixedRead(project, runId, initial.sessions[0]!))
      }
      await expect(solver.close("failed", "original Run failure")).rejects.toBeInstanceOf(
        AggregateError,
      )
      expect(closeSession).toHaveBeenCalledOnce()
      expect(closeManager).toHaveBeenCalledOnce()
      expect(platform.diagnostics()).toMatchObject({
        instanceDestroys: 1,
        activeEnvironments: 0,
        submissions: {},
      })
      expect(stream.mock.calls.length).toBe(0)
      expect(await ids()).toEqual([])
      if (fixedReadsRequested) {
        const after = await inspectFixedReads(image, workspace, label(), true)
        expect(after.sessions).toEqual(
          fixedReads[0]!.sessions.map((s) => ({
            ...s,
            held: false,
            pending: false,
            state: "interrupted",
            exitCode: null,
          })),
        )
        fixedReads.push(after)
        savedReads.push(await saveFixedRead(project, runId, after.sessions[1]!))
      }
      expect(project.runs()[0]).toMatchObject({
        id: runId,
        status: "failed",
        error: "original Run failure",
        cleanupError: expect.stringContaining("offline session cleanup failure"),
      })
    } finally {
      await project.close()
    }
    expect(await managedForRun(runId)).toEqual([])
    const recovered = await reopen()
    try {
      expect(recovered.diagnostics().filter((d) => d.code === "sandbox")).toEqual([])
      for (const read of savedReads) {
        expect(await recovered.evidence.experiment(runId, read.experimentId)).toMatchObject({
          status: read.status,
          exitCode: read.exitCode,
          stdoutRef: read.stdoutRef,
          stderrRef: read.stderrRef,
        })
      }
      expect(recovered.runs()[0]).toMatchObject({
        id: runId,
        status: "failed",
        error: "original Run failure",
        cleanupError: expect.stringContaining("offline session cleanup failure"),
      })
      expect(await ids()).toEqual([])
    } finally {
      await recovered.close()
    }
    expect(await pending()).toEqual([])
    console.info(
      "cleanup-live T38",
      JSON.stringify({
        projectId,
        image,
        box,
        leasedBox,
        sampleSha256: digest,
        pid1Reaped: true,
        sessionFailurePreserved: true,
        managerClosed: true,
        offlineLeasesReleased: 1,
        containersAfterClose: 0,
        modelCalls: stream.mock.calls.length,
        ...(fixedReadsRequested && { fixedReads, savedReads }),
      }),
    )
  }, 90_000)
})
