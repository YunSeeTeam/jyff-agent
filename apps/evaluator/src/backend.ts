import { spawn } from "node:child_process"
import { open } from "node:fs/promises"
import type { BackendConfig } from "./config.ts"

export interface BackendExit {
  code: number | null
  signal: string | null
}

export interface BackendHandle {
  readonly baseUrl: string
  /** Settles when the process exits for any reason. */
  readonly exited: Promise<BackendExit>
  /** Ask the process to exit, force it after graceMs, and wait for exit. */
  stop(graceMs: number): Promise<BackendExit>
}

export interface BackendLauncher {
  start(input: { root: string; logFile: string }): Promise<BackendHandle>
}

/** Launch the backend under test as a child process with its own data root. */
export function processBackendLauncher(config: BackendConfig): BackendLauncher {
  return {
    async start({ root, logFile }) {
      const log = await open(logFile, "a")
      const [command, ...leading] = config.command
      if (!command) throw new Error("backend.command 不能为空")
      const child = spawn(
        command,
        [
          ...leading,
          "--root",
          root,
          "--host",
          config.host,
          "--port",
          String(config.port),
          ...config.extraArgs,
        ],
        { cwd: config.cwd, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
      )
      const exited = new Promise<BackendExit>((resolve) => {
        let settled = false
        const settle = (exit: BackendExit) => {
          if (settled) return
          settled = true
          resolve(exit)
        }
        child.once("exit", (code, signal) => settle({ code, signal }))
        child.once("error", () => settle({ code: null, signal: "spawn_error" }))
      }).finally(() => log.close())

      const connectHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host
      return {
        baseUrl: `http://${connectHost}:${config.port}`,
        exited,
        async stop(graceMs) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
          let timer: NodeJS.Timeout | undefined
          const forced = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              // On Windows SIGTERM already terminates; elsewhere this escalates.
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
              resolve()
            }, graceMs)
          })
          await Promise.race([exited, forced])
          clearTimeout(timer)
          return exited
        },
      }
    },
  }
}

export interface HealthState {
  controlPlanePhase: string | null
  authenticationEnabled: boolean
  authenticated: boolean
}

export type ApiResult = { ok: true } | { ok: false; status: number; code: string; message: string }

export interface BackendApi {
  /** undefined while the server is not reachable yet. */
  health(): Promise<HealthState | undefined>
  login(username: string, password: string): Promise<ApiResult>
  dispatch(projectId: string, challengeId: string): Promise<ApiResult>
  cancel(projectId: string, challengeId: string): Promise<ApiResult>
}

const REQUEST_TIMEOUT_MS = 30_000

export function httpBackendApi(baseUrl: string): BackendApi {
  let cookie: string | undefined

  async function call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    let response: Response
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: "network_error",
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const setCookie = response.headers.get("set-cookie")
    const session = setCookie?.match(/ctf_agent_session=[^;]*/)?.[0]
    if (session) cookie = session
    if (response.ok) {
      await response.body?.cancel()
      return { ok: true }
    }
    const text = await response.text()
    let parsed: { error?: unknown; message?: unknown } = {}
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      // non-JSON error body
    }
    return {
      ok: false,
      status: response.status,
      code: typeof parsed.error === "string" ? parsed.error : `http_${response.status}`,
      message: typeof parsed.message === "string" ? parsed.message : text.slice(0, 500),
    }
  }

  const scoped = (projectId: string, challengeId: string, action: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/challenges/${encodeURIComponent(challengeId)}/${action}`

  return {
    async health() {
      try {
        const response = await fetch(new URL("/health", baseUrl), {
          headers: cookie ? { Cookie: cookie } : {},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) return undefined
        const body = (await response.json()) as {
          status?: unknown
          controlPlane?: { phase?: unknown } | null
          authentication?: { enabled?: unknown; authenticated?: unknown }
        }
        if (body.status !== "ok") return undefined
        return {
          controlPlanePhase:
            typeof body.controlPlane?.phase === "string" ? body.controlPlane.phase : null,
          authenticationEnabled: body.authentication?.enabled === true,
          authenticated: body.authentication?.authenticated === true,
        }
      } catch {
        return undefined
      }
    },
    login: (username, password) => call("POST", "/api/auth/login", { username, password }),
    // Never force: a platform that already reports the challenge solved means
    // the sample is not isolated and must be rejected, not re-solved.
    dispatch: (projectId, challengeId) =>
      call("POST", scoped(projectId, challengeId, "dispatch"), {}),
    cancel: (projectId, challengeId) => call("POST", scoped(projectId, challengeId, "cancel"), {}),
  }
}
