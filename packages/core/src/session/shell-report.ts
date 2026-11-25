export * as ShellReport from "./shell-report.js"

import { createHash } from "node:crypto"
import type { Shell } from "@opencode/schema/shell"
import type { SessionSchema } from "./schema.js"

export const key = "opencodeShellReport"
export const contract = "sam.opencode-shell-report-control/v1"

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

export function controls(metadata: SessionSchema.Metadata | undefined) {
  return object(metadata?.samBackground)?.contract === contract
}

export function wasControlled(metadata: Readonly<Record<string, unknown>> | undefined) {
  return object(metadata?.[key])?.controlled === true
}

export function withoutProof(metadata: Readonly<Record<string, unknown>> | undefined) {
  if (!metadata || !Object.hasOwn(metadata, key)) return metadata
  const result = { ...metadata }
  delete result[key]
  return result
}

export function hold(
  metadata: Record<string, unknown>,
  sessionID: string,
  notificationID: string,
  text: string,
) {
  return {
    ...metadata,
    [key]: { ...object(metadata[key]), sessionID, notificationID, sha256: digest(text), held: true },
  }
}

export function terminal(info: Shell.Info | undefined) {
  if (!info || info.status === "running") return undefined
  return { status: info.status, exit: info.exit, signal: info.signal, completed: info.time.completed }
}

export const shellMarker = "opencodeControlledShell"

export function binding(metadata: SessionSchema.Metadata | undefined, input: {
  readonly command: string; readonly workdir?: string; readonly timeout?: number; readonly background?: boolean
}) {
  const run = object(metadata?.samBackground)
  if (typeof run?.inputId !== "string" || typeof run.operation !== "string") return undefined
  const directory = input.workdir === undefined ? "-" : digest(input.workdir)
  const argumentsDigest = digest([digest(input.command), directory, input.timeout ?? "-", input.background ?? "-"].join(":"))
  return { inputID: run.inputId, operation: run.operation, argumentsDigest }
}

export interface Attribution {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly callID: string
  readonly inputID: string
  readonly operation: string
  readonly argumentsDigest: string
  readonly shellID: string
  readonly jobID: string
  readonly commandDigest: string
}

export interface Release extends Attribution {
  readonly notificationID: string
  readonly notificationDigest: string
}

export function matchesOrigin(expected: Attribution, origin: unknown) {
  const value = object(origin)
  return value?.sessionID === expected.sessionID && value.assistantMessageID === expected.assistantMessageID &&
    value.callID === expected.callID && value.inputID === expected.inputID &&
    value.operation === expected.operation && value.argumentsDigest === expected.argumentsDigest
}

export function matchesRelease(grant: Release, id: string, metadata: Record<string, unknown> | undefined) {
  const report = object(metadata?.[key])
  const outcome = object(report?.terminal)
  return id === grant.notificationID && report?.held === true && report.sessionID === grant.sessionID &&
    report.notificationID === id && report.sha256 === grant.notificationDigest &&
    metadata?.shellID === grant.shellID && metadata.jobID === grant.jobID &&
    report.commandDigest === grant.commandDigest && matchesOrigin(grant, report.origin) &&
    outcome !== undefined && ["exited", "killed", "timeout"].includes(String(outcome.status)) &&
    typeof outcome.completed === "number" && (typeof outcome.exit === "number" || typeof outcome.signal === "string")
}
