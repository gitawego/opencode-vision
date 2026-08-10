/**
 * opencode-vision — package entry.
 *
 * Re-exports the server plugin (the root/default entry). The loader resolves
 * the dedicated `./server` and `./tui` subpath exports when the package is
 * installed as a plugin.
 */
export { default } from "./server/index";
