// @vitest-environment jsdom
import { type RunSettings, defaultRunSettings } from "@ctf-agent/core/contracts"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { InformationSettings } from "../src/pages/settings/InformationSettings.tsx"

afterEach(cleanup)
function harness(initial = defaultRunSettings()) {
  const save = vi.fn<(settings: RunSettings) => void>()
  function Editor() {
    const [value, setValue] = useState(initial)
    return createElement(InformationSettings, {
      value,
      roles: [{ name: "explorer", displayName: "Explore" }],
      onChange: (next) => {
        save(structuredClone(next))
        setValue(next)
      },
    })
  }
  render(createElement(Editor))
  return save
}

describe("Information settings", () => {
  it("shows only the three available switches, disabled by default", () => {
    harness()
    const switches = screen.getAllByRole("switch")
    expect(switches).toHaveLength(3)
    expect(switches.every((item) => item.getAttribute("aria-checked") === "false")).toBe(true)
    expect(screen.queryByLabelText("主任务技能")).toBeNull()
    expect(screen.getByText("保存后仅对新任务生效；已开始的任务继续使用原配置。")).toBeTruthy()
  })

  it("keeps empty selections, deduplicates names and removes role overrides as a whole table update", () => {
    const save = harness()
    fireEvent.click(screen.getByRole("switch", { name: "固定本次任务的技能版本" }))
    fireEvent.change(screen.getByLabelText("主任务技能"), { target: { value: "selected" } })
    expect(save.mock.lastCall![0].skills.solver).toEqual([])
    fireEvent.change(screen.getByLabelText("主任务技能名称"), {
      target: { value: "reverse, crypto, reverse" },
    })
    expect(save.mock.lastCall![0].skills.solver).toEqual(["reverse", "crypto"])
    fireEvent.click(screen.getByRole("switch", { name: "Explore 独立选择技能" }))
    fireEvent.change(screen.getByLabelText("Explore 技能"), { target: { value: "selected" } })
    expect(save.mock.lastCall![0].skills.subagents.roles).toEqual({ explorer: [] })
    fireEvent.click(screen.getByRole("switch", { name: "Explore 独立选择技能" }))
    expect(save.mock.lastCall![0].skills.subagents.roles).toEqual({})
    expect(
      screen.getByRole("switch", { name: "固定本次任务的技能版本" }).getAttribute("disabled"),
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "重置技能选择" }))
    expect(save.mock.lastCall![0].skills).toEqual(defaultRunSettings().skills)
    fireEvent.click(screen.getByRole("switch", { name: "固定本次任务的技能版本" }))
    expect(save.mock.lastCall![0].optimization.skillSnapshots).toBe(false)
  })

  it("edits each information switch without enabling later-stage capabilities", () => {
    const save = harness()
    fireEvent.click(screen.getByRole("switch", { name: "共享证据读取" }))
    fireEvent.click(screen.getByRole("switch", { name: "保留完整子任务报告" }))
    expect(save.mock.lastCall![0].optimization).toMatchObject({
      blackboardReaderV2: true,
      fullSubagentReports: true,
      skillSnapshots: false,
      localProcesses: false,
      review: { enabled: false },
    })
    expect(save.mock.lastCall![0]).not.toHaveProperty("budgetPolicy")
  })
})
