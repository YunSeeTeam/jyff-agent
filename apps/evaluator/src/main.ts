import { collectSample } from "./collect.ts"
import { loadEvaluationConfig } from "./config.ts"
import { defaultEvaluationDeps, runEvaluation } from "./run.ts"
import { projectStateDirectory } from "./sample-root.ts"
import { readResults, summarizeResults } from "./summarize.ts"

const USAGE = `用法:
  run --config <eval.json>
      按配置依次运行全部样本，写出 manifest.json 与 results.jsonl
  collect --root <样本数据根> --project <projectId> --challenge <challengeId> [--config <eval.json>]
      只读采集一个已有数据根；--config 仅用于读取 pricing
  summarize <results.jsonl>... [--seed <n>] [--resamples <n>]
      汇总一个或多个结果文件（按 group 分组）`

function options(args: string[]): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = []
  const named = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少值`)
    named.set(arg, value)
    index += 1
  }
  return { positional, named }
}

function required(named: Map<string, string>, name: string): string {
  const value = named.get(name)
  if (!value) throw new Error(`缺少 ${name}\n\n${USAGE}`)
  return value
}

function integer(named: Map<string, string>, name: string): number | undefined {
  const value = named.get(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`)
  return parsed
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const { positional, named } = options(rest)
  if (command === "run") {
    const config = await loadEvaluationConfig(required(named, "--config"))
    const controller = new AbortController()
    let interrupts = 0
    process.on("SIGINT", () => {
      interrupts += 1
      if (interrupts > 1) process.exit(130)
      console.error("[eval] 收到中断：收尾当前样本后停止（再次 Ctrl+C 强制退出）")
      controller.abort()
    })
    const results = await runEvaluation(config, defaultEvaluationDeps(config), controller.signal)
    console.log(JSON.stringify(summarizeResults(results), null, 2))
    return
  }
  if (command === "collect") {
    const pricing = named.has("--config")
      ? (await loadEvaluationConfig(required(named, "--config"))).pricing
      : {}
    const stateDirectory = await projectStateDirectory(
      required(named, "--root"),
      required(named, "--project"),
    )
    console.log(
      JSON.stringify(
        await collectSample(stateDirectory, required(named, "--challenge"), pricing),
        null,
        2,
      ),
    )
    return
  }
  if (command === "summarize") {
    if (positional.length === 0) throw new Error(`缺少结果文件\n\n${USAGE}`)
    const results = (await Promise.all(positional.map(readResults))).flat()
    const seed = integer(named, "--seed")
    const resamples = integer(named, "--resamples")
    console.log(
      JSON.stringify(
        summarizeResults(results, {
          ...(seed === undefined ? {} : { seed }),
          ...(resamples === undefined ? {} : { resamples }),
        }),
        null,
        2,
      ),
    )
    return
  }
  console.error(USAGE)
  process.exitCode = command ? 1 : 0
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
