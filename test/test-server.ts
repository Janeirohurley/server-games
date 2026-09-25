import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";

/**
 * One Colyseus server for the whole run.
 *
 * `boot()` binds a port and installs process-wide matchmaker state, so
 * booting it once per spec file breaks every suite after the first. The
 * files share this instance instead and let the root hook below shut it
 * down when mocha is done.
 *
 * Loaded via `mocha --require`, which is what registers `mochaHooks`.
 */

export type TestServer = ColyseusTestServer<typeof appConfig>;

let server: TestServer | undefined;

export async function getTestServer(): Promise<TestServer> {
  if (!server) server = await boot(appConfig);
  return server;
}

export const mochaHooks = {
  async afterAll() {
    await server?.shutdown();
    server = undefined;
  },
};
