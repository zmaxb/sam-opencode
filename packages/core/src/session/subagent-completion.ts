export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import { createHash } from "node:crypto"
import type { Job } from "../job.js"
import type { SessionBackground } from "./background.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"

export const provenanceKey = "opencodeSubagentReport"
export const controlledKey = "opencodeSubagentReportControlled"
export const releaseContract = "sam.opencode-subagent-report-release/v1"

export function withoutProvenance(metadata: Readonly<Record<string, unknown>> | undefined) {
  if (!metadata || (!Object.hasOwn(metadata, provenanceKey) && !Object.hasOwn(metadata, controlledKey))) return metadata
  const result = { ...metadata }
  delete result[provenanceKey]
  delete result[controlledKey]
  return result
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export function controlsReports(metadata: SessionSchema.Metadata | undefined) {
  return object(metadata?.sam)?.subagentReportRelease === releaseContract
}

export function authorizesRelease(
  session: SessionSchema.Info,
  id: SessionMessage.ID,
  metadata: Readonly<Record<string, unknown>> | undefined,
) {
  const authority = object(session.metadata?.sam)
  const proof = object(metadata?.[provenanceKey])
  return controlsReports(session.metadata) && authority?.inputId === id &&
    typeof authority.operation === "string" && typeof authority.inputDigest === "string" &&
    proof?.parentSessionID === session.id && proof.notificationID === id && proof.sha256 === authority.inputDigest
}

export const NO_TEXT = "Subagent completed without a text response."

export type RunningBackgroundItem = SessionBackground.OutstandingItem

/** A Session handle narrow enough for both Session.Service and SessionExecution to deliver a report. */
export interface SyntheticSession<E = never> {
  readonly synthetic: (input: {
    readonly id?: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly text: string
    readonly description?: string
    readonly metadata?: SessionSchema.Metadata
    readonly delivery?: "steer" | "queue"
  }) => Effect.Effect<unknown, E>
}

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return (
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n\n") || NO_TEXT
  )
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim()

const STILL_RUNNING = "\n\nBackground work still running:\n"

export function formatBody(
  body: string,
  childSessionID: SessionSchema.ID,
  background?: ReadonlyArray<RunningBackgroundItem>,
): string {
  if (!background || background.length === 0) return body
  const lines = background.map((item) => {
    if (item.kind === "shell")
      return `- shell (${item.shellID}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${clean(item.command)}`
    if (item.kind === "image")
      return `- image (${item.model}${item.sessionID !== childSessionID ? `, in ${item.sessionID}` : ""}): ${item.path}`
    return `- subagent (${item.agent}, sessionID: ${item.childSessionID}): ${clean(item.description)}`
  })
  return `${body}${STILL_RUNNING}${lines.join("\n")}`
}

export const deliver = Effect.fnUntraced(function* <E>(
  sessions: SyntheticSession<E>,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
  },
  controlled = false,
) {
  if (input.status === "running") return
  const recovery = input.recovery
  const body =
    input.status === "completed"
      ? (input.output ?? NO_TEXT)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : (input.output ?? input.error ?? "Subagent cancelled")
  // The body is all a recovered outbox row keeps, so the still-running list is how a replay tells this period apart.
  // Only the model-facing tag says "running": the job and the message metadata keep the period's real status.
  const state = input.status === "completed" && body.includes(STILL_RUNNING) ? "running" : input.status
  const reportText = `<subagent sessionID="${recovery.childSessionID}" state="${state}" description="${recovery.description}">\n${body}\n</subagent>`
  const proof = input.notificationID && recovery.callID && state !== "running"
    ? {
        contract: "opencode.subagent-report-provenance/v1",
        jobID: recovery.childSessionID,
        notificationID: input.notificationID,
        parentSessionID: recovery.parentSessionID,
        childSessionID: recovery.childSessionID,
        callID: recovery.callID,
        agent: recovery.agent,
        description: recovery.description,
        status: input.status,
        sha256: createHash("sha256").update(reportText, "utf8").digest("hex"),
      }
    : undefined
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    description: recovery.description,
    text: reportText,
    ...(controlled ? { delivery: "queue" as const } : {}),
    metadata: {
      source: "subagent",
      childID: recovery.childSessionID,
      agent: recovery.agent,
      state: input.status,
      ...(proof ? { [provenanceKey]: proof } : {}),
      ...(controlled ? { [controlledKey]: true } : {}),
    },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
