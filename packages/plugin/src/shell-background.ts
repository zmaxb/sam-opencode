import type { SessionMessage } from "@opencode/schema/session-message"
import type { Shell } from "@opencode/schema/shell"
import type { Job } from "@opencode/schema/job"
import type { SessionInbox } from "@opencode/schema/session-inbox"

export interface ShellAttribution {
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

export interface ShellRelease extends ShellAttribution {
  readonly notificationID: SessionMessage.ID
  readonly notificationDigest: string
}

export interface ShellObservation {
  readonly shell?: Shell.Info
  readonly origin?: Partial<ShellAttribution>
  readonly jobStatus?: Job.Status
  readonly jobSessionID?: string
  readonly conflict: boolean
}

export interface ShellCapturePage {
  readonly base64: string
  readonly cursor: number
  readonly size: number
  readonly complete: boolean
}

export interface ShellReports {
  readonly entries: readonly SessionInbox.Info[]
  readonly delivered?: SessionMessage.Info
}
