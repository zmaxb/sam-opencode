import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

export default {
  id: "stage01-shell-fixture",
  async setup(ctx) {
    let blockedRequests = 0;
    const object = { type: "object" };
    await ctx.rpc.register({
      id: "stage01-shell-fixture",
      methods: { inspect: { input: object, output: object } },
      events: {},
    }, { inspect: async () => ({ blockedRequests }) });

    await ctx.session.hook("http.request", async ({ request }) => {
      const body = await request.clone().text();
      if (body.includes("<shell id=") && body.includes("guard.starts")) {
        blockedRequests++;
        throw new Error("Fixture guard blocked a model request containing a shell notification");
      }
    });

    await ctx.shell.hook("create.before", async ({ command, cwd }) => {
      if (!command.includes("startwindow.starts")) return;
      await writeFile(join(cwd, "startwindow.entered"), "");
      const gate = join(cwd, "startwindow.release");
      for (;;) {
        try {
          await access(gate);
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await pause(25);
        }
      }
    });
  },
};
