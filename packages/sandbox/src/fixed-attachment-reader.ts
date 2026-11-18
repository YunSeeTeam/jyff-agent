import { createHash } from "node:crypto"
import type { Readable } from "node:stream"
import { spawnDockerProcess, type DockerSandbox } from "./docker-sandbox.ts"

const archives = [
  {
    name: "misc1",
    size: 174655,
    hash: "b4f338efcdd52d870708498d6c06bb3d5fe9755a5575a57e464d32037453ee05",
  },
  {
    name: "misc2",
    size: 892181,
    hash: "e4744f33f74a384df4f162898c8b045624bd98a37446079af045b81f42407e66",
  },
] as const

export type FixedArchive = (typeof archives)[number]["name"]
const width = 16384

/** Only the verified first two windows leave the attachment download. */
export function matchFixedAttachment(content: Uint8Array) {
  const archive = archives.find((item) => item.size === content.byteLength)
  if (!archive) return
  const bytes = Buffer.from(content)
  if (createHash("sha256").update(bytes).digest("hex") !== archive.hash) return
  return { sample: archive.name, prefix: Buffer.from(bytes.subarray(0, 2 * width)) }
}

type Attachment = NonNullable<ReturnType<typeof matchFixedAttachment>>

// Runs in the Run's container. The only inputs after the immutable prefix are
// the two selectors and EOF. The script never opens a file or evaluates input.
const reader = String.raw`import base64, hashlib, os, signal, sys
signal.alarm(300)
source = sys.stdin.buffer
data = source.read(32768)
pins = {
    "06e470be1e267af54747a4992c4cf7998b497e93e82040cedb3bf15a995d88d9": "misc1",
    "f678ccde87c7996f59c51db1a7c05843bf219ff8d279393993bb684052b5eb81": "misc2",
}
sample = pins.get(hashlib.sha256(data).hexdigest())
if not sample:
    sys.exit(2)
print(sample, os.getpid(), flush=True)
for turn in range(3):
    selector = source.read(1)
    if not selector:
        print("EOF", flush=True)
        sys.exit(0)
    if turn == 2 or selector != bytes([161 + turn]):
        sys.exit(2)
    window = data[turn * 16384:(turn + 1) * 16384]
    out = b"\x00\xff\xe4\xb8\xad" + window[:12288]
    out = out + b"\xe2" if turn == 0 else b"\x82\xac" + out
    err = b"\xfe\x00\xf0\x9f\x8c\x8d" + window[12288:]
    print(base64.b64encode(out + err).decode("ascii"), flush=True)`

async function* receiptLines(stdout: Readable) {
  let pending = ""
  let bytes = 0
  for await (const chunk of stdout) {
    bytes += chunk.length
    if (bytes > 45_000) throw new Error("Fixed reader exceeded its two-window response")
    pending += Buffer.from(chunk).toString("latin1")
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      yield line
    }
  }
}

/** An attached Docker client for this single, closed protocol. */
export class FixedAttachmentReader {
  private readonly child
  private readonly lines
  readonly exited: Promise<number | null>

  constructor(
    sandbox: DockerSandbox,
    private readonly attachment: Attachment,
  ) {
    this.child = spawnDockerProcess([
      "exec",
      "-i",
      sandbox.id,
      "python3",
      "-I",
      "-S",
      "-B",
      "-c",
      reader,
    ])
    this.lines = receiptLines(this.child.stdout)
    this.exited = new Promise((resolve) => {
      this.child.once("error", () => resolve(null))
      this.child.once("close", (code) => resolve(code))
    })
    // A closed pipe is also observed as a missing receipt.
    this.child.stdin.on("error", () => {})
    this.child.stderr.resume()
  }

  async ready() {
    this.child.stdin.write(this.attachment.prefix)
    const [sample, pid] = (await this.line()).split(" ")
    if (sample !== this.attachment.sample || !pid || !/^[1-9]\d{0,9}$/.test(pid))
      throw new Error("Fixed reader did not acknowledge its pinned input")
    return Number(pid)
  }

  async read(window: 1 | 2) {
    this.child.stdin.write(Buffer.from([window === 1 ? 0xa1 : 0xa2]))
    const output = Buffer.from(await this.line(), "base64")
    const prefix = this.attachment.prefix.subarray((window - 1) * width, window * width)
    const out = Buffer.concat([
      Buffer.from(window === 1 ? "00ffe4b8ad" : "82ac00ffe4b8ad", "hex"),
      prefix.subarray(0, 12288),
      Buffer.from(window === 1 ? "e2" : "", "hex"),
      Buffer.from("fe00f09f8c8d", "hex"),
      prefix.subarray(12288),
    ])
    if (!output.equals(out)) throw new Error("Fixed reader returned a different byte window")
    return output
  }

  async finish() {
    this.child.stdin.end()
    if ((await this.line()) !== "EOF" || (await this.bounded(this.exited)) !== 0)
      throw new Error("Fixed reader exit was not confirmed")
  }

  disconnect() {
    this.child.stdin.destroy()
    this.child.kill()
  }

  private async line() {
    const line = await this.bounded(this.lines.next())
    if (line.done) throw new Error("Fixed reader closed before its receipt")
    return line.value
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Fixed reader receipt timed out")), 10_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
