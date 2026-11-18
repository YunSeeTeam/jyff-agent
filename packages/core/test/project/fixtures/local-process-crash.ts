import { createFauxCore } from "@earendil-works/pi-ai/providers/faux"
import { defaultRunSettings, mergeRunSettings } from "../../../src/contracts/run-settings.ts"
import { Project } from "../../../src/project/project.ts"
import { TestPlatformPlugin } from "../../fake-platform.ts"

const [root, projectId, image] = process.argv.slice(2)
if (!root || !projectId || !image) throw new Error("Missing crash fixture arguments")
const faux = createFauxCore({ provider: "local-process-crash" })
const project = await Project.open({
  root,
  config: {
    version: 1,
    project: { id: projectId, name: "Managed process crash" },
    platform: {
      plugin: "test",
      config: {
        challenges: [
          {
            id: "offline",
            title: "Offline",
            category: "misc",
            score: 0,
            description: "Crash fixture",
            attachments: [],
            flag: "",
          },
        ],
      },
    },
    sandbox: { image, networkMode: "none", privileged: false },
  },
  platforms: [new TestPlatformPlugin()],
  runSettings: () =>
    mergeRunSettings(defaultRunSettings(), {
      optimization: { localProcesses: true },
    }),
})
const solver = await project.createSolver("offline", {
  agent: {
    initialState: { model: faux.getModel() },
    streamFn: () => {
      throw new Error("No model request expected")
    },
  },
})
const start = solver.tools.find((tool) => tool.name === "process_start")!
const poll = solver.tools.find((tool) => tool.name === "process_poll")!
const opened = await start.execute("crash", {
  requestKey: "crash",
  command: "printf 'crash-prefix'; sleep 60",
  yieldMs: 1000,
})
const sessionId = (opened.details as { sessionId: string }).sessionId
for (let attempt = 0; attempt < 30; attempt++) {
  const result = await poll.execute("crash", { sessionId, waitMs: 500 })
  if ((result.details as { stdout: { byteLength: number } }).stdout.byteLength >= 12) break
}
process.stdout.write(JSON.stringify({ runId: solver.runId, sessionId }) + "\n", () => {
  // Simulate abrupt backend death: skip Solver, Project, and RunStore cleanup.
  process.exit(0)
})
