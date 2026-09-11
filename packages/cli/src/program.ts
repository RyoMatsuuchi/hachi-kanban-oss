// =============================================================================
// buildProgram(deps): CliDeps を注入して commander の Command ツリーを構築する。
// main.ts は実環境用の deps を組み立てて buildProgram(deps).parseAsync(...) を呼ぶだけの薄いエントリにする。
// テストは buildProgram に temp home / :memory: store / ダミー adapter を注入して直接検証する。
// =============================================================================

import { Command } from "commander";
import type { CliDeps } from "./deps.js";
import { registerAdminCommand } from "./commands/admin.js";
import { registerBoardCommand } from "./commands/board.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerCommunicationCommand } from "./commands/communication.js";
import { registerFanoutCommand } from "./commands/fanout.js";
import { registerHumanDecisionCommand } from "./commands/human-decision.js";
import { registerKnowledgeCommand } from "./commands/knowledge.js";
import { registerMsgCommand } from "./commands/msg.js";
import { registerOrchestratorCommand } from "./commands/orchestrator.js";
import { registerResourceCommand } from "./commands/resource.js";
import { registerScheduleCommand } from "./commands/schedule.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerUsageCommand } from "./commands/usage.js";

/** CliDeps を注入して hachi コマンドツリーを組み立てる */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();

  program
    .name("hachi")
    .description("hachi-kanban 操作 CLI（board/task/usage/schedule/resource/msg/admin/doctor）")
    // commander 既定の process.exit() を抑止し CommanderError を throw させる（テスト容易性のため）
    .exitOverride()
    // commander 自身の出力（help/version/エラー）も deps 経由に流し込む
    .configureOutput({
      writeOut: (str: string): void => deps.stdout.write(str),
      writeErr: (str: string): void => deps.stderr.write(str),
    })
    // --board/--debug は task create のような二階層サブコマンドをまたぐグローバルフラグのため、
    // main.ts が argv を事前スキャンして処理する（commander のオプション階層には登録しない）。
    // help に出ないと発見しづらいため、ここで明示しておく。
    .addHelpText(
      "afterAll",
      [
        "",
        "グローバルオプション（どのサブコマンドの前後にも置ける）:",
        "  --board <name>   ボードを切り替える（既定は環境変数 HACHI_KANBAN_BOARD、さらにその既定は dev）",
        "  --debug          エラー発生時にスタックトレースも表示する",
      ].join("\n"),
    );

  registerBoardCommand(program, deps);
  registerTaskCommand(program, deps);
  registerUsageCommand(program, deps);
  registerScheduleCommand(program, deps);
  registerKnowledgeCommand(program, deps);
  registerMsgCommand(program, deps);
  registerOrchestratorCommand(program, deps);
  registerHumanDecisionCommand(program, deps);
  registerResourceCommand(program, deps);
  registerAdminCommand(program, deps);
  registerDoctorCommand(program, deps);
  registerCommunicationCommand(program, deps);
  registerFanoutCommand(program, deps);

  return program;
}
