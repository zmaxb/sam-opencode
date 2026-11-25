import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export default {
  id: "opencode-bound-steering-fixture",
  async setup(ctx) {
    await ctx.session.hook("prompt", async (event) => {
      if (!event.metadata?.holdFixtureAdmission) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (event.expectedExecution?.rootMessageID !== session.metadata?.fixtureRoot)
        throw new Error("Fixture authority mismatch")
      const root = process.env.OPENCODE_STEERING_FIXTURE
      writeFileSync(join(root, "prompt-hook-checked"), JSON.stringify(event.expectedExecution))
      for (let attempt = 0; attempt < 400; attempt++) {
        if (existsSync(join(root, "prompt-hook-release"))) return
        await delay(25)
      }
      throw new Error("Fixture prompt hook timed out")
    })
  },
}
