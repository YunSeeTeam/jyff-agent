import { type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { expect, it } from "vite-plus/test"
import {
  DeliveryUnknownError,
  DockerManagedProcess,
  ProcessStartError,
} from "../src/docker-managed-process.ts"

function fakeClient(onInput?: (line: string, client: EventEmitter) => void) {
  const client = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: () => boolean
  }
  client.stdin = new PassThrough()
  client.stdout = new PassThrough()
  client.stderr = new PassThrough()
  client.kill = () => {
    client.emit("close", null)
    return true
  }
  let input = ""
  client.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString()
    while (input.includes("\n")) {
      const end = input.indexOf("\n")
      const line = input.slice(0, end)
      input = input.slice(end + 1)
      onInput?.(line, client)
    }
  })
  return client
}

it("reports delivery_unknown when the write ACK is lost and does not resend", async () => {
  let writes = 0
  const client = fakeClient((line, child) => {
    expect(JSON.parse(line)).toMatchObject({ type: "write", data: "AAE=" })
    writes++
    queueMicrotask(() => child.emit("close", null))
  })
  const spawn = () => client as unknown as ChildProcessWithoutNullStreams
  const started = DockerManagedProcess.start(
    "container",
    "cat",
    "/workspace",
    "id",
    Date.now() + 5000,
    1024,
    spawn,
  )
  client.stdout.write('{"type":"started","pid":42}\n')
  const transport = await started
  await expect(transport.write(Buffer.from([0, 1]), false)).rejects.toBeInstanceOf(
    DeliveryUnknownError,
  )
  expect(writes).toBe(1)
})

it("distinguishes a confirmed supervisor start failure", async () => {
  const client = fakeClient()
  const spawn = () => client as unknown as ChildProcessWithoutNullStreams
  const started = DockerManagedProcess.start(
    "container",
    "echo",
    "/workspace/missing",
    "id",
    Date.now() + 5000,
    1024,
    spawn,
  )
  client.stdout.write('{"type":"start_error","message":"cwd missing"}\n')
  await expect(started).rejects.toBeInstanceOf(ProcessStartError)
})
