import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux"
import { fixedReaderProject, fixedTool } from "./fixed-reader-project.ts"

const [root, projectId, image] = process.argv.slice(2)
if (!root || !projectId || !image) throw new Error("Missing fixture settings")
const project = await fixedReaderProject(root, projectId, image)
const model = createFauxCore({ provider: "offline-fixed-reads" }).getModel()
const receipts = []
for (const sample of ["misc1", "misc2"] as const) {
  const solver = await project.createSolver(sample, {
    agent: {
      initialState: { model },
      streamFn: () => {
        throw new Error("Unexpected model request")
      },
    },
  })
  const tool = fixedTool(solver)
  const { sessionId } = await tool("open")
  const first = await tool("first", sessionId)
  const last = sample === "misc1" ? await tool("finish", sessionId) : first
  receipts.push({ first, last })
}
await writeFile(join(root, "fixed-owner.json"), JSON.stringify(receipts), {
  flag: "wx",
  flush: true,
})
process.kill(process.pid, "SIGKILL")
