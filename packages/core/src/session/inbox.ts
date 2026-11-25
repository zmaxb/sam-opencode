export * as SessionInbox from "./inbox.js"

import { createHash } from "node:crypto"
import { Event } from "@opencode/schema/event"
import { and, asc, eq, not, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@opencode/schema/session-inbox"
import type { ActiveExecution, SteeringReceipt } from "@opencode/schema/session-inbox"
import { EventTable } from "../event/sql.js"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { SessionEvent } from "./event.js"
import { SessionBlob } from "./blob.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStored } from "./stored.js"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import { SessionHistory } from "./history.js"
import { ShellReport } from "./shell-report.js"
import { SubagentCompletion } from "./subagent-completion.js"

type DatabaseService = Database.Interface["db"]

export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input `promote` may consume: "steer" promotes steers only (a step
 * boundary mid-work), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
export type Promotable = "input" | "steer"

const decodeUser = Schema.decodeUnknownSync(UserPayload)
const decodeMediaUser = Schema.decodeUnknownSync(MediaUserPayload)
const decodeStoredUser = Schema.decodeUnknownSync(SessionStored.UserPayload)
const encodeStoredUser = Schema.encodeSync(SessionStored.UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
const inboxLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }

export const steeringKey = "opencodeBoundSteering"
export const textDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const steeringEventID = (id: SessionMessage.ID) => Event.ID.make("evt_bound_steering_" + textDigest(id))
const ownerPath = "$.metadata." + steeringKey + ".execution.ownerToken"
const bound = sql`(${SessionInboxTable.type} = 'user' and json_type(${SessionInboxTable.payload}, ${ownerPath}) is not null)`
const visible = (execution?: ActiveExecution) =>
  execution
    ? or(
        not(bound),
        sql`(json_extract(${SessionInboxTable.payload}, ${ownerPath}) = ${execution.ownerToken}
        and json_extract(${SessionInboxTable.payload}, ${"$.metadata." + steeringKey + ".execution.rootMessageID"}) = ${execution.rootMessageID})`,
      )
    : not(bound)

const retained = (db: DatabaseService, id: SessionMessage.ID) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.id, steeringEventID(id)))
    .get()
    .pipe(Effect.orDie)

export const steeringReceipt = Effect.fn("SessionInbox.steeringReceipt")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
) {
  const event = yield* retained(db, id)
  const type = Bus.versionedType(SessionEvent.InboxEnqueued.type, SessionEvent.InboxEnqueued.durable.version)
  if (event?.aggregate_id !== sessionID || (event.type !== type && event.type !== Bus.retainedType(type)))
    return undefined
  const { inboxID, item } = Schema.decodeUnknownSync(SessionEvent.InboxEnqueued.data)(event.data)
  if (inboxID !== id || item.type !== "user") return undefined
  const receipt = item.payload.metadata?.[steeringKey] as SteeringReceipt | undefined
  if (receipt?.sessionID !== sessionID || receipt.messageID !== id) return undefined
  return { receipt, item: User.make({ ...item, id, sessionID, time: { created: DateTime.makeUnsafe(event.created) } }) }
})

export const expireSteering = Effect.fn("SessionInbox.expireSteering")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID?: SessionSchema.ID,
  ownerToken?: string,
  active?: (id: SessionSchema.ID) => ActiveExecution | undefined,
) {
  const rows = yield* db
    .select({ id: SessionInboxTable.id, sessionID: SessionInboxTable.session_id })
    .from(SessionInboxTable)
    .where(
      and(
        bound,
        sessionID === undefined ? undefined : eq(SessionInboxTable.session_id, sessionID),
        ownerToken === undefined
          ? undefined
          : sql`json_extract(${SessionInboxTable.payload}, ${ownerPath}) = ${ownerToken}`,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) {
    const cancel = bus.publish(SessionEvent.InboxCancelled, { sessionID: row.sessionID, inboxID: row.id })
    if (!active) yield* cancel
    else
      yield* serialized(
        row.sessionID,
        Effect.gen(function* () {
          const current = yield* find(db, row.id)
          if (current?.type !== "user" || current.sessionID !== row.sessionID) return
          const receipt = current.payload.metadata?.[steeringKey] as SteeringReceipt | undefined
          if (receipt && receipt.execution.ownerToken !== active(row.sessionID)?.ownerToken) yield* cancel
        }),
      )
  }
})

const controlledSubagent = sql`(${SessionInboxTable.type} = 'synthetic' and coalesce(
  json_extract(${SessionInboxTable.payload}, ${"$.metadata." + SubagentCompletion.controlledKey}), 0) = 1)`
const shellProof = "$.metadata." + ShellReport.key
const controlledShell = sql`(${SessionInboxTable.type} = 'synthetic' and coalesce(
  json_extract(${SessionInboxTable.payload}, ${shellProof + ".held"}), 0) = 1)`
const controlledReport = or(controlledSubagent, controlledShell)
const ordinaryQueue = and(eq(SessionInboxTable.delivery, "queue"), not(controlledReport))
const eligibleSteer = and(eq(SessionInboxTable.delivery, "steer"), or(not(controlledSubagent), sql`exists (
  select 1 from ${SessionTable}
  where ${SessionTable.id} = ${SessionInboxTable.session_id}
    and json_extract(${SessionTable.metadata}, '$.sam.subagentReportRelease') = ${SubagentCompletion.releaseContract}
    and json_extract(${SessionTable.metadata}, '$.sam.inputDigest') =
      json_extract(${SessionInboxTable.payload}, ${"$.metadata." + SubagentCompletion.provenanceKey + ".sha256"})
    and json_extract(${SessionTable.metadata}, '$.sam.inputId') = ${SessionInboxTable.id}
    and json_type(${SessionTable.metadata}, '$.sam.operation') = 'text'
)`))

export const serialized = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  inboxLocks.withLock(sessionID)(effect)

export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

function matches<Type extends Item["type"]>(
  stored: Info,
  request: PendingRef & { readonly type: Type },
): stored is Extract<Info, { readonly type: Type }> {
  return stored.sessionID === request.sessionID && stored.type === request.type
}

const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  throw new LifecycleConflict({ id: base.id })
}

export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  if (row === undefined) return undefined
  const [hydrated] = yield* SessionBlob.hydrateInbox(db, [row])
  return hydrated && fromRow(hydrated)
})

const promotedFromMessage = Effect.fn("SessionInbox.promotedFromMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  if (!message) return undefined
  const base = { id, sessionID, time: { created: message.time.created }, delivery }
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: UserPayload.make({
        text: message.text,
        files: message.files,
        agents: message.agents,
        skills: message.skills,
        metadata: message.metadata,
      }),
    })
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: SyntheticPayload.make({
        text: message.text,
        description: message.description,
        metadata: message.metadata,
      }),
    })
})

export type Interface = Effect.Success<ReturnType<typeof make>>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInbox") {}

export const make = Effect.fn("SessionInbox.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const bus = yield* Bus.Service

  /** First admission wins for matching Session and type, without preparing a new payload. */
  const reconcile = Effect.fn("SessionInbox.reconcile")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    readonly delivery: Delivery
  }) {
    if (yield* retained(db, request.id)) return yield* new LifecycleConflict({ id: request.id })
    const existing =
      (yield* find(db, request.id)) ?? (yield* promotedFromMessage(db, request.sessionID, request.id, request.delivery))
    if (existing === undefined) return undefined
    if (existing.type === "compaction" || !matches(existing, request))
      return yield* new LifecycleConflict({ id: request.id })
    return existing
  })

  const admit = Effect.fn("SessionInbox.admit")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
    readonly bound?: boolean
  }) {
    const existing = yield* reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
    if (existing !== undefined) {
      if (request.bound) return yield* new LifecycleConflict({ id: request.id })
      return existing
    }
    const admitted = yield* bus
      .publish(
        SessionEvent.InboxEnqueued,
        {
          inboxID: request.id,
          sessionID: request.sessionID,
          item: request.item,
        },
        request.bound ? { id: steeringEventID(request.id), retain: true } : undefined,
      )
      .pipe(
        Effect.map((event) =>
          Info.make({
            id: request.id,
            sessionID: request.sessionID,
            time: { created: DateTime.makeUnsafe(event.created) },
            ...request.item,
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            if (request.bound && defect instanceof Bus.InvalidDurableEventError && (yield* retained(db, request.id)))
              return yield* new LifecycleConflict({ id: request.id })
            if (!(defect instanceof LifecycleConflict)) return yield* Effect.die(defect)
            if (request.bound) return yield* defect
            const stored = yield* find(db, request.id)
            return stored ?? (yield* defect)
          }),
        ),
      )
    if (!matches(admitted, { ...request, type: request.item.type }))
      return yield* new LifecycleConflict({ id: request.id })
    return admitted
  })

  const admitCompaction = Effect.fn("SessionInbox.admitCompaction")(function* (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const exact = yield* find(db, input.id)
        if (exact) {
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          return yield* new LifecycleConflict({ id: input.id })
        }
        if (yield* promotedFromMessage(db, input.sessionID, input.id, input.delivery))
          return yield* new LifecycleConflict({ id: input.id })
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return pending
        return yield* admit({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
      }),
    )
  })

  const cancel = Effect.fn("SessionInbox.cancel")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxCancelled, {
        sessionID: input.sessionID,
        inboxID: input.id,
      }),
    ),
  )

  const steer = Effect.fn("SessionInbox.steer")(function* (
    input: PendingRef,
    getSession?: Effect.Effect<SessionSchema.Info | undefined>,
    shellGrant?: ShellReport.Release,
  ) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const pending = yield* find(db, input.id)
        const item = pending ?? (yield* promotedFromMessage(db, input.sessionID, input.id, "steer"))
        const metadata = item?.type === "synthetic" ? item.payload.metadata : undefined
        const shell = metadata?.[ShellReport.key]
        const shellHeld = shell && typeof shell === "object" && "held" in shell && shell.held === true
        const subagentHeld = metadata?.[SubagentCompletion.controlledKey] === true
        if (item?.type === "user" && item.payload.metadata?.[steeringKey])
          return yield* new LifecycleConflict({ id: input.id })
        if (Boolean(shellHeld || subagentHeld) !== (getSession !== undefined))
          return yield* new LifecycleConflict({ id: input.id })
        if (getSession && item) {
          const session = yield* getSession
          const authorized =
            session &&
            (shellGrant
              ? shellHeld && ShellReport.matchesRelease(shellGrant, item.id, metadata)
              : subagentHeld && SubagentCompletion.authorizesRelease(session, item.id, metadata))
          if (item.sessionID !== input.sessionID || !session || session.revert || !authorized)
            return yield* new LifecycleConflict({ id: input.id })
          if (!pending) return false
          if (pending.delivery === "steer") return true
        }
        yield* bus.publish(SessionEvent.InboxDeliveryChanged, {
          sessionID: input.sessionID,
          inboxID: input.id,
          delivery: "steer",
        })
        return true
      }),
    ).pipe(
      Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
    )
  })

  const queue = Effect.fn("SessionInbox.queue")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "queue",
      }),
    ),
  )

  return {
    list: (sessionID: SessionSchema.ID) => list(db, sessionID),
    reconcile,
    admit,
    admitCompaction,
    cancel,
    steer,
    queue,
  }
})

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  if (yield* retained(db, request.id)) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const payload =
    request.item.type === "user"
      ? encodeStoredUser(yield* SessionBlob.externalizePayload(db, request.item.payload))
      : request.item.type === "synthetic"
        ? encodeSynthetic(request.item.payload)
        : request.item.type === "compaction"
          ? encodeCompaction(request.item.payload)
          : encodeMove(request.item.payload)
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload,
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: request.sessionID, messageID: request.id, seq: request.enqueuedSeq },
    payload,
  )
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID),
      or(not(controlledReport), eligibleSteer)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return delivered(deleted)
})

/** A consumed row with its payload as stored, so user file refs reach the message without their blobs. */
export type Delivered =
  | { readonly id: SessionMessage.ID; readonly type: "user"; readonly payload: SessionStored.UserPayload }
  | { readonly id: SessionMessage.ID; readonly type: "synthetic"; readonly payload: SyntheticPayload }
  | { readonly id: SessionMessage.ID; readonly type: "compaction" | "move" }

const delivered = (row: typeof SessionInboxTable.$inferSelect): Delivered => {
  if (row.type === "user") return { id: row.id, type: "user", payload: decodeStoredUser(row.payload) }
  if (row.type === "synthetic") return { id: row.id, type: "synthetic", payload: decodeSynthetic(row.payload) }
  return { id: row.id, type: row.type }
}

export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
        not(controlledReport),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  yield* SessionBlob.releaseMessage(db, input.sessionID, input.id)
})

const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
        visible(),
        input.to === "queue" ? not(controlledReport) : undefined,
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

const listRows = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)

export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* SessionBlob.hydrateInbox(db, yield* listRows(db, sessionID))).map(fromRow)
})

/** {@link list} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
export const listWithRefs = Effect.fn("SessionInbox.listWithRefs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const kept = yield* SessionBlob.keepInboxRefs(db, yield* listRows(db, sessionID))
  return kept.rows.map((row): MediaInfo => {
    if (row.type !== "user") return fromRow(row)
    const payload = decodeMediaUser(row.payload)
    return MediaUser.make({
      id: row.id,
      sessionID: row.session_id,
      time: { created: DateTime.makeUnsafe(row.time_created) },
      type: "user",
      payload: payload.files ? { ...payload, files: SessionBlob.describe(payload.files, kept.meta) } : payload,
      delivery: row.delivery,
    })
  })
})

export const moveIDs = Effect.fn("SessionInbox.moveIDs")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "move")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
})

export const nextPromotable = Effect.fn("SessionInbox.nextPromotable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotable: Promotable,
  execution?: ActiveExecution,
) {
  const steer = (yield* pendingSteers(db, sessionID, execution))[0]
  if (steer) return promotion(steer)
  if (promotable !== "input") return undefined
  const queued = yield* firstQueued(db, sessionID)
  return queued ? promotion(queued) : undefined
})

/** What a boundary decides on: prompts are promoted by id, so only a move's payload is read. */
export type Promotion =
  | { readonly id: SessionMessage.ID; readonly type: "user" | "synthetic" | "compaction"; readonly delivery: Delivery }
  | {
      readonly id: SessionMessage.ID
      readonly type: "move"
      readonly delivery: Delivery
      readonly payload: MovePayload
    }

const promotion = (row: typeof SessionInboxTable.$inferSelect): Promotion =>
  row.type === "move"
    ? { id: row.id, type: "move", delivery: row.delivery, payload: decodeMove(row.payload) }
    : { id: row.id, type: row.type, delivery: row.delivery }

/** Which pending rows count: "input" means any item in either delivery mode. */
export type Scope = "input" | Delivery

export const has = Effect.fn("SessionInbox.has")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  scope: Scope,
  execution?: ActiveExecution,
) {
  const row = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        scope === "input"
          ? or(and(eligibleSteer, visible(execution)), ordinaryQueue)
          : scope === "queue"
            ? ordinaryQueue
            : and(eligibleSteer, visible(execution)),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

const publishMutation = <A, E, R>(input: PendingRef, effect: Effect.Effect<A, E, R>) =>
  serialized(input.sessionID, effect).pipe(
    Effect.asVoid,
    // Bus projectors abort their transaction through the defect channel.
    Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
  )

const publish = Effect.fn("SessionInbox.publish")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInboxTable.$inferSelect>,
) {
  yield* Effect.forEach(
    rows,
    (row) => {
      if (row.type !== "move" && row.type !== "user" && row.type !== "synthetic")
        return Effect.die(new LifecycleConflict({ id: row.id }))
      return bus
        .publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: row.id,
        })
        .pipe(
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? promotedFromMessage(db, sessionID, row.id, row.delivery).pipe(
                  Effect.flatMap((stored) => (stored !== undefined ? Effect.void : Effect.die(defect))),
                  Effect.orDie,
                )
              : Effect.die(defect),
          ),
        )
    },
    { discard: true },
  )
  return rows.length
})

/**
 * Promotes pending input into visible messages and returns the promoted count,
 * or undefined when the runner must first handle a pending control.
 * Steered compaction takes priority over pending prompts, without crossing a move.
 * Only the "input" scope may fall through to one queued input.
 */
export const promote = Effect.fn("SessionInbox.promote")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: Promotable,
  boundary?: { readonly owner: () => ActiveExecution | undefined; readonly root?: (id: SessionMessage.ID) => void },
) {
  return yield* serialized(
    sessionID,
    Effect.gen(function* () {
      const steers = yield* pendingSteers(db, sessionID, boundary?.owner())
      if (steers.length > 0 || scope === "steer") {
        if (steers.length > 0 && isControl(steers[0])) return undefined
        const rows = beforeControl(steers)
        const count = yield* publish(db, bus, sessionID, rows)
        if (rows.length === 1 && rows[0].type === "user") boundary?.root?.(rows[0].id)
        return count
      }

      const queued = yield* firstQueued(db, sessionID)
      if (!queued) return 0
      if (isControl(queued)) return undefined
      const promoted = yield* publish(db, bus, sessionID, [queued])
      const extra = yield* publish(db, bus, sessionID, beforeControl(yield* pendingSteers(db, sessionID)))
      if (!extra && queued.type === "user") boundary?.root?.(queued.id)
      return promoted + extra
    }),
  )
})

const isControl = (row: typeof SessionInboxTable.$inferSelect) => row.type === "compaction" || row.type === "move"

const beforeControl = (rows: Array<typeof SessionInboxTable.$inferSelect>) => {
  const control = rows.findIndex(isControl)
  return control === -1 ? rows : rows.slice(0, control)
}

const firstQueued = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), ordinaryQueue, visible()))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

const pendingSteers = (db: DatabaseService, sessionID: SessionSchema.ID, execution?: ActiveExecution) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eligibleSteer, visible(execution)))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        // A move changes the context's Location: never pull compaction across it.
        // Within that boundary, compact before promoting even earlier steers so
        // their text stays verbatim after the checkpoint, not inside its summary.
        const control = rows.findIndex(isControl)
        if (control > 0 && rows[control].type === "compaction") rows.unshift(...rows.splice(control, 1))
        return rows
      }),
    )
