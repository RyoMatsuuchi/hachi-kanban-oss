// stopProcess/cleanupProcessGroup/stopDirectSession の単体テスト（契約 §34.2 / §34.2.1 / §51.1）。
// 実プロセスの spawn/kill は行わず、生存判定・signal 送付・待機を fake DI で検証する。
// §34.2.1 の観測状態遷移表（docs/contract.md:1386-1404、全19行）を表駆動で網羅し、EPERM を
// 「停止」でも「生存」でもなく「観測も送信もできない」として扱う実装
// （2026-08-21〜25 の `Error: kill EPERM` flake の修正）を検証する。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StopResult } from "@hachi/core";
import {
  cleanupProcessGroup,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
  stopDirectSession,
  stopProcess,
  writeDirectSessionState,
  type ProcessGroupObservation,
  type SignalSendResult,
} from "./direct-process.js";

interface SignalCall {
  pid: number;
  signal: NodeJS.Signals;
}

/** ENOENT 等ではなく特定の errno code を持つ Node 風エラーを組み立てる。 */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("isProcessAlive / isProcessGroupAlive の tri-state → boolean 互換写像（契約 §34.2.1）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ESRCH（gone）のみ false を返す", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    expect(isProcessAlive(123)).toBe(false);
    expect(isProcessGroupAlive(123)).toBe(false);
  });

  it("signal 0 が成功（alive）すれば true を返す", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(isProcessAlive(123)).toBe(true);
    expect(isProcessGroupAlive(123)).toBe(true);
  });

  it("EPERM（unobservable）は false ではなく true に写す（false に写すと monitor が誤 cancel する、契約 §34.2.1）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(isProcessAlive(123)).toBe(true);
    expect(isProcessGroupAlive(123)).toBe(true);
  });

  it("未知の fatal エラーは unobservable に潰さず throw する（killProcessGroup と分類器を共有するため解釈を一致させる、契約 §34.2.1）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EIO");
    });
    expect(() => isProcessAlive(123)).toThrow();
    expect(() => isProcessGroupAlive(123)).toThrow();
  });
});

describe("killProcessGroup の signal 分類（契約 §34.2.1）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("送信成功は sent を返す", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(killProcessGroup(123, "SIGTERM")).toBe("sent");
  });

  it("ESRCH は gone を返す（throw しない）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    expect(killProcessGroup(123, "SIGTERM")).toBe("gone");
  });

  it("EPERM は unsignalable を返す（throw しない。旧実装は throw しており flake の原因だった）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(() => killProcessGroup(123, "SIGTERM")).not.toThrow();
    expect(killProcessGroup(123, "SIGTERM")).toBe("unsignalable");
  });

  it("fatal（ESRCH/EPERM 以外）は throw する", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EIO");
    });
    expect(() => killProcessGroup(123, "SIGTERM")).toThrow();
  });

  it("isProcessGroupAlive と EPERM の解釈が一致する（片方が生存、片方が throw、という状態を作らない）", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EPERM");
    });
    // isProcessGroupAlive は「生存扱い（true）」、killProcessGroup は「例外を投げない（unsignalable）」。
    // どちらも「止められない」を表しており、矛盾しない。
    expect(isProcessGroupAlive(123)).toBe(true);
    expect(killProcessGroup(123, "SIGTERM")).toBe("unsignalable");
  });
});

/** stopProcess/cleanupProcessGroup 共通の DI オプション。観測・送信をスクリプトで完全制御する。 */
interface ScriptedStopOptions {
  /** observe() が呼ばれるたびに順に返す値。配列を使い切ったら最後の値を返し続ける。 */
  observeSequence: ProcessGroupObservation[];
  /** send() が呼ばれるたびに順に返す/投げる値。配列を使い切ったら最後の要素を再利用する。 */
  sendSequence: Array<SignalSendResult | Error>;
  pollIntervalMs?: number | undefined;
  maxWaitMs?: number | undefined;
}

interface ScriptedStopRecord {
  signals: SignalCall[];
  observeCalls: number;
}

/** observe/send をスクリプト化した DI オプションを組み立てる（stopProcess/cleanupProcessGroup 共用）。 */
function scriptedOptions(
  script: ScriptedStopOptions,
  record: ScriptedStopRecord,
): {
  pollIntervalMs: number;
  maxWaitMs: number;
  isProcessAlive: (pid: number) => ProcessGroupObservation;
  isProcessGroupAlive: (pgid: number) => ProcessGroupObservation;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => SignalSendResult;
  delay: (ms: number) => Promise<void>;
} {
  let observeIdx = 0;
  let sendIdx = 0;
  const observe = (): ProcessGroupObservation => {
    record.observeCalls += 1;
    const value = script.observeSequence[Math.min(observeIdx, script.observeSequence.length - 1)]!;
    observeIdx += 1;
    return value;
  };
  const send = (pid: number, signal: NodeJS.Signals): SignalSendResult => {
    const outcome = script.sendSequence[Math.min(sendIdx, script.sendSequence.length - 1)]!;
    sendIdx += 1;
    record.signals.push({ pid, signal });
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  };
  return {
    pollIntervalMs: script.pollIntervalMs ?? 10,
    maxWaitMs: script.maxWaitMs ?? 2000,
    isProcessAlive: observe,
    isProcessGroupAlive: observe,
    killProcessGroup: send,
    delay: async () => {},
  };
}

describe("stopProcess / cleanupProcessGroup の観測状態遷移表（契約 §34.2.1、全19行の表駆動テスト）", () => {
  interface SequenceCase {
    name: string;
    observeSequence: ProcessGroupObservation[];
    sendSequence: Array<SignalSendResult | Error>;
    maxWaitMs?: number;
    expected: StopResult | "throw";
    expectedSignals: NodeJS.Signals[];
  }

  /**
   * フェイクタイマーで仮想時刻を制御する必要がある行（行17: KILL後pollの複数回継続）専用のケース。
   * 指定時は run() 内で直接 stopProcess を呼び出して検証し、他の SequenceCase と同じ cases 配列・
   * 同じ it.each で実行する（配列外に切り出さない）。
   */
  interface CustomCase {
    name: string;
    run: () => Promise<void>;
  }

  type TableCase = SequenceCase | CustomCase;

  // 契約 §34.2.1 の遷移表（docs/contract.md:1386-1404）は全19行。うち13行は「返す/throw」で
  // 終端する行であり、それぞれ下記 cases の該当エントリが直接その reason/throw を assert する。
  // 残る6行は「継続」（次 phase へ進むだけで、それ自体は終端値を返さない）行であり、以下のとおり
  // 証明する（表の行番号は docs/contract.md の該当表における出現順）:
  //   行3  開始前 obs()=alive → SIGTERM継続        : cases「[継続行] 開始前 alive → ...」
  //   行7  SIGTERM send=sent → TERM後poll継続       : cases「[継続行] SIGTERM send=sent → ...」
  //   行9  TERM後poll alive/unobservable → poll継続 : cases「[継続行] TERM 後 poll: alive/unobservable ...」
  //        （複数回の poll 継続を単一 observe に潰さず直接証明する）
  //   行10 TERM後poll期限到達・alive観測あり → SIGKILL継続: cases「[継続行] TERM 後 poll 期限到達 ...」
  //   行15 SIGKILL send=sent → KILL後poll継続        : cases「[継続行] SIGKILL send=sent → ...」
  //   行17 KILL後poll alive/unobservable → poll継続  : cases「[継続行] KILL 後 poll: alive/unobservable ...」
  //        （TERM/KILL 両 phase は同じ maxWaitMs を共有し、scriptedOptions() の delay は同期 no-op
  //        （fake timers 非対応）のため、observeSequence だけでは「TERM後poll を即座に期限到達させ、
  //        かつ KILL後poll だけ複数回継続させる」を両立できない。この行のみ CustomCase として
  //        run() にフェイクタイマー付きの検証関数を渡し、それ以外の18行と同じ cases 配列・同じ
  //        it.each 内で実行する）
  const cases: TableCase[] = [
    // --- 開始前 ---
    {
      name: "開始前 gone → already-exited",
      observeSequence: ["gone"],
      sendSequence: [],
      expected: { stopped: false, reason: "already-exited" },
      expectedSignals: [],
    },
    {
      name: "開始前 unobservable → unsignalable",
      observeSequence: ["unobservable"],
      sendSequence: [],
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: [],
    },
    // --- SIGTERM 送信 ---
    {
      name: "開始前 alive → SIGTERM 送信へ継続、send=gone → already-exited",
      observeSequence: ["alive"],
      sendSequence: ["gone"],
      expected: { stopped: false, reason: "already-exited" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "SIGTERM send=unsignalable → unsignalable",
      observeSequence: ["alive"],
      sendSequence: ["unsignalable"],
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "SIGTERM send=fatal → throw",
      observeSequence: ["alive"],
      sendSequence: [errnoError("EIO")],
      expected: "throw",
      expectedSignals: ["SIGTERM"],
    },
    // --- TERM 後 poll ---
    {
      name: "TERM 後 poll で gone を観測 → terminated",
      observeSequence: ["alive", "gone"],
      sendSequence: ["sent"],
      expected: { stopped: true, reason: "terminated" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "TERM 後 poll 期限到達・alive を一度も観測せず unobservable のみ → unsignalable",
      observeSequence: ["alive", "unobservable"],
      sendSequence: ["sent"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "TERM 後 poll 期限到達・alive を一度でも観測 → SIGKILL へ継続、send=gone → already-exited",
      observeSequence: ["alive", "alive"],
      sendSequence: ["sent", "gone"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "already-exited" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    // --- SIGKILL 送信 ---
    {
      name: "SIGKILL send=unsignalable → unsignalable",
      observeSequence: ["alive", "alive"],
      sendSequence: ["sent", "unsignalable"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    {
      name: "SIGKILL send=fatal → throw",
      observeSequence: ["alive", "alive"],
      sendSequence: ["sent", errnoError("EIO")],
      maxWaitMs: 0,
      expected: "throw",
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    // --- KILL 後 poll ---
    {
      name: "KILL 後 poll で gone を観測 → killed",
      observeSequence: ["alive", "alive", "gone"],
      sendSequence: ["sent", "sent"],
      maxWaitMs: 0,
      expected: { stopped: true, reason: "killed" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    {
      name: "KILL 後 poll 期限到達・alive を一度でも観測 → kill-unconfirmed（stopped:true/killed を返さない）",
      observeSequence: ["alive", "alive", "alive"],
      sendSequence: ["sent", "sent"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "kill-unconfirmed" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    {
      name: "KILL 後 poll 期限到達・alive を一度も観測せず unobservable のみ → unsignalable",
      observeSequence: ["alive", "alive", "unobservable"],
      sendSequence: ["sent", "sent"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    // --- 継続（continuation）行の単独証跡 ---
    // 上記13件は表の「返す/throw」行（終端値を持つ行）を名前の軸にしているため、各終端に至る
    // 過程で通過する「継続」行は expectedSignals を介して間接的に証明されるのみだった。
    // この小さい状態機械では継続行を終端無しに孤立させられない（次の phase へ進めば必ず何らかの
    // 終端行へ到達する）ため、以下は意図的に上記と同一の script を「継続行」自体の名前で
    // 個別に列挙し、契約の表と1対1で突き合わせられるようにする（重複は漏れではなく意図的）。
    {
      name: "[継続行] 開始前 obs()=alive → SIGTERM phase へ継続（表: 開始前 obs()=alive の行）",
      observeSequence: ["alive"],
      sendSequence: ["unsignalable"],
      expected: { stopped: false, reason: "unsignalable" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "[継続行] SIGTERM send=sent → TERM 後 poll phase へ継続（表: SIGTERM send=sent の行）",
      observeSequence: ["alive", "gone"],
      sendSequence: ["sent"],
      expected: { stopped: true, reason: "terminated" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "[継続行] TERM 後 poll: alive/unobservable が複数回続いても poll を継続する（単一 observe に潰さず複数回の poll 継続を直接証明、表: TERM後poll obs=alive/unobservable の行）",
      observeSequence: ["alive", "unobservable", "alive", "unobservable", "gone"],
      sendSequence: ["sent"],
      expected: { stopped: true, reason: "terminated" },
      expectedSignals: ["SIGTERM"],
    },
    {
      name: "[継続行] TERM 後 poll 期限到達・alive 観測あり → SIGKILL phase へ継続（表: TERM後poll 期限到達・alive観測ありの行）",
      observeSequence: ["alive", "alive"],
      sendSequence: ["sent", "gone"],
      maxWaitMs: 0,
      expected: { stopped: false, reason: "already-exited" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    {
      name: "[継続行] SIGKILL send=sent → KILL 後 poll phase へ継続（表: SIGKILL send=sent の行）",
      observeSequence: ["alive", "alive", "gone"],
      sendSequence: ["sent", "sent"],
      maxWaitMs: 0,
      expected: { stopped: true, reason: "killed" },
      expectedSignals: ["SIGTERM", "SIGKILL"],
    },
    {
      name: "[継続行] KILL 後 poll: alive/unobservable が複数回続いても poll を継続する（フェイクタイマーで仮想時刻を制御、表: KILL後poll obs=alive/unobservable の行）",
      run: async () => {
        // TERM/KILL 両 phase は同じ maxWaitMs を共有するため、observeSequence ベースの
        // scriptedOptions（delay が同期 no-op）では「TERM 後 poll だけ即座に期限到達させ、
        // KILL 後 poll だけ複数回継続させる」を両立できない。ここでは fake timers で仮想時刻を
        // 直接進め、SIGKILL 送信済み（sendCount>=2）かどうかで観測内容を切り替えることで、
        // KILL フェーズ内の unobservable → unobservable → gone という複数回継続を決定的に再現する。
        vi.useFakeTimers();
        try {
          let sendCount = 0;
          let killPhaseObserveCount = 0;
          const observe = (): ProcessGroupObservation => {
            // 開始前チェックと TERM 後 poll は常に alive を返し、期限切れで KILL 送信へ進ませる。
            if (sendCount < 2) return "alive";
            killPhaseObserveCount += 1;
            if (killPhaseObserveCount <= 2) return "unobservable";
            return "gone";
          };
          const signals: NodeJS.Signals[] = [];
          const send = (_pid: number, signal: NodeJS.Signals): SignalSendResult => {
            sendCount += 1;
            signals.push(signal);
            return "sent";
          };
          const opts = {
            pollIntervalMs: 10,
            maxWaitMs: 25,
            isProcessAlive: observe,
            killProcessGroup: send,
            delay: async (ms: number) => {
              vi.advanceTimersByTime(ms);
            },
          };
          await expect(stopProcess(999, opts)).resolves.toEqual({ stopped: true, reason: "killed" });
          expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        } finally {
          vi.useRealTimers();
        }
      },
    },
  ];

  it.each(cases)("$name", async (tc) => {
    if ("run" in tc) {
      await tc.run();
      return;
    }
    const { observeSequence, sendSequence, maxWaitMs, expected, expectedSignals } = tc;
    const record: ScriptedStopRecord = { signals: [], observeCalls: 0 };
    const opts = scriptedOptions({ observeSequence, sendSequence, maxWaitMs }, record);

    if (expected === "throw") {
      await expect(stopProcess(999, opts)).rejects.toThrow();
    } else {
      await expect(stopProcess(999, opts)).resolves.toEqual(expected);
    }

    // cleanupProcessGroup も同じ共通シーケンスを使うため、同一スクリプトで同一結果になることを確認する。
    const groupRecord: ScriptedStopRecord = { signals: [], observeCalls: 0 };
    const groupOpts = scriptedOptions({ observeSequence, sendSequence, maxWaitMs }, groupRecord);
    if (expected === "throw") {
      await expect(cleanupProcessGroup(999, groupOpts)).rejects.toThrow();
    } else {
      await expect(cleanupProcessGroup(999, groupOpts)).resolves.toEqual(expected);
      expect(groupRecord.signals.map((s) => s.signal)).toEqual(expectedSignals);
    }
  });

  it("poll 中の一時的 unobservable の後に gone を観測すると terminated になる（TERM フェーズ、表: TERM後poll obs=alive/unobservable の行の補強）", async () => {
    const record: ScriptedStopRecord = { signals: [], observeCalls: 0 };
    const opts = scriptedOptions(
      {
        observeSequence: ["alive", "unobservable", "unobservable", "gone"],
        sendSequence: ["sent"],
        maxWaitMs: 2000,
      },
      record,
    );
    await expect(stopProcess(999, opts)).resolves.toEqual({ stopped: true, reason: "terminated" });
  });

  it("実 flake 同型: already-exited になるはずの場面で ESRCH の代わりに EPERM が返っても throw しない", async () => {
    // 旧実装は isProcessGroupAlive が EPERM を「生存」とみなして SIGTERM 送信へ進み、
    // killProcessGroup 側は EPERM で throw していた（片方の解釈のズレが flake の正体）。
    // 新実装は observe/send の両方が EPERM を同じ「unsignalable」として扱うため、
    // already-exited になるはずの場面で EPERM に化けても unsignalable に留まり、例外化しない。
    const record: ScriptedStopRecord = { signals: [], observeCalls: 0 };
    const opts = scriptedOptions(
      {
        observeSequence: ["alive"],
        sendSequence: ["unsignalable"],
      },
      record,
    );
    await expect(stopProcess(999, opts)).resolves.toEqual({ stopped: false, reason: "unsignalable" });
  });

  it("TERM フェーズ: poll 中に alive を一度観測した後 unobservable のまま期限到達しても unsignalable にならず SIGKILL へ継続する（契約 §34.2.1 優先順位、表: TERM後poll 期限到達・alive観測ありの行の補強）", async () => {
    // 遷移優先順位の要件（期限到達時、poll 中に一度でも alive を観測していれば unsignalable に
    // ならないこと）を、単なる「alive のみ」ではなく「alive の後に unobservable が続いて期限に
    // 到達する」混在パターンで直接証明する。実装が「最後に観測した値」で判定していたら、この
    // ケースは誤って unsignalable を返し SIGKILL 送信に到達しない。
    vi.useFakeTimers();
    try {
      let sendCount = 0;
      let termPollObserveCount = 0;
      const observe = (): ProcessGroupObservation => {
        if (sendCount === 0) return "alive"; // 開始前チェック（SIGTERM 送信前）
        if (sendCount === 1) {
          // TERM 後 poll: 最初は alive、以降は unobservable のまま期限まで粘る（gone は観測しない）
          termPollObserveCount += 1;
          return termPollObserveCount === 1 ? "alive" : "unobservable";
        }
        // KILL 後 poll: 即座に gone を観測させ、SIGKILL まで到達したことを確認する
        return "gone";
      };
      const signals: NodeJS.Signals[] = [];
      const send = (_pid: number, signal: NodeJS.Signals): SignalSendResult => {
        sendCount += 1;
        signals.push(signal);
        return "sent";
      };
      const opts = {
        pollIntervalMs: 10,
        maxWaitMs: 25,
        isProcessAlive: observe,
        killProcessGroup: send,
        delay: async (ms: number) => {
          vi.advanceTimersByTime(ms);
        },
      };
      await expect(stopProcess(999, opts)).resolves.toEqual({ stopped: true, reason: "killed" });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("KILL フェーズ: poll 中に alive を一度観測した後 unobservable のまま期限到達すると kill-unconfirmed になる（unsignalable にならない、契約 §34.2.1 優先順位、表: KILL後poll 期限到達・alive観測ありの行の補強）", async () => {
    // 上記 TERM フェーズ版と対になるテスト。KILL 後 poll でも同じ優先順位規律（一度でも alive を
    // 観測していれば、期限到達時の直近の観測が unobservable でも unsignalable にしない）が
    // 守られていることを確認する。KILL フェーズでの正しい結果は kill-unconfirmed であり、
    // stopped:true/killed でも unsignalable でもない。
    vi.useFakeTimers();
    try {
      let sendCount = 0;
      let killPollObserveCount = 0;
      const observe = (): ProcessGroupObservation => {
        // 開始前チェックと TERM 後 poll は常に alive を返し、期限切れで KILL 送信へ進ませる。
        if (sendCount < 2) return "alive";
        // KILL 後 poll: 最初は alive、以降は unobservable のまま期限まで粘る（gone は観測しない）
        killPollObserveCount += 1;
        return killPollObserveCount === 1 ? "alive" : "unobservable";
      };
      const signals: NodeJS.Signals[] = [];
      const send = (_pid: number, signal: NodeJS.Signals): SignalSendResult => {
        sendCount += 1;
        signals.push(signal);
        return "sent";
      };
      const opts = {
        pollIntervalMs: 10,
        maxWaitMs: 25,
        isProcessAlive: observe,
        killProcessGroup: send,
        delay: async (ms: number) => {
          vi.advanceTimersByTime(ms);
        },
      };
      await expect(stopProcess(999, opts)).resolves.toEqual({ stopped: false, reason: "kill-unconfirmed" });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stopProcess（契約 §34.2、非 tri-state 経路の基本シナリオ）", () => {
  it("生存していない pid は already-exited を返す", async () => {
    const signals: SignalCall[] = [];
    const result = await stopProcess(999999, {
      isProcessAlive: () => "gone",
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        return "sent";
      },
    });
    expect(result).toEqual({ stopped: false, reason: "already-exited" });
    expect(signals).toHaveLength(0);
  });

  it("SIGTERM に素直に応じるプロセスは terminated を返す", async () => {
    const signals: SignalCall[] = [];
    let alive: ProcessGroupObservation = "alive";

    const result = await stopProcess(1234, {
      pollIntervalMs: 20,
      maxWaitMs: 2000,
      isProcessAlive: () => alive,
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        alive = "gone";
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: true, reason: "terminated" });
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });

  it("SIGTERM を無視し SIGKILL 後も生存が確認できるプロセスは kill-unconfirmed を返す", async () => {
    const signals: SignalCall[] = [];

    const result = await stopProcess(1234, {
      pollIntervalMs: 20,
      maxWaitMs: 0,
      isProcessAlive: () => "alive",
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: false, reason: "kill-unconfirmed" });
    expect(signals).toEqual([
      { pid: 1234, signal: "SIGTERM" },
      { pid: 1234, signal: "SIGKILL" },
    ]);
  });

  it("SIGTERM を無視するが SIGKILL 後に消滅を観測できれば killed を返す", async () => {
    const signals: SignalCall[] = [];
    let observation: ProcessGroupObservation = "alive";

    const result = await stopProcess(1234, {
      pollIntervalMs: 20,
      maxWaitMs: 0,
      isProcessAlive: () => observation,
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") {
          observation = "gone";
        }
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: true, reason: "killed" });
    expect(signals).toEqual([
      { pid: 1234, signal: "SIGTERM" },
      { pid: 1234, signal: "SIGKILL" },
    ]);
  });
});

describe("stopDirectSession（契約 §34.2 / §51.1）", () => {
  let tempRoot: string;
  let stateDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-direct-process-session-"));
    stateDir = join(tempRoot, "state");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("state ファイルが存在しない場合は already-exited を返す", async () => {
    const result = await stopDirectSession(stateDir, "direct-missing0000");
    expect(result).toEqual({ stopped: false, reason: "already-exited" });
  });

  it("state から pid を読み取り SIGTERM で停止する（terminated）", async () => {
    const signals: SignalCall[] = [];
    let alive: ProcessGroupObservation = "alive";
    writeDirectSessionState(stateDir, "direct-abc123", {
      pid: 2345,
      taskId: "t_x",
      outFile: join(stateDir, "direct-abc123.out"),
      exitFile: join(stateDir, "direct-abc123.exit"),
      model: "gpt-5.4",
      startedAt: 0,
    });

    const result = await stopDirectSession(stateDir, "direct-abc123", {
      pollIntervalMs: 20,
      maxWaitMs: 2000,
      isProcessGroupAlive: () => alive,
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        alive = "gone";
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: true, reason: "terminated" });
    expect(signals).toEqual([{ pid: 2345, signal: "SIGTERM" }]);
  });

  it("state 記録の pid が EPERM で観測不能でも throw せず unsignalable を返す（実 flake 同型）", async () => {
    writeDirectSessionState(stateDir, "direct-eperm", {
      pid: 6789,
      taskId: "t_x",
      outFile: join(stateDir, "direct-eperm.out"),
      exitFile: join(stateDir, "direct-eperm.exit"),
      model: "gpt-5.4",
      startedAt: 0,
    });

    const result = await stopDirectSession(stateDir, "direct-eperm", {
      isProcessGroupAlive: () => "unobservable",
      killProcessGroup: () => {
        throw new Error("このテストでは呼ばれないはず（開始前 unobservable は即 unsignalable）");
      },
    });

    expect(result).toEqual({ stopped: false, reason: "unsignalable" });
  });

  it("不正な pid（0/負数/非整数）を含む state は無効として扱われ signal を送らない（契約 §34.2）", async () => {
    const killSpy = vi.spyOn(process, "kill");
    const invalidPids: Array<[string, number]> = [
      ["zero", 0],
      ["negative", -100],
      ["non-integer", 1.5],
    ];

    for (const [label, pid] of invalidPids) {
      const sessionId = `direct-badpid-${label}`;
      writeDirectSessionState(stateDir, sessionId, {
        pid,
        taskId: "t_x",
        outFile: join(stateDir, `${sessionId}.out`),
        exitFile: join(stateDir, `${sessionId}.exit`),
        model: "gpt-5.4",
        startedAt: 0,
      });

      const result = await stopDirectSession(stateDir, sessionId);
      expect(result).toEqual({ stopped: false, reason: "already-exited" });
    }

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("exitFile が既に存在する場合も process group cleanup を試行する（docs/contract.md §51.1）", async () => {
    const signals: SignalCall[] = [];
    let groupAlive: ProcessGroupObservation = "alive";
    const sessionId = "direct-already-exited";
    const exitFile = join(stateDir, `${sessionId}.exit`);
    // ワーカー正常終了時に書かれる exit ファイルを模擬する（中身は不問）
    writeFileSync(exitFile, "0", "utf8");

    writeDirectSessionState(stateDir, sessionId, {
      pid: 3456,
      taskId: "t_x",
      outFile: join(stateDir, `${sessionId}.out`),
      exitFile,
      model: "gpt-5.4",
      startedAt: 0,
    });

    const result = await stopDirectSession(stateDir, sessionId, {
      pollIntervalMs: 20,
      maxWaitMs: 2000,
      isProcessGroupAlive: () => groupAlive,
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        groupAlive = "gone";
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: true, reason: "terminated" });
    expect(signals).toEqual([{ pid: 3456, signal: "SIGTERM" }]);
  });

  it("exitFile が無く leader pid が消えていても process group cleanup を試行する（docs/contract.md §51.1）", async () => {
    const signals: SignalCall[] = [];
    let groupAlive: ProcessGroupObservation = "alive";
    const sessionId = "direct-leader-gone";

    writeDirectSessionState(stateDir, sessionId, {
      pid: 4567,
      taskId: "t_x",
      outFile: join(stateDir, `${sessionId}.out`),
      exitFile: join(stateDir, `${sessionId}.exit`),
      model: "gpt-5.4",
      startedAt: 0,
    });

    const result = await stopDirectSession(stateDir, sessionId, {
      pollIntervalMs: 20,
      maxWaitMs: 2000,
      isProcessAlive: () => "gone",
      isProcessGroupAlive: () => groupAlive,
      killProcessGroup: (pid, signal): SignalSendResult => {
        signals.push({ pid, signal });
        groupAlive = "gone";
        return "sent";
      },
      delay: async () => {},
    });

    expect(result).toEqual({ stopped: true, reason: "terminated" });
    expect(signals).toEqual([{ pid: 4567, signal: "SIGTERM" }]);
  });
});
