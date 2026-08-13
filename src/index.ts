/**
 * opencode-vision — package entry (dual opencode v1 + v2).
 *
 * One default export satisfies BOTH loaders:
 *
 *   export default { id, server, setup }
 *
 *  - opencode v1 reads `server` (its PluginModule shape: { id, server }).
 *  - opencode v2's supervisor decodes the module's `default` against
 *    `{ id, setup }` (the promise-style union variant; excess keys such as
 *    `server` are ignored) and runs `setup(context)`.
 *
 * The v2 SDK package (@opencode-ai/plugin) ships the complete v1 surface
 * under the `@opencode-ai/plugin/v1` subpath, so the single installed
 * dependency serves both hosts.
 */
import serverModule from "./server/index";
import { setup } from "./v2";

const { id, server } = serverModule;

export { setup };
export { server };
export default { id, server, setup };
