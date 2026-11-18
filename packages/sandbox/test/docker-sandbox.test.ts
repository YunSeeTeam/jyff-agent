import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  clearDockerWorkspace,
  type CommandResult,
  DEFAULT_DOCKER_SANDBOX_RESOURCES,
  type DockerCommandExecutor,
  executeDockerCommand,
  DockerSandbox,
  type DockerSandboxOptions,
  dockerSandboxCreateArguments,
  removeManagedContainers,
  spawnDockerProcess,
} from "@ctf-agent/sandbox"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
if (!originalPlatform) throw new Error("process.platform descriptor is unavailable")

const options: DockerSandboxOptions = {
  projectId: "project",
  runId: "run",
  image: "solver:latest",
  workspace: "/host/workspace",
  privileged: false,
  networkMode: "bridge",
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

function result(code: number, output: { stdout?: string; stderr?: string } = {}): CommandResult {
  return {
    code,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
  }
}

beforeEach(() => {
  vi.stubEnv("CTF_AGENT_DOCKER_MODE", undefined)
})

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform)
  spawnMock.mockReset()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("Docker command execution", () => {
  it.each([undefined, "wsl"])(
    "uses WSL Docker and converts bind source paths (mode=%s)",
    async (mode) => {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
      vi.stubEnv("CTF_AGENT_DOCKER_MODE", mode)
      spawnMock.mockImplementationOnce(successfulChildProcess)

      await expect(
        executeDockerCommand([
          "run",
          "--rm",
          "--mount",
          String.raw`type=bind,src=C:\work\source,dst=/source,readonly`,
          "alpine",
          "true",
        ]),
      ).resolves.toMatchObject({ code: 0, stdout: "", stderr: "" })
      expect(spawnMock).toHaveBeenCalledWith(
        "wsl.exe",
        [
          "-e",
          "docker",
          "run",
          "--rm",
          "--mount",
          "type=bind,src=/mnt/c/work/source,dst=/source,readonly",
          "alpine",
          "true",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
    },
  )

  it("opts into native Windows Docker without converting mount paths or command text", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
    vi.stubEnv("CTF_AGENT_DOCKER_MODE", "native")
    spawnMock.mockImplementationOnce(successfulChildProcess)
    const args = [
      "run",
      "--rm",
      "--mount",
      String.raw`type=bind,src=C:\work\含 空格,dst=/source,readonly`,
      "alpine",
      "sh",
      "-c",
      String.raw`printf '%s\n' 'a\tb'`,
    ]

    await expect(executeDockerCommand(args)).resolves.toMatchObject({ code: 0 })
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    })
  })

  it("uses the same native mode for raw, interactive Docker processes", () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
    vi.stubEnv("CTF_AGENT_DOCKER_MODE", "native")
    spawnMock.mockImplementationOnce(successfulChildProcess)
    const args = ["exec", "-i", "container", "bash", "-lc", String.raw`cat; printf '\000' >&2`]

    const child = spawnDockerProcess(args)
    expect(child.stdin.writable).toBe(true)
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    })
  })

  it.each(["", "auto", "NATIVE"])(
    "rejects invalid Windows Docker mode %j before spawning",
    async (mode) => {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
      vi.stubEnv("CTF_AGENT_DOCKER_MODE", mode)

      await expect(executeDockerCommand(["version"])).rejects.toThrow(
        "CTF_AGENT_DOCKER_MODE must be 'native' or 'wsl'",
      )
      expect(() => spawnDockerProcess(["version"])).toThrow(
        "CTF_AGENT_DOCKER_MODE must be 'native' or 'wsl'",
      )
      expect(spawnMock).not.toHaveBeenCalled()
    },
  )

  it.each(["native", "wsl", "invalid"])(
    "keeps Linux Docker local regardless of the Windows-only mode %s",
    async (mode) => {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" })
      vi.stubEnv("CTF_AGENT_DOCKER_MODE", mode)
      spawnMock.mockImplementationOnce(successfulChildProcess)
      const args = ["run", "--mount", "type=bind,src=/srv/work space,dst=/source", "alpine", "true"]

      await executeDockerCommand(args)
      expect(spawnMock).toHaveBeenCalledExactlyOnceWith("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
      })
    },
  )

  it("passes container commands through WSL without rewriting backslashes", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" })
    spawnMock.mockImplementationOnce(successfulChildProcess)
    const script = String.raw`printf '%s\n' "a\tb" | grep -E '\d+' && python3 -c "print('x\ny')"`

    await executeDockerCommand(["exec", "-i", "container", "bash", "-lc", script])
    expect(spawnMock).toHaveBeenCalledWith(
      "wsl.exe",
      ["-e", "docker", "exec", "-i", "container", "bash", "-lc", script],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
  })
})

function successfulChildProcess(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams
  queueMicrotask(() => child.emit("close", 0, null))
  return child
}

describe("DockerSandbox resources", () => {
  it("默认限制每个 Solver 容器的 CPU、内存、swap、PID 与存储", () => {
    const args = dockerSandboxCreateArguments(options)
    expect(args).toContain("--init")

    expect(valueAfter(args, "--cpus")).toBe(String(DEFAULT_DOCKER_SANDBOX_RESOURCES.cpus))
    expect(valueAfter(args, "--memory")).toBe(String(DEFAULT_DOCKER_SANDBOX_RESOURCES.memoryBytes))
    expect(valueAfter(args, "--memory-swap")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.memorySwapBytes),
    )
    expect(valueAfter(args, "--pids-limit")).toBe(
      String(DEFAULT_DOCKER_SANDBOX_RESOURCES.pidsLimit),
    )
    expect(valueAfter(args, "--storage-opt")).toBe(
      `size=${DEFAULT_DOCKER_SANDBOX_RESOURCES.storageBytes}`,
    )
  })

  it("允许调用方收紧资源并拒绝小于内存的 swap 上限", () => {
    const args = dockerSandboxCreateArguments({
      ...options,
      resources: {
        cpus: 1.5,
        memoryBytes: 1024,
        memorySwapBytes: 2048,
        pidsLimit: 32,
        storageBytes: 4096,
      },
    })
    expect(valueAfter(args, "--cpus")).toBe("1.5")
    expect(valueAfter(args, "--memory")).toBe("1024")
    expect(valueAfter(args, "--memory-swap")).toBe("2048")
    expect(valueAfter(args, "--pids-limit")).toBe("32")
    expect(valueAfter(args, "--storage-opt")).toBe("size=4096")

    expect(() =>
      dockerSandboxCreateArguments({
        ...options,
        resources: { memoryBytes: 2048, memorySwapBytes: 1024 },
      }),
    ).toThrow("resources.memorySwapBytes must be >= resources.memoryBytes")
  })

  it("拒绝零值或负值的存储上限", () => {
    for (const storageBytes of [0, -1]) {
      expect(() =>
        dockerSandboxCreateArguments({
          ...options,
          resources: { storageBytes },
        }),
      ).toThrow("resources.storageBytes must be a positive safe integer")
    }
  })

  it("Docker 不支持可写层配额时只移除 storage-opt 并重试创建", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "--storage-opt is supported only for overlay over xfs with 'pquota' mount option",
        }),
      )
      .mockResolvedValueOnce(result(0, { stdout: "container-id\n" }))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    const sandbox = await DockerSandbox.create(options, execute)
    await sandbox.close()

    expect(execute).toHaveBeenCalledTimes(4)
    expect(execute.mock.calls[0]?.[0]).toContain("--storage-opt")
    expect(execute.mock.calls[1]?.[0]).not.toContain("--storage-opt")
    expect(execute.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--cpus", "2", "--mount"]))
    expect(execute.mock.calls[2]?.[0]).toEqual(["start", "container-id"])
    expect(execute.mock.calls[3]?.[0]).toEqual(["rm", "-f", "container-id"])
    expect(warning).toHaveBeenCalledOnce()
  })

  it("普通 Docker 创建错误不移除资源限制或重试", async () => {
    const execute = vi
      .fn<DockerCommandExecutor>()
      .mockResolvedValueOnce(result(125, { stderr: "permission denied" }))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(DockerSandbox.create(options, execute)).rejects.toThrow(
      "Docker create failed: permission denied",
    )

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toContain("--storage-opt")
    expect(warning).not.toHaveBeenCalled()
  })

  it("无配额重试仍失败时保留第二次 Docker 错误", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "storage-opt size is not supported for this graph driver",
        }),
      )
      .mockResolvedValueOnce(result(125, { stderr: "image not found" }))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(DockerSandbox.create(options, execute)).rejects.toThrow(
      "Docker create failed: image not found",
    )

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[0]).not.toContain("--storage-opt")
  })

  it("旧版 Docker 不支持 volume-subpath 时以兼容工作目录重试", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(
        result(125, {
          stderr: "unexpected key 'volume-subpath' in 'volume-subpath=father/sessions/a/workspace'",
        }),
      )
      .mockResolvedValueOnce(result(0, { stdout: "container-id\n" }))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})

    const sandbox = await DockerSandbox.create(
      {
        ...options,
        workspaceMount: {
          type: "volume",
          source: "ctf-agent-data",
          subpath: "father/sessions/a/workspace",
        },
      },
      execute,
    )
    await sandbox.close()

    const retry = execute.mock.calls[1]?.[0] ?? []
    expect(valueAfter(retry, "--mount")).toBe(
      "type=volume,src=ctf-agent-data,dst=/ctf-agent-volume",
    )
    expect(retry).toEqual(
      expect.arrayContaining([
        "sh",
        "-c",
        "mkdir -p /ctf-agent-volume/father/sessions/a/workspace && rm -rf /workspace && ln -s /ctf-agent-volume/father/sessions/a/workspace /workspace && exec sleep infinity",
      ]),
    )
    expect(warning).toHaveBeenCalledOnce()
  })

  it("clearDockerWorkspace 通过一次性容器清空卷 subpath", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute.mockResolvedValue(result(0))
    await clearDockerWorkspace(
      {
        image: "solver:latest",
        workspaceMount: {
          type: "volume",
          source: "ctf-agent-data",
          subpath: "projects/abc/challenges/def/workspace",
        },
      },
      execute,
    )
    expect(execute).toHaveBeenCalledWith([
      "run",
      "--rm",
      "--mount",
      "type=volume,src=ctf-agent-data,dst=/ctf-agent-volume",
      "--entrypoint",
      "sh",
      "solver:latest",
      "-c",
      'mkdir -p "$1" && find "$1" -mindepth 1 -delete',
      "sh",
      "/ctf-agent-volume/projects/abc/challenges/def/workspace",
    ])
  })

  it("clearDockerWorkspace 清理失败时抛错", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute.mockResolvedValue(result(1, { stderr: "permission denied" }))
    await expect(
      clearDockerWorkspace(
        {
          image: "solver:latest",
          workspaceMount: { type: "bind", source: "/host/workspace" },
        },
        execute,
      ),
    ).rejects.toThrow("Docker workspace cleanup failed: permission denied")
  })

  it("removeManagedContainers 按 run 标签找到并删除容器，找不到时跳过", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute
      .mockResolvedValueOnce(result(0, { stdout: "abc123\n" }))
      .mockResolvedValueOnce(result(0, { stdout: "" }))
      .mockResolvedValueOnce(result(0))
    await removeManagedContainers(["run-a", "run-b"], execute, "project")
    expect(execute.mock.calls.map(([args]) => args)).toEqual([
      [
        "ps",
        "-aq",
        "--filter",
        "label=ctf-agent.managed=true",
        "--filter",
        "label=ctf-agent.run=run-a",
        "--filter",
        "label=ctf-agent.project=project",
      ],
      [
        "ps",
        "-aq",
        "--filter",
        "label=ctf-agent.managed=true",
        "--filter",
        "label=ctf-agent.run=run-b",
        "--filter",
        "label=ctf-agent.project=project",
      ],
      ["rm", "-f", "abc123"],
    ])
  })

  it("removeManagedContainers 无容器时不调用 docker rm", async () => {
    const execute = vi.fn<DockerCommandExecutor>()
    execute.mockResolvedValue(result(0, { stdout: "" }))
    await removeManagedContainers(["run-a"], execute)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
