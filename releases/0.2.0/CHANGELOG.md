# 0.2.0

- Adds the opt-in `run-bound-steering/v1` native HTTP capability and typed client support. Text Steering can bind to the active ordinary root and return a durable admission receipt.
- Preserves upstream OpenCode 2.3.0, the four previous native patches, SAM Plugin 0.1.0 and `sam.opencode-wire/v3`.
- Uses the existing SQLite event journal and inbox. The release requires no SQL migration.
- The preview is for native qualification and SAM integration. Production activation requires separate SAM integration and approval.
