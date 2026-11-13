import {
  type RunSettings,
  type SkillSelection,
  defaultRunSettings,
  usesDefaultSkillSelection,
} from "@ctf-agent/core/contracts"
import { useEffect, useId, useState } from "react"
import { Button, Input, Label, Switch } from "../../components/index.ts"

export function InformationSettings({
  value,
  roles,
  onChange,
  disabled = false,
}: {
  value: RunSettings
  roles: Array<{ name: string; displayName: string }>
  onChange: (settings: RunSettings) => void
  disabled?: boolean
}) {
  const optimization = value.optimization
  const customSkills = !usesDefaultSkillSelection(value.skills)
  const switches = [
    ["blackboardReaderV2", "共享证据读取", "让子任务按需读取本题的证据与观察。"],
    ["fullSubagentReports", "保留完整子任务报告", "保存完整报告，查看时逐页加载。"],
    [
      "skillSnapshots",
      "固定本次任务的技能版本",
      "主任务与子任务沿用同一份技能文件，可分别选择需要的技能。",
    ],
  ] as const
  const allRoles = [
    ...roles,
    ...Object.keys(value.skills.subagents.roles)
      .filter((name) => !roles.some((role) => role.name === name))
      .map((name) => ({ name, displayName: name })),
  ]
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        保存后仅对新任务生效；已开始的任务继续使用原配置。
      </p>
      {switches.map(([key, label, description]) => (
        <div key={key} className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Switch
            aria-label={label}
            checked={optimization[key]}
            disabled={disabled || (key === "skillSnapshots" && customSkills)}
            onCheckedChange={(checked) =>
              onChange({ ...value, optimization: { ...optimization, [key]: checked } })
            }
          />
        </div>
      ))}
      {optimization.skillSnapshots ? (
        <div className="space-y-4 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            填写已安装的技能名称，以逗号分隔。选择“指定技能”并留空表示不加载技能。
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <SkillChoice
              label="主任务技能"
              value={value.skills.solver}
              disabled={disabled}
              onChange={(solver) => onChange({ ...value, skills: { ...value.skills, solver } })}
            />
            <SkillChoice
              label="子任务默认技能"
              value={value.skills.subagents.default}
              disabled={disabled}
              onChange={(selection) =>
                onChange({
                  ...value,
                  skills: {
                    ...value.skills,
                    subagents: { ...value.skills.subagents, default: selection },
                  },
                })
              }
            />
          </div>
          {allRoles.map((role) => {
            const override = Object.hasOwn(value.skills.subagents.roles, role.name)
            const update = (selection: SkillSelection | undefined) => {
              const next = { ...value.skills.subagents.roles }
              if (selection === undefined) delete next[role.name]
              else next[role.name] = selection
              onChange({
                ...value,
                skills: { ...value.skills, subagents: { ...value.skills.subagents, roles: next } },
              })
            }
            return (
              <div key={role.name} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm">{role.displayName} · 独立选择技能</span>
                  <Switch
                    aria-label={`${role.displayName} 独立选择技能`}
                    checked={override}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      update(checked ? value.skills.subagents.default : undefined)
                    }
                  />
                </div>
                {override ? (
                  <SkillChoice
                    label={`${role.displayName} 技能`}
                    value={value.skills.subagents.roles[role.name]!}
                    disabled={disabled}
                    onChange={update}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">使用子任务默认选择。</p>
                )}
              </div>
            )
          })}
          {customSkills ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onChange({ ...value, skills: defaultRunSettings().skills })}
              >
                重置技能选择
              </Button>
              <span className="text-xs text-muted-foreground">
                恢复全部技能并取消角色覆盖后，可关闭技能版本固定。
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function parseNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，\n]/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ]
}
function SkillChoice({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: SkillSelection
  disabled: boolean
  onChange: (value: SkillSelection) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(value === "all" ? "" : value.join(", "))
  useEffect(() => {
    if (value !== "all" && JSON.stringify(parseNames(draft)) !== JSON.stringify(value))
      setDraft(value.join(", "))
  }, [value, draft])
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        value={value === "all" ? "all" : "selected"}
        disabled={disabled}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        onChange={(event) => onChange(event.target.value === "all" ? "all" : parseNames(draft))}
      >
        <option value="all">全部技能</option>
        <option value="selected">指定技能（可留空）</option>
      </select>
      {value !== "all" ? (
        <Input
          aria-label={`${label}名称`}
          value={draft}
          disabled={disabled}
          placeholder="以逗号分隔；留空表示不加载"
          onChange={(event) => {
            setDraft(event.target.value)
            onChange(parseNames(event.target.value))
          }}
        />
      ) : null}
    </div>
  )
}
