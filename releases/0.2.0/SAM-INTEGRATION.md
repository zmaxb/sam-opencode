# SAM integration handoff

## Native contract

A supported server answers `GET /api/session/{sessionID}/steering` with `capability: "run-bound-steering/v1"` and, for an active ordinary root, `execution: { rootMessageID, ownerToken }`. Treat an unavailable endpoint or an unrecognized capability as unsupported. A supported idle Session has no active execution. Retain the exact pair with its Session ID. Verify that the root Message ID equals the native input ID accepted for the active SAM Run before advertising write eligibility.

Submit `POST /api/session/{sessionID}/prompt` with the deterministic native message ID for the Steering operation, `text`, `delivery: "steer"` and `expectedExecution: { rootMessageID, ownerToken }`. The native inbox checks the identity when admitting the input. A success confirms admission. HTTP 409 confirms this submission conflicted. A transport failure after submission leaves an unknown outcome.

Read `GET /api/session/{sessionID}/steering?messageID={id}` for exact recovery. Accept a receipt only if its `sessionID`, `messageID`, both fields of `execution` and its lowercase SHA-256 digest of UTF-8 text agree with the original submission. A missing receipt after an ambiguous transport failure leaves the outcome unknown. Exact retries use the original ID, text and owner. The receipt proves admission. Provider consumption is separate. Session deletion removes the receipt.

## Production SAM Plugin

Keep the existing ordinary prompt guard and its root lifecycle. Add a bound prompt branch that validates the current Agent Run authority, Session, root input ID and Steering message identity, then allows native admission without replacing the active Run or registering the Steering message as the root. Use the current authority and fencing rules for an optional Steering capability and any new Plugin method. Keep the Processor path independent. Verify compatibility with legacy Wire v3 peers and discard client-provided internal receipt metadata.

## OpenCode Adapter

Implement the existing native Steering interface for eligible OpenCode Agent Runs. Detect the opted-in Plugin and the native capability, correlate the active root with the adapter's accepted input, and supply the native execution binding expected by the coordinator. The current coordinator gates eligibility on a live `NativeThreadId` and `NativeTurnId`. Establish the OpenCode equivalent from its accepted Session and root, and retain the original owner token and Steering message ID for exact recovery. Report accepted, rejected or unknown through the existing Steering coordinator so Queue promotion retains its current removal and retry rules. Keep unsupported targets, children and non-text inputs ineligible. Reuse Shared Chat UI and the existing Steering workflow.

An additive capability under Wire v3 is the preferred integration, with a legacy peer default of unsupported. The current public SAM Steering types already express the required outcomes. Check whether the internal execution binding or operation evidence needs optional fields for both native identity components. Keep Session ID and the two native execution fields distinct. Review any required persistence change during integration.
