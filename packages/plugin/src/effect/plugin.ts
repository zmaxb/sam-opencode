import type { CredentialApi, ExperimentalApi, ExperimentalGenerateApi, PluginApi } from "@opencode/client/effect/api"
import type { Location } from "@opencode/schema/location"
import type { Effect, Scope } from "effect"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { ExperimentalArtifactDomain } from "./artifact.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { MCPDomain } from "./mcp.js"
import type { ModelDomain } from "./model.js"
import type { PermissionDomain } from "./permission.js"
import type { ProviderDomain } from "./provider.js"
import type { ReferenceDomain } from "./reference.js"
import type { RpcDomain } from "./rpc.js"
import type { SessionDomain } from "./session.js"
import type { ShellDomain } from "./shell.js"
import type { SkillDomain } from "./skill.js"
import type { StorageDomain } from "./storage.js"
import type { ToolDomain } from "./tool.js"
import type { VcsDomain } from "./vcs.js"
import type { WebSearchDomain } from "./websearch.js"
import type { WorktreeDomain } from "./worktree.js"

export interface CompletionInput {
  readonly target: {
    readonly providerId: string
    readonly modelId: string
    readonly endpoint: string
    readonly structuredOutput: boolean
    readonly reasoning: boolean
    readonly sharedAdmission: boolean
  }
  readonly variant?: string
  readonly messages: ReadonlyArray<{ readonly role: "system" | "developer" | "user" | "assistant"; readonly content: string }>
  readonly correlationId: string
  readonly temperature?: number
  readonly topP?: number
  readonly maxTokens?: number
  readonly reasoning?: string
  readonly responseFormat?: { readonly type: "text" | "json_object" | "json_schema"; readonly json_schema?: unknown }
}

export type CompletionOutcome =
  | { readonly state: "failed"; readonly failure: string }
  | { readonly state: "succeeded"; readonly result: {
      readonly provider: string
      readonly model: string
      readonly variant?: string
      readonly text: string
      readonly refusal: boolean
      readonly finishReason: string
      readonly usage?: {
        readonly promptTokens?: number
        readonly completionTokens?: number
        readonly totalTokens?: number
        readonly cachedPromptTokens?: number
        readonly reasoningCompletionTokens?: number
      }
    } }

export const CompletionContract = "opencode.stateless-completion/v1"

export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly credential: Pick<CredentialApi<unknown>, "activate">
  readonly event: EventDomain
  readonly experimental: {
    readonly terminal: Pick<ExperimentalApi<unknown>["persistentPty"], "read">
    /** Stateless generation with a model and a prompt: no session, history or tools. */
    readonly generate: ExperimentalGenerateApi<unknown> & {
      readonly completion?: {
        readonly contract: typeof CompletionContract
        readonly execute: (input: CompletionInput) => Effect.Effect<CompletionOutcome, never>
      }
    }
    readonly artifact: ExperimentalArtifactDomain
  }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  /** @deprecated Use `experimental.generate.text`. */
  readonly generate: Pick<ExperimentalGenerateApi<unknown>, "text">
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi<unknown>, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
