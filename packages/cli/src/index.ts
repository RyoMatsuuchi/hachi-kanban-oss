// @hachi/cli 公開エントリポイント
export { buildProgram } from "./program.js";
export type { CliDeps, CliWriter } from "./deps.js";
export { registerFanoutCommand } from "./commands/fanout.js";
