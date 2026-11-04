import type { ChallengeInfo } from "@ctf-agent/platform"
import { xml } from "./utils.ts"

export function challengeContextPrompt(
  challenge: ChallengeInfo,
  attachments: readonly {
    id: string
    name: string
    size: number
    path: string
  }[],
): string {
  const attachmentXml = attachments
    .map(
      (attachment) =>
        `    <attachment id="${xml(attachment.id)}" name="${xml(attachment.name)}" size="${attachment.size}" path="${xml(attachment.path)}" />`,
    )
    .join("\n")
  return [
    "<challenge_context>",
    `  <id>${xml(challenge.id)}</id>`,
    `  <title>${xml(challenge.title)}</title>`,
    `  <category>${xml(challenge.category)}</category>`,
    `  <needs_environment>${needsEnvironmentValue(challenge.needsEnv)}</needs_environment>`,
    `  <description>${xml(challenge.description)}</description>`,
    "  <attachments>",
    attachmentXml,
    "  </attachments>",
    "</challenge_context>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function needsEnvironmentValue(value: boolean | undefined): string {
  return value === undefined ? "unknown" : String(value)
}

export function challengeAnnouncementsPrompt(
  announcements: readonly {
    key: string
    title: string
    content: string
    publishedAt: string
    kind: string
  }[],
): string {
  return [
    "<challenge_announcements>",
    ...announcements.flatMap((announcement) => [
      `  <announcement key="${xml(announcement.key)}" published_at="${xml(announcement.publishedAt)}" kind="${xml(announcement.kind)}">`,
      `    <title>${xml(announcement.title)}</title>`,
      `    <content>${xml(announcement.content)}</content>`,
      "  </announcement>",
    ]),
    "</challenge_announcements>",
  ].join("\n")
}

/** A bounded SubAgent snapshot as JSON; callers pass a projection, never raw records. */
export function activeSubagentsPrompt(snapshot: unknown): string {
  const payload = JSON.stringify(snapshot)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
  return `<active_subagents encoding="json">\n${payload}\n</active_subagents>`
}

export function blackboardSnapshotPrompt(encodedSnapshot: string): string {
  return `<challenge_blackboard encoding="json">\n${encodedSnapshot}\n</challenge_blackboard>`
}

export function subagentCompletionNotificationPrompt(notification: {
  id: string
  role: string
  status: string
  output: string
  /** Set when `output` is the first page of a longer report. */
  resultVersion?: string
  totalLength?: number
  nextOffset?: number
}): string {
  const paging =
    notification.nextOffset === undefined
      ? []
      : [
          `  <result_version>${xml(notification.resultVersion ?? "")}</result_version>`,
          `  <total_length>${notification.totalLength ?? ""}</total_length>`,
          `  <next_offset>${notification.nextOffset}</next_offset>`,
          "  <continue>Read the rest with get_subagent_result, passing offset=next_offset and expected_result_version=result_version.</continue>",
        ]
  return [
    "<subagent_notification>",
    `  <id>${xml(notification.id)}</id>`,
    `  <role>${xml(notification.role)}</role>`,
    `  <status>${xml(notification.status)}</status>`,
    `  <output>${xml(notification.output)}</output>`,
    ...paging,
    "</subagent_notification>",
  ].join("\n")
}
