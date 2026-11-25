import type { Shell } from "@opencode/schema/shell"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { ShellAttribution, ShellCapturePage, ShellObservation, ShellRelease, ShellReports } from "../shell-background.js"
import type { Effect } from "effect"
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
    readonly read: (id: Shell.ID) => Effect.Effect<ShellObservation, unknown>
    readonly output: (id: Shell.ID, input: Shell.OutputInput) => Effect.Effect<ShellCapturePage, unknown>
    readonly reports: (sessionID: Session.ID, id?: SessionMessage.ID) => Effect.Effect<ShellReports, unknown>
    readonly release: (grant: ShellRelease) => Effect.Effect<void, unknown>
    readonly stop: (grant: ShellAttribution) => Effect.Effect<Shell.Info, unknown>
  }
  readonly hook: Hooks<ShellHooks>
}
