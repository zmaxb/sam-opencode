import type { Shell } from "@opencode/schema/shell"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { ShellAttribution, ShellCapturePage, ShellObservation, ShellRelease, ShellReports } from "../shell-background.js"
import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
}

export interface ShellDomain {
  readonly background?: {
    readonly contract: "sam.opencode-background-engine/v1"
    readonly directory: string
    readonly read: (id: Shell.ID) => Promise<ShellObservation>
    readonly output: (id: Shell.ID, input: Shell.OutputInput) => Promise<ShellCapturePage>
    readonly reports: (sessionID: Session.ID, id?: SessionMessage.ID) => Promise<ShellReports>
    readonly release: (grant: ShellRelease) => Promise<void>
    readonly stop: (grant: ShellAttribution) => Promise<Shell.Info>
  }
  readonly hook: Hooks<ShellHooks>
}
