import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteKanbanStore } from "./db.js";
import { readBoardInstanceId } from "./readview.js";
import {
  RelayAuthorityMutationError,
  mapRelayRegistrationClaimRow,
  type RawRelayRegistrationClaimRow,
  type RelayActivateRegistrationInput,
  type RelayActivateRegistrationResult,
  type RelayAdoptInstallationInput,
  type RelayAdvanceHostEpochInput,
  type RelayAuthorityBeforeMutation,
  type RelayAuthorityIdentity,
  type RelayAuthorityInstallation,
  type RelayExpectedInstallation,
  type RelayIssueRegistrationClaimInput,
  type RelayRegistrationClaim,
  type RelayRegistrationClaimPurpose,
  type RelayRetireRegistrationInput,
  type RelayRetireRegistrationResult,
} from "./relay-authority-store.js";
import type { RegisterRelayInput, RelayOwnerFence } from "./relay-registry.js";

function makeHex(length: number, label: string): string {
  return createHash("sha256").update(label).digest("hex").slice(0, length);
}

function makeSecret(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

describe("SqliteKanbanStore: RelayOwnerAuthorityStore（契約 §78.10 / §78.10.3.1）", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteKanbanStore;
  let boardInstanceId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hachi-relay-authority-"));
    dbPath = join(tempDir, "board.db");
    store = new SqliteKanbanStore(dbPath);
    boardInstanceId = readBoardInstanceId(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function identity(adoptionLabel = "adoption-a", hostLabel = "host-a"): RelayAuthorityIdentity {
    return {
      boardInstanceId,
      adoptionId: makeHex(64, adoptionLabel),
      hostIdentity: makeHex(64, hostLabel),
    };
  }

  function adopt(now = 1_000, labels: { adoptionLabel?: string; hostLabel?: string } = {}): {
    installation: RelayAuthorityInstallation;
    spy: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn();
    const installation = store.adoptInstallation(
      { identity: identity(labels.adoptionLabel, labels.hostLabel), now },
      spy,
    );
    return { installation, spy };
  }

  function candidate(overrides: Partial<RegisterRelayInput> = {}): RegisterRelayInput {
    return {
      sessionId: "session-a",
      providerSessionId: "provider-session-a",
      provider: "codex",
      serverUrl: "http://127.0.0.1:3456",
      host: "host-a",
      evenTerminalBootEpoch: "boot-a",
      handoverGeneration: 1,
      relayId: makeHex(64, "relay-a"),
      ...overrides,
    };
  }

  function issue(
    expectedInstallation: RelayExpectedInstallation,
    opts: {
      purpose?: RelayRegistrationClaimPurpose;
      candidateOverrides?: Partial<RegisterRelayInput>;
      claimIdLabel?: string;
      secretLabel?: string;
      evidenceLabel?: string;
      expectedPreviousRegistration?: RelayOwnerFence | null;
      now?: number;
      expiresAt?: number;
      nativeObservedAt?: number;
      beforeMutation?: RelayAuthorityBeforeMutation;
    } = {},
  ): {
    claim: RelayRegistrationClaim;
    claimId: string;
    claimSecretHash: Buffer;
    beforeMutation: RelayAuthorityBeforeMutation;
    installation: RelayAuthorityInstallation;
  } {
    const now = opts.now ?? 1_000;
    const claimId = makeHex(64, opts.claimIdLabel ?? "claim-a");
    const claimSecretHash = makeSecret(opts.secretLabel ?? "secret-a");
    const beforeMutation = opts.beforeMutation ?? vi.fn();
    const claim = store.issueRegistrationClaim(
      {
        expectedInstallation,
        candidate: candidate(opts.candidateOverrides),
        purpose: opts.purpose ?? "initial",
        nativeEvidenceDigest: makeHex(64, opts.evidenceLabel ?? "evidence-a"),
        nativeObservedAt: opts.nativeObservedAt ?? now,
        claimId,
        claimSecretHash,
        expiresAt: opts.expiresAt ?? now + 60,
        expectedPreviousRegistration: opts.expectedPreviousRegistration ?? null,
        now,
      },
      beforeMutation,
    );
    // issueRegistrationClaimもauthorityRevisionを進めるため、以後のCASにはこのinstallationを使う。
    const installation = store.readInstallation() as RelayAuthorityInstallation;
    return { claim, claimId, claimSecretHash, beforeMutation, installation };
  }

  function activate(
    expectedInstallation: RelayExpectedInstallation,
    claimId: string,
    claimSecretHash: Buffer,
    now: number,
    beforeMutation: RelayAuthorityBeforeMutation = vi.fn(),
  ): RelayActivateRegistrationResult {
    return store.activateRegistration({ expectedInstallation, claimId, claimSecretHash, now }, beforeMutation);
  }

  function counts(): { sessions: number; claims: number } {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const sessions = (raw.prepare(`SELECT COUNT(*) AS n FROM relay_session_authorities`).get() as { n: number }).n;
      const claims = (raw.prepare(`SELECT COUNT(*) AS n FROM relay_registration_claims`).get() as { n: number }).n;
      return { sessions, claims };
    } finally {
      raw.close();
    }
  }

  // ---------------------------------------------------------------------
  // adopt / read / reopen
  // ---------------------------------------------------------------------
  describe("adoptInstallation / read / reopen", () => {
    it("初回adoptでhostEpoch=1・authorityRevision=1のinstallationを作りreadInstallationで読める", () => {
      const { installation, spy } = adopt();
      expect(installation).toEqual({ ...identity(), hostEpoch: 1, authorityRevision: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(null, 1);
      expect(store.readInstallation()).toEqual(installation);
    });

    it("2回目のadoptはINSTALLATION_ALREADY_ADOPTEDでcallbackを呼ばない", () => {
      adopt();
      const spy = vi.fn();
      expect(() => store.adoptInstallation({ identity: identity("adoption-b"), now: 2_000 }, spy)).toThrowError(
        expect.objectContaining({ code: "INSTALLATION_ALREADY_ADOPTED" }),
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it("boardInstanceId不一致はBOARD_INSTANCE_MISMATCHでcallbackを呼ばない", () => {
      const spy = vi.fn();
      expect(() =>
        store.adoptInstallation(
          { identity: { ...identity(), boardInstanceId: makeHex(32, "other-board") }, now: 1_000 },
          spy,
        ),
      ).toThrowError(expect.objectContaining({ code: "BOARD_INSTANCE_MISMATCH" }));
      expect(spy).not.toHaveBeenCalled();
      expect(store.readInstallation()).toBeNull();
    });

    it("reopen後もinstallationを保持し、token採番はreopenをまたいで単調増加する", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000 });
      const activated1 = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);
      expect(activated1.owner.fencingToken).toBe(1);

      store.close();
      store = new SqliteKanbanStore(dbPath);

      const reopened = store.readInstallation();
      expect(reopened).toEqual(activated1.installation);

      const retireResult = store.retireRegistration(
        {
          expectedInstallation: reopened as RelayAuthorityInstallation,
          owner: activated1.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );
      const second = issue(retireResult.installation, {
        purpose: "restart",
        candidateOverrides: {
          relayId: makeHex(64, "relay-b"),
          providerSessionId: "provider-session-b",
          evenTerminalBootEpoch: "boot-b",
        },
        expectedPreviousRegistration: activated1.owner,
        claimIdLabel: "claim-b",
        secretLabel: "secret-b",
        now: 1_030,
      });
      const activated2 = activate(second.installation, second.claimId, second.claimSecretHash, 1_040);
      expect(activated2.owner.fencingToken).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // issue: 競合 / 期限切れ / replay
  // ---------------------------------------------------------------------
  describe("issueRegistrationClaim: 競合と期限切れ", () => {
    it("未期限切れissuedがあると2件目issueはISSUED_CLAIM_CONFLICTで側作用0", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000, expiresAt: 1_060 });
      const before = counts();
      const spy = vi.fn();
      expect(() =>
        issue(first.installation, {
          candidateOverrides: { relayId: makeHex(64, "relay-b") },
          claimIdLabel: "claim-b",
          now: 1_010,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "ISSUED_CLAIM_CONFLICT" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });

    it("activeがあると新規issueはISSUED_CLAIM_CONFLICTで側作用0", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000 });
      const activated = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);
      const before = counts();
      const spy = vi.fn();
      expect(() =>
        issue(activated.installation, {
          candidateOverrides: { relayId: makeHex(64, "relay-b") },
          claimIdLabel: "claim-b",
          now: 1_020,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "ISSUED_CLAIM_CONFLICT" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });

    it("期限切れissuedは新規issueと同mutationでcancelled/expiredになる", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000, expiresAt: 1_005 });
      const second = issue(first.installation, {
        candidateOverrides: { relayId: makeHex(64, "relay-b") },
        claimIdLabel: "claim-b",
        now: 1_010,
      });
      const firstAfter = store.readRegistrationClaim(first.claimId);
      expect(firstAfter?.state).toBe("cancelled");
      expect(firstAfter?.terminationReason).toBe("expired");
      expect(second.claim.state).toBe("issued");
    });

    it("expiresAtを過ぎたissued claimのactivateはCLAIM_EXPIREDで側作用0", () => {
      const { installation } = adopt();
      const { claimId, claimSecretHash, installation: postIssue } = issue(installation, {
        now: 1_000,
        expiresAt: 1_005,
      });
      const spy = vi.fn();
      expect(() => activate(postIssue, claimId, claimSecretHash, 1_010, spy)).toThrowError(
        expect.objectContaining({ code: "CLAIM_EXPIRED" }),
      );
      expect(spy).not.toHaveBeenCalled();
      expect(store.readRegistrationClaim(claimId)?.state).toBe("issued");
    });

    it("cancelled化されたclaimへのactivate（replay）はCLAIM_STATE_MISMATCHで側作用0", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000, expiresAt: 1_005 });
      const second = issue(first.installation, {
        candidateOverrides: { relayId: makeHex(64, "relay-b") },
        claimIdLabel: "claim-b",
        now: 1_010,
      });
      const spy = vi.fn();
      expect(() => activate(second.installation, first.claimId, first.claimSecretHash, 1_020, spy)).toThrowError(
        expect.objectContaining({ code: "CLAIM_STATE_MISMATCH" }),
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it("誤ったclaim secretのactivateはCLAIM_SECRET_MISMATCHで側作用0", () => {
      const { installation } = adopt();
      const { claimId, installation: postIssue } = issue(installation, { now: 1_000 });
      const spy = vi.fn();
      expect(() => activate(postIssue, claimId, makeSecret("wrong-secret"), 1_010, spy)).toThrowError(
        expect.objectContaining({ code: "CLAIM_SECRET_MISMATCH" }),
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // retire → restart（fresh boot/providerSession成功、旧owner不一致拒否）
  // ---------------------------------------------------------------------
  describe("retireRegistration → restart issue", () => {
    function activeOwner(now = 1_000): RelayActivateRegistrationResult {
      const { installation } = adopt(now);
      const { claimId, claimSecretHash, installation: postIssue } = issue(installation, { now });
      return activate(postIssue, claimId, claimSecretHash, now + 10);
    }

    it("normal_shutdownでretireし、freshなboot/providerSession/relayIdでrestart issue→activateが成功する", () => {
      const activated = activeOwner(1_000);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );
      const restartClaim = issue(retireResult.installation, {
        purpose: "restart",
        candidateOverrides: {
          relayId: makeHex(64, "relay-restart"),
          providerSessionId: "provider-session-restart",
          evenTerminalBootEpoch: "boot-restart",
        },
        expectedPreviousRegistration: activated.owner,
        claimIdLabel: "claim-restart",
        secretLabel: "secret-restart",
        now: 1_030,
      });
      const activated2 = activate(
        restartClaim.installation,
        restartClaim.claimId,
        restartClaim.claimSecretHash,
        1_040,
      );
      expect(activated2.owner.fencingToken).toBe(2);
      expect(activated2.owner.handoverGeneration).toBe(1);

      const session = store.readSessionAuthority("session-a");
      expect(session).toEqual({
        sessionId: "session-a",
        fencingTokenHwm: 2,
        maxHandoverGeneration: 1,
        latestClaimId: restartClaim.claimId,
        revision: 5,
      });
    });

    it("旧owner不一致のexpectedPreviousRegistrationはPREVIOUS_REGISTRATION_MISMATCHで側作用0", () => {
      const activated = activeOwner(1_000);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );
      const before = counts();
      const spy = vi.fn();
      const tamperedOwner: RelayOwnerFence = { ...activated.owner, fencingToken: 999 };
      expect(() =>
        issue(retireResult.installation, {
          purpose: "restart",
          candidateOverrides: { relayId: makeHex(64, "relay-restart-bad") },
          expectedPreviousRegistration: tamperedOwner,
          claimIdLabel: "claim-restart-bad",
          now: 1_030,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "PREVIOUS_REGISTRATION_MISMATCH" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });

    it("二度目のretireはCLAIM_STATE_MISMATCHで側作用0", () => {
      const activated = activeOwner(1_000);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );
      const before = counts();
      const spy = vi.fn();
      expect(() =>
        store.retireRegistration(
          {
            expectedInstallation: retireResult.installation,
            owner: activated.owner,
            expectedClaimRevision: 2,
            reason: "normal_shutdown",
            drainEvidenceDigest: null,
            drainedAt: null,
            now: 1_030,
          },
          spy,
        ),
      ).toThrowError(expect.objectContaining({ code: "CLAIM_STATE_MISMATCH" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------
  // handoff: drain無し拒否 / 低generation拒否 / 成功
  // ---------------------------------------------------------------------
  describe("handoff issue", () => {
    function retiredOwner(
      reason: "normal_shutdown" | "handoff_drained",
      now = 1_000,
    ): RelayActivateRegistrationResult & { retireResult: RelayRetireRegistrationResult } {
      const { installation } = adopt(now);
      const { claimId, claimSecretHash, installation: postIssue } = issue(installation, { now });
      const activated = activate(postIssue, claimId, claimSecretHash, now + 10);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason,
          drainEvidenceDigest: reason === "handoff_drained" ? makeHex(64, "drain-a") : null,
          drainedAt: reason === "handoff_drained" ? now + 15 : null,
          now: now + 20,
        },
        vi.fn(),
      );
      return { ...activated, retireResult };
    }

    it("handoff_drainedでない退役に対するhandoff issueはPREVIOUS_REGISTRATION_MISMATCHで側作用0", () => {
      const { owner, retireResult } = retiredOwner("normal_shutdown", 1_000);
      const before = counts();
      const spy = vi.fn();
      expect(() =>
        issue(retireResult.installation, {
          purpose: "handoff",
          candidateOverrides: { relayId: makeHex(64, "relay-handoff"), handoverGeneration: 2 },
          expectedPreviousRegistration: owner,
          claimIdLabel: "claim-handoff",
          now: 1_030,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "PREVIOUS_REGISTRATION_MISMATCH" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });

    it("maxと同世代以下のhandoff issueはGENERATION_MISMATCHで側作用0", () => {
      const { owner, retireResult } = retiredOwner("handoff_drained", 1_000);
      const before = counts();
      const spy = vi.fn();
      expect(() =>
        issue(retireResult.installation, {
          purpose: "handoff",
          candidateOverrides: {
            relayId: makeHex(64, "relay-handoff"),
            handoverGeneration: 1,
            sessionId: "session-a",
          },
          expectedPreviousRegistration: owner,
          claimIdLabel: "claim-handoff",
          now: 1_030,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "GENERATION_MISMATCH" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
    });

    it("drain済み・高generationのhandoff issue→activateが成功する", () => {
      const { owner, retireResult } = retiredOwner("handoff_drained", 1_000);
      const handoffClaim = issue(retireResult.installation, {
        purpose: "handoff",
        candidateOverrides: {
          relayId: makeHex(64, "relay-handoff-ok"),
          handoverGeneration: 2,
          providerSessionId: "provider-session-handoff",
          evenTerminalBootEpoch: "boot-handoff",
        },
        expectedPreviousRegistration: owner,
        claimIdLabel: "claim-handoff-ok",
        secretLabel: "secret-handoff-ok",
        now: 1_030,
      });
      const activated = activate(
        handoffClaim.installation,
        handoffClaim.claimId,
        handoffClaim.claimSecretHash,
        1_040,
      );
      expect(activated.owner.handoverGeneration).toBe(2);
      expect(activated.owner.fencingToken).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // 同session両provider競合 / 別session独立
  // ---------------------------------------------------------------------
  describe("session scope", () => {
    it("同じcanonical sessionはproviderが異なっていてもactive中の新規issueをISSUED_CLAIM_CONFLICTで拒否する", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000, candidateOverrides: { provider: "codex" } });
      const activated = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);
      const spy = vi.fn();
      expect(() =>
        issue(activated.installation, {
          candidateOverrides: { provider: "claude", relayId: makeHex(64, "relay-claude") },
          claimIdLabel: "claim-claude",
          now: 1_020,
          beforeMutation: spy,
        }),
      ).toThrowError(expect.objectContaining({ code: "ISSUED_CLAIM_CONFLICT" }));
      expect(spy).not.toHaveBeenCalled();
    });

    it("別sessionは独立してactivateでき、片方のretireがもう片方に影響しない", () => {
      const { installation } = adopt();
      const a = issue(installation, {
        candidateOverrides: { sessionId: "session-a", relayId: makeHex(64, "relay-a") },
        claimIdLabel: "claim-a",
        now: 1_000,
      });
      const b = issue(a.installation, {
        candidateOverrides: { sessionId: "session-b", relayId: makeHex(64, "relay-b") },
        claimIdLabel: "claim-b",
        now: 1_000,
      });
      const activatedA = activate(b.installation, a.claimId, a.claimSecretHash, 1_010);
      const activatedB = activate(activatedA.installation, b.claimId, b.claimSecretHash, 1_020);

      store.retireRegistration(
        {
          expectedInstallation: activatedB.installation,
          owner: activatedA.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_030,
        },
        vi.fn(),
      );

      expect(store.readSessionAuthority("session-b")).toEqual({
        sessionId: "session-b",
        fencingTokenHwm: activatedB.owner.fencingToken,
        maxHandoverGeneration: 1,
        latestClaimId: b.claimId,
        revision: 2,
      });
      expect(store.readRegistrationClaim(b.claimId)?.state).toBe("active");
    });
  });

  // ---------------------------------------------------------------------
  // advanceHostEpoch: active退役/issued cancel + HWM保持
  // ---------------------------------------------------------------------
  describe("advanceHostEpoch", () => {
    it("全activeをhost_restartでretired、全issuedをhost_restartでcancelledにし、HWM/max/latestを保持する", () => {
      const { installation } = adopt();
      const a = issue(installation, {
        candidateOverrides: { sessionId: "session-a", relayId: makeHex(64, "relay-a") },
        claimIdLabel: "claim-a",
        now: 1_000,
      });
      const activatedA = activate(a.installation, a.claimId, a.claimSecretHash, 1_010);
      const b = issue(activatedA.installation, {
        candidateOverrides: { sessionId: "session-b", relayId: makeHex(64, "relay-b") },
        claimIdLabel: "claim-b",
        now: 1_020,
        expiresAt: 2_000,
      });

      const spy = vi.fn();
      const result = store.advanceHostEpoch({ expectedInstallation: b.installation, now: 1_030 }, spy);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.installation.hostEpoch).toBe(2);
      expect(result.installation.authorityRevision).toBe(b.installation.authorityRevision + 1);
      expect(result.retiredOwners).toEqual([activatedA.owner]);

      const claimA = store.readRegistrationClaim(a.claimId);
      expect(claimA?.state).toBe("retired");
      expect(claimA?.terminationReason).toBe("host_restart");

      const claimB = store.readRegistrationClaim(b.claim.claimId);
      expect(claimB?.state).toBe("cancelled");
      expect(claimB?.terminationReason).toBe("host_restart");

      const sessionA = store.readSessionAuthority("session-a");
      expect(sessionA?.fencingTokenHwm).toBe(1);
      expect(sessionA?.maxHandoverGeneration).toBe(1);
      expect(sessionA?.latestClaimId).toBe(a.claimId);

      const sessionB = store.readSessionAuthority("session-b");
      expect(sessionB?.fencingTokenHwm).toBeNull();
      expect(sessionB?.maxHandoverGeneration).toBeNull();
      expect(sessionB?.latestClaimId).toBeNull();

      const spyActivate = vi.fn();
      expect(() => activate(result.installation, b.claim.claimId, b.claimSecretHash, 1_040, spyActivate)).toThrowError(
        expect.objectContaining({ code: "CLAIM_STATE_MISMATCH" }),
      );
      expect(spyActivate).not.toHaveBeenCalled();

      const staleSpy = vi.fn();
      expect(() =>
        issue(activatedA.installation, {
          candidateOverrides: { sessionId: "session-c", relayId: makeHex(64, "relay-c") },
          claimIdLabel: "claim-c",
          now: 1_050,
          beforeMutation: staleSpy,
        }),
      ).toThrowError(expect.objectContaining({ code: "CAS_MISMATCH" }));
      expect(staleSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // callback契約: exactly1/0、callback内read、callback throw、reentrant→fatal
  // ---------------------------------------------------------------------
  describe("beforeMutation callback契約", () => {
    it("正常mutationはcallbackをちょうど1回呼ぶ（adopt/issue/activate/retire/advanceHostEpoch）", () => {
      const adoptSpy = vi.fn();
      const installation = store.adoptInstallation({ identity: identity(), now: 1_000 }, adoptSpy);
      expect(adoptSpy).toHaveBeenCalledTimes(1);

      const issueSpy = vi.fn();
      const {
        claim,
        claimId,
        claimSecretHash,
        installation: postIssue,
      } = issue(installation, { now: 1_010, beforeMutation: issueSpy });
      expect(issueSpy).toHaveBeenCalledTimes(1);

      const activateSpy = vi.fn();
      const activated = activate(postIssue, claimId, claimSecretHash, 1_020, activateSpy);
      expect(activateSpy).toHaveBeenCalledTimes(1);
      expect(claim.state).toBe("issued");

      const retireSpy = vi.fn();
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_030,
        },
        retireSpy,
      );
      expect(retireSpy).toHaveBeenCalledTimes(1);

      const epochSpy = vi.fn();
      store.advanceHostEpoch({ expectedInstallation: retireResult.installation, now: 1_040 }, epochSpy);
      expect(epochSpy).toHaveBeenCalledTimes(1);
    });

    it("callback内のreadInstallationはcommit前のDB状態を示す", () => {
      const { installation } = adopt();
      let seenDuringCallback: RelayAuthorityInstallation | null = null;
      const result = store.advanceHostEpoch({ expectedInstallation: installation, now: 2_000 }, () => {
        seenDuringCallback = store.readInstallation();
      });
      expect(seenDuringCallback).toEqual(installation);
      expect(result.installation.hostEpoch).toBe(installation.hostEpoch + 1);
    });

    it("callback内での同Store authority mutation再入はREENTRANT_MUTATIONをcauseとしてMUTATION_UNCERTAINになりDBは不変", () => {
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
          store.advanceHostEpoch(
            {
              expectedInstallation: { ...identity(), hostEpoch: 1, authorityRevision: 1 },
              now: 1_000,
            },
            vi.fn(),
          );
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect((caught as RelayAuthorityMutationError).cause).toBeInstanceOf(RelayAuthorityMutationError);
      expect(((caught as RelayAuthorityMutationError).cause as RelayAuthorityMutationError).code).toBe(
        "REENTRANT_MUTATION",
      );
      expect(store.readInstallation()).toBeNull();
    });

    it("callbackが素のErrorをthrowしてもMUTATION_UNCERTAINへ包まれDBは不変", () => {
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
          throw new Error("host receipt予約に失敗しました");
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect((caught as RelayAuthorityMutationError).cause).toBeInstanceOf(Error);
      expect(store.readInstallation()).toBeNull();
    });

    it("callbackが内側の再入エラーを自前でcatchして握り潰しても、外側はMUTATION_UNCERTAINでfatalになりDBは不変", () => {
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
          try {
            store.advanceHostEpoch(
              {
                expectedInstallation: { ...identity(), hostEpoch: 1, authorityRevision: 1 },
                now: 1_000,
              },
              vi.fn(),
            );
          } catch {
            // callbackが再入エラーを握り潰して正常に復帰しても、外側はlatchでfatalにする
          }
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect(store.readInstallation()).toBeNull();

      // reentrantAttempted/callbackStartedはfinallyで解放されており、次の独立operationを誤汚染しない。
      const nextSpy = vi.fn();
      const installation = store.adoptInstallation({ identity: identity(), now: 2_000 }, nextSpy);
      expect(nextSpy).toHaveBeenCalledTimes(1);
      expect(nextSpy).toHaveBeenCalledWith(null, 1);
      expect(installation).toEqual({ ...identity(), hostEpoch: 1, authorityRevision: 1 });
      expect(store.readInstallation()).toEqual(installation);
    });

    it("callbackが既にMUTATION_UNCERTAINのRelayAuthorityMutationErrorをthrowした場合はcauseを保持したまま二重wrapしない", () => {
      const sentinelCause = new Error("host receipt fsyncが失敗しました");
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
          throw new RelayAuthorityMutationError("MUTATION_UNCERTAIN", "host側で既に分類済みの不確定", sentinelCause);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect((caught as RelayAuthorityMutationError).cause).toBe(sentinelCause);
      expect(store.readInstallation()).toBeNull();
    });

    it("callbackがthenableを返すとMUTATION_UNCERTAINになりDBは不変", () => {
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, (() => {
          return { then: () => undefined };
        }) as unknown as RelayAuthorityBeforeMutation);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect(store.readInstallation()).toBeNull();
    });

    it("callback開始後のSQL失敗はMUTATION_UNCERTAINとoriginal causeへ統一されDBは不変（二重wrapしない）", () => {
      const { installation } = adopt();
      const { claimId, claimSecretHash, installation: postIssue } = issue(installation, { now: 1_000 });

      // privateなtmp DBへ直接triggerを仕込み、activateRegistrationのpost-callback UPDATEを失敗させる。
      store.close();
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS test_poison_flag (poison INTEGER NOT NULL);
        INSERT INTO test_poison_flag (poison) VALUES (1);
        CREATE TRIGGER test_poison_claim_activate
        AFTER UPDATE OF state ON relay_registration_claims
        WHEN NEW.state = 'active' AND (SELECT poison FROM test_poison_flag) = 1
        BEGIN
          SELECT RAISE(ABORT, 'test poison trigger fired');
        END;
      `);
      raw.close();
      store = new SqliteKanbanStore(dbPath);

      let caught: unknown;
      try {
        store.activateRegistration({ expectedInstallation: postIssue, claimId, claimSecretHash, now: 1_010 }, vi.fn());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect((caught as RelayAuthorityMutationError).cause).toBeDefined();
      expect((caught as RelayAuthorityMutationError).cause).not.toBeInstanceOf(RelayAuthorityMutationError);
      expect(store.readRegistrationClaim(claimId)?.state).toBe("issued");
      expect(store.readInstallation()?.authorityRevision).toBe(postIssue.authorityRevision);
    });

    it("callback戻り値のthen getterがCAS_MISMATCHをthrowしてもMUTATION_UNCERTAINへ統一されcauseを保持する（二重wrapしない）", () => {
      const sentinelCasMismatch = new RelayAuthorityMutationError(
        "CAS_MISMATCH",
        "callback戻り値のthen getterが偽装したCAS_MISMATCH",
      );
      let caught: unknown;
      try {
        store.adoptInstallation(
          { identity: identity(), now: 1_000 },
          (() => ({
            get then(): never {
              throw sentinelCasMismatch;
            },
          })) as unknown as RelayAuthorityBeforeMutation,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect((caught as RelayAuthorityMutationError).cause).toBe(sentinelCasMismatch);
      expect(store.readInstallation()).toBeNull();
    });

    it("callback戻り値のthen getterが内側で再入し、そのエラーを握り潰して非関数を返してもMUTATION_UNCERTAINになりDBは不変", () => {
      const innerSpy = vi.fn();
      let caught: unknown;
      try {
        store.adoptInstallation(
          { identity: identity(), now: 1_000 },
          (() => ({
            get then(): unknown {
              try {
                store.advanceHostEpoch(
                  { expectedInstallation: { ...identity(), hostEpoch: 1, authorityRevision: 1 }, now: 1_000 },
                  innerSpy,
                );
              } catch {
                // getter自身が再入エラーを握り潰して非関数を返す
              }
              return "not-a-function";
            },
          })) as unknown as RelayAuthorityBeforeMutation,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect(innerSpy).not.toHaveBeenCalled();
      expect(store.readInstallation()).toBeNull();
    });

    it("再入試行はinputがnull/getter付きでも共通guardが先に拒否し、入力を一度も読まない", () => {
      const identityGetterSpy = vi.fn();
      const hostileInput = {
        get identity() {
          identityGetterSpy();
          return identity();
        },
        now: 1_000,
      };
      const innerSpy = vi.fn();
      let caught: unknown;
      try {
        store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
          store.adoptInstallation(hostileInput as unknown as RelayAdoptInstallationInput, innerSpy);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
      expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
      expect(identityGetterSpy).not.toHaveBeenCalled();
      expect(innerSpy).not.toHaveBeenCalled();
      expect(store.readInstallation()).toBeNull();
    });

    const REENTRANT_MALFORMED_MUTATION_ATTEMPTS: ReadonlyArray<{
      name: string;
      call: (targetStore: SqliteKanbanStore, innerSpy: RelayAuthorityBeforeMutation) => void;
    }> = [
      {
        name: "adoptInstallation(null)",
        call: (s, spy) => s.adoptInstallation(null as unknown as RelayAdoptInstallationInput, spy),
      },
      {
        name: "advanceHostEpoch({expectedInstallation:null})",
        call: (s, spy) =>
          s.advanceHostEpoch(
            { expectedInstallation: null, now: 1_000 } as unknown as RelayAdvanceHostEpochInput,
            spy,
          ),
      },
      {
        name: "issueRegistrationClaim(undefined)",
        call: (s, spy) => s.issueRegistrationClaim(undefined as unknown as RelayIssueRegistrationClaimInput, spy),
      },
      {
        name: "activateRegistration({claimId:123})",
        call: (s, spy) =>
          s.activateRegistration({ claimId: 123 } as unknown as RelayActivateRegistrationInput, spy),
      },
      {
        name: "retireRegistration(NaN)",
        call: (s, spy) => s.retireRegistration(Number.NaN as unknown as RelayRetireRegistrationInput, spy),
      },
    ];

    it.each(REENTRANT_MALFORMED_MUTATION_ATTEMPTS)(
      "callback内で不正input $name を再入してもguardで拒否され、外側rollback・予約callback1・内側callback0",
      ({ call }) => {
        const outerSpy = vi.fn();
        const innerSpy = vi.fn();
        let caught: unknown;
        try {
          store.adoptInstallation({ identity: identity(), now: 1_000 }, () => {
            outerSpy();
            try {
              call(store, innerSpy);
            } catch {
              // callbackが再入エラーを握り潰して正常に復帰しても、外側はlatchでfatalにする
            }
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(RelayAuthorityMutationError);
        expect((caught as RelayAuthorityMutationError).code).toBe("MUTATION_UNCERTAIN");
        expect(outerSpy).toHaveBeenCalledTimes(1);
        expect(innerSpy).not.toHaveBeenCalled();
        expect(store.readInstallation()).toBeNull();
      },
    );
  });

  // ---------------------------------------------------------------------
  // mutation input snapshot契約: callback内でのinput書換えから隔離する（review2707対応）
  // ---------------------------------------------------------------------
  describe("mutation input snapshot契約", () => {
    it("adoptInstallationはcallback内でidentity/nowを書き換えても元のsnapshotだけをcommitする", () => {
      interface MutableAdoptInput {
        identity: RelayAuthorityIdentity;
        now: number;
      }
      const mutableInput: MutableAdoptInput = { identity: identity(), now: 1_000 };
      const originalAdoptionId = mutableInput.identity.adoptionId;
      const originalHostIdentity = mutableInput.identity.hostIdentity;

      const installation = store.adoptInstallation(mutableInput, () => {
        mutableInput.identity = {
          ...mutableInput.identity,
          adoptionId: makeHex(64, "tampered-adoption"),
          hostIdentity: makeHex(64, "tampered-host"),
        };
        mutableInput.now = 999_999;
      });

      expect(installation.adoptionId).toBe(originalAdoptionId);
      expect(installation.hostIdentity).toBe(originalHostIdentity);
      const persisted = store.readInstallation();
      expect(persisted?.adoptionId).toBe(originalAdoptionId);
      expect(persisted?.hostIdentity).toBe(originalHostIdentity);
    });

    it("issueRegistrationClaimはcallback内でcandidate/claimSecretHash/nowを書き換えても元のsnapshotだけをcommitする", () => {
      const { installation } = adopt();
      const originalSecretHash = makeSecret("secret-a");
      const inputSecretHash = Buffer.from(originalSecretHash);
      const mutableInput: RelayIssueRegistrationClaimInput = {
        expectedInstallation: installation,
        candidate: candidate(),
        purpose: "initial",
        nativeEvidenceDigest: makeHex(64, "evidence-a"),
        nativeObservedAt: 1_000,
        claimId: makeHex(64, "claim-a"),
        claimSecretHash: inputSecretHash,
        expiresAt: 1_060,
        expectedPreviousRegistration: null,
        now: 1_000,
      };

      const claim = store.issueRegistrationClaim(mutableInput, () => {
        (mutableInput as { candidate: RegisterRelayInput }).candidate = {
          ...mutableInput.candidate,
          sessionId: "tampered-session",
          relayId: makeHex(64, "tampered-relay"),
        };
        (mutableInput as { now: number }).now = 999_999;
        const originalByte = inputSecretHash[0] ?? 0;
        inputSecretHash[0] = (originalByte + 1) % 256;
        // expectedInstallation/expectedPreviousRegistrationはCAS/purpose検査が既にpre-callbackで
        // 済んでいるため、callback内で書き換えても以後まったく再読されないことを示す。
        (mutableInput as { expectedInstallation: RelayExpectedInstallation }).expectedInstallation = {
          boardInstanceId: makeHex(32, "tampered-board"),
          adoptionId: makeHex(64, "tampered-adoption"),
          hostIdentity: makeHex(64, "tampered-host"),
          hostEpoch: 999,
          authorityRevision: 999,
        };
        (mutableInput as { expectedPreviousRegistration: RelayOwnerFence | null }).expectedPreviousRegistration = {
          ...candidate(),
          fencingToken: 999,
        };
      });

      expect(claim.sessionId).toBe("session-a");
      expect(claim.relayId).toBe(makeHex(64, "relay-a"));
      expect(claim.issuedAt).toBe(1_000);
      expect(store.readSessionAuthority("tampered-session")).toBeNull();
      expect(store.readSessionAuthority("session-a")).not.toBeNull();

      // DBには改竄前のsecretだけがcommitされている（改竄後のhashでは一致しない）。
      const spyTampered = vi.fn();
      expect(() =>
        store.activateRegistration(
          { expectedInstallation: store.readInstallation() as RelayAuthorityInstallation, claimId: claim.claimId, claimSecretHash: inputSecretHash, now: 1_010 },
          spyTampered,
        ),
      ).toThrowError(expect.objectContaining({ code: "CLAIM_SECRET_MISMATCH" }));
      expect(spyTampered).not.toHaveBeenCalled();

      const activated = store.activateRegistration(
        { expectedInstallation: store.readInstallation() as RelayAuthorityInstallation, claimId: claim.claimId, claimSecretHash: originalSecretHash, now: 1_020 },
        vi.fn(),
      );
      expect(activated.owner.sessionId).toBe("session-a");
    });
  });

  // ---------------------------------------------------------------------
  // overflow: 副作用0で予約前拒否
  // ---------------------------------------------------------------------
  describe("overflow検査（副作用0）", () => {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;

    function seedInstallationRevision(revision: number): void {
      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE relay_authority_installation SET authority_revision = ? WHERE singleton = 1`).run(revision);
      raw.close();
      store = new SqliteKanbanStore(dbPath);
    }

    it("installation.authorityRevisionがMAX_SAFE_INTEGERならadvanceHostEpochはOVERFLOWで側作用0（global）", () => {
      const { installation } = adopt();
      seedInstallationRevision(MAX_SAFE);
      const overflowedExpected: RelayExpectedInstallation = { ...installation, authorityRevision: MAX_SAFE };
      const spy = vi.fn();
      expect(() => store.advanceHostEpoch({ expectedInstallation: overflowedExpected, now: 2_000 }, spy)).toThrowError(
        expect.objectContaining({ code: "OVERFLOW" }),
      );
      expect(spy).not.toHaveBeenCalled();
      const after = store.readInstallation();
      expect(after?.authorityRevision).toBe(MAX_SAFE);
      expect(after?.hostEpoch).toBe(1);
    });

    it("installation.hostEpochがMAX_SAFE_INTEGERならadvanceHostEpochはOVERFLOWで側作用0（epoch）", () => {
      const { installation } = adopt();
      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE relay_authority_installation SET host_epoch = ? WHERE singleton = 1`).run(MAX_SAFE);
      raw.close();
      store = new SqliteKanbanStore(dbPath);

      const overflowedExpected: RelayExpectedInstallation = { ...installation, hostEpoch: MAX_SAFE };
      const spy = vi.fn();
      expect(() => store.advanceHostEpoch({ expectedInstallation: overflowedExpected, now: 2_000 }, spy)).toThrowError(
        expect.objectContaining({ code: "OVERFLOW" }),
      );
      expect(spy).not.toHaveBeenCalled();
      const after = store.readInstallation();
      expect(after?.hostEpoch).toBe(MAX_SAFE);
      expect(after?.authorityRevision).toBe(1);
    });

    it("session.revisionがMAX_SAFE_INTEGERならissueRegistrationClaim(restart)はOVERFLOWで側作用0（session）", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000 });
      const activated = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );

      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE relay_session_authorities SET revision = ? WHERE session_id = 'session-a'`).run(MAX_SAFE);
      raw.close();
      store = new SqliteKanbanStore(dbPath);

      const before = counts();
      const spy = vi.fn();
      expect(() =>
        store.issueRegistrationClaim(
          {
            expectedInstallation: retireResult.installation,
            candidate: candidate({ relayId: makeHex(64, "relay-session-overflow") }),
            purpose: "restart",
            nativeEvidenceDigest: makeHex(64, "evidence-session-overflow"),
            nativeObservedAt: 1_030,
            claimId: makeHex(64, "claim-session-overflow"),
            claimSecretHash: makeSecret("secret-session-overflow"),
            expiresAt: 1_090,
            expectedPreviousRegistration: activated.owner,
            now: 1_030,
          },
          spy,
        ),
      ).toThrowError(expect.objectContaining({ code: "OVERFLOW" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
      expect(store.readSessionAuthority("session-a")?.revision).toBe(MAX_SAFE);
    });

    it("claim.claimRevisionがMAX_SAFE_INTEGERならretireRegistrationはOVERFLOWで側作用0（claim）", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000 });
      const activated = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);

      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE relay_registration_claims SET claim_revision = ? WHERE claim_id = ?`).run(
        MAX_SAFE,
        first.claimId,
      );
      raw.close();
      store = new SqliteKanbanStore(dbPath);

      const before = counts();
      const spy = vi.fn();
      expect(() =>
        store.retireRegistration(
          {
            expectedInstallation: activated.installation,
            owner: activated.owner,
            expectedClaimRevision: MAX_SAFE,
            reason: "normal_shutdown",
            drainEvidenceDigest: null,
            drainedAt: null,
            now: 1_020,
          },
          spy,
        ),
      ).toThrowError(expect.objectContaining({ code: "OVERFLOW" }));
      expect(spy).not.toHaveBeenCalled();
      expect(counts()).toEqual(before);
      const claimAfter = store.readRegistrationClaim(first.claimId);
      expect(claimAfter?.state).toBe("active");
      expect(claimAfter?.claimRevision).toBe(MAX_SAFE);
    });

    it("session.fencingTokenHwmがMAX_SAFE_INTEGERならactivateRegistrationはOVERFLOWで側作用0", () => {
      const { installation } = adopt();
      const first = issue(installation, { now: 1_000 });
      const activated = activate(first.installation, first.claimId, first.claimSecretHash, 1_010);
      const retireResult = store.retireRegistration(
        {
          expectedInstallation: activated.installation,
          owner: activated.owner,
          expectedClaimRevision: 2,
          reason: "normal_shutdown",
          drainEvidenceDigest: null,
          drainedAt: null,
          now: 1_020,
        },
        vi.fn(),
      );
      const restartClaim = issue(retireResult.installation, {
        purpose: "restart",
        candidateOverrides: { relayId: makeHex(64, "relay-overflow") },
        expectedPreviousRegistration: activated.owner,
        claimIdLabel: "claim-overflow",
        now: 1_030,
      });

      store.close();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE relay_session_authorities SET fencing_token_hwm = ? WHERE session_id = 'session-a'`).run(
        MAX_SAFE,
      );
      raw.prepare(
        `UPDATE relay_registration_claims SET expected_fencing_token_hwm = ? WHERE claim_id = ?`,
      ).run(MAX_SAFE, restartClaim.claimId);
      raw.close();
      store = new SqliteKanbanStore(dbPath);

      const spy = vi.fn();
      expect(() =>
        store.activateRegistration(
          {
            expectedInstallation: restartClaim.installation,
            claimId: restartClaim.claimId,
            claimSecretHash: restartClaim.claimSecretHash,
            now: 1_040,
          },
          spy,
        ),
      ).toThrowError(expect.objectContaining({ code: "OVERFLOW" }));
      expect(spy).not.toHaveBeenCalled();
      expect(store.readRegistrationClaim(restartClaim.claimId)?.state).toBe("issued");
      expect(store.readSessionAuthority("session-a")?.fencingTokenHwm).toBe(MAX_SAFE);
    });
  });

  // ---------------------------------------------------------------------
  // row mapper: fail-closed（state別nullable整合・drain整合・canonical URL）
  // ---------------------------------------------------------------------
  describe("mapRelayRegistrationClaimRow: fail-closed", () => {
    function baseClaimRow(overrides: Partial<RawRelayRegistrationClaimRow> = {}): RawRelayRegistrationClaimRow {
      return {
        claim_id: makeHex(64, "row-claim"),
        session_id: "session-row",
        relay_id: makeHex(64, "row-relay"),
        provider_session_id: "provider-session-row",
        provider: "codex",
        canonical_server_url: "http://127.0.0.1:3456",
        host: "host-row",
        even_terminal_boot_epoch: "boot-row",
        native_evidence_digest: makeHex(64, "row-evidence"),
        handover_generation: 1,
        host_epoch: 1,
        native_observed_at: 1_000,
        claim_secret_hash: makeSecret("row-secret"),
        purpose: "initial",
        expected_fencing_token_hwm: null,
        expected_max_handover_generation: null,
        expected_session_revision: 1,
        state: "active",
        assigned_fencing_token: 1,
        claim_revision: 2,
        issued_at: 1_000,
        expires_at: 1_060,
        consumed_at: 1_010,
        retired_at: null,
        cancelled_at: null,
        termination_reason: null,
        drain_evidence_digest: null,
        drained_at: null,
        ...overrides,
      };
    }

    function issuedRow(overrides: Partial<RawRelayRegistrationClaimRow> = {}): RawRelayRegistrationClaimRow {
      return baseClaimRow({
        state: "issued",
        assigned_fencing_token: null,
        consumed_at: null,
        retired_at: null,
        cancelled_at: null,
        termination_reason: null,
        ...overrides,
      });
    }

    function activeRow(overrides: Partial<RawRelayRegistrationClaimRow> = {}): RawRelayRegistrationClaimRow {
      return baseClaimRow({
        state: "active",
        assigned_fencing_token: 1,
        consumed_at: 1_010,
        retired_at: null,
        cancelled_at: null,
        termination_reason: null,
        ...overrides,
      });
    }

    function retiredRow(overrides: Partial<RawRelayRegistrationClaimRow> = {}): RawRelayRegistrationClaimRow {
      return baseClaimRow({
        state: "retired",
        assigned_fencing_token: 1,
        consumed_at: 1_010,
        retired_at: 1_020,
        cancelled_at: null,
        termination_reason: "normal_shutdown",
        drain_evidence_digest: null,
        drained_at: null,
        ...overrides,
      });
    }

    function cancelledRow(overrides: Partial<RawRelayRegistrationClaimRow> = {}): RawRelayRegistrationClaimRow {
      return baseClaimRow({
        state: "cancelled",
        assigned_fencing_token: null,
        consumed_at: null,
        retired_at: null,
        cancelled_at: 1_020,
        termination_reason: "expired",
        drain_evidence_digest: null,
        drained_at: null,
        ...overrides,
      });
    }

    it("issued/active/retired/cancelledの正しいbaselineはfail-closedにならない", () => {
      expect(() => mapRelayRegistrationClaimRow(issuedRow())).not.toThrow();
      expect(() => mapRelayRegistrationClaimRow(activeRow())).not.toThrow();
      expect(() => mapRelayRegistrationClaimRow(retiredRow())).not.toThrow();
      expect(() => mapRelayRegistrationClaimRow(cancelledRow())).not.toThrow();
      expect(() =>
        mapRelayRegistrationClaimRow(
          retiredRow({
            termination_reason: "handoff_drained",
            drain_evidence_digest: makeHex(64, "drain-row"),
            drained_at: 1_025,
          }),
        ),
      ).not.toThrow();
    });

    it("issuedでassigned_fencing_tokenが非NULLだとfail-closed", () => {
      expect(() => mapRelayRegistrationClaimRow(issuedRow({ assigned_fencing_token: 1 }))).toThrow();
    });

    it("activeでconsumed_atがNULLだとfail-closed", () => {
      expect(() => mapRelayRegistrationClaimRow(activeRow({ consumed_at: null }))).toThrow();
    });

    it("retiredでtermination_reasonがNULLだとfail-closed", () => {
      expect(() => mapRelayRegistrationClaimRow(retiredRow({ termination_reason: null }))).toThrow();
    });

    it("cancelledでcancelled_atがNULLだとfail-closed", () => {
      expect(() => mapRelayRegistrationClaimRow(cancelledRow({ cancelled_at: null }))).toThrow();
    });

    it("cancelledでassigned_fencing_tokenが非NULLだとfail-closed", () => {
      expect(() => mapRelayRegistrationClaimRow(cancelledRow({ assigned_fencing_token: 1 }))).toThrow();
    });

    it("termination_reasonがhandoff_drainedなのにdrain_evidence_digestがNULLだとfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(retiredRow({ termination_reason: "handoff_drained", drained_at: 1_025 })),
      ).toThrow();
    });

    it("termination_reasonがhandoff_drained以外なのにdrain_evidence_digestが非NULLだとfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(retiredRow({ drain_evidence_digest: makeHex(64, "drain-row") })),
      ).toThrow();
    });

    it("canonical化されていないserver URL（末尾スラッシュ）はfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(activeRow({ canonical_server_url: "http://127.0.0.1:3456/" })),
      ).toThrow();
    });

    it("正常な32byte claim_secret_hash（Buffer）はfail-closedにならない", () => {
      expect(() => mapRelayRegistrationClaimRow(activeRow({ claim_secret_hash: makeSecret("ok-secret") }))).not.toThrow();
    });

    it("正常な32byte claim_secret_hash（生Uint8Array）はfail-closedにならない", () => {
      const plain = new Uint8Array(makeSecret("ok-secret-plain"));
      expect(() => mapRelayRegistrationClaimRow(activeRow({ claim_secret_hash: plain }))).not.toThrow();
    });

    it("claim_secret_hashが1byteだとfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(activeRow({ claim_secret_hash: Buffer.from([0x01]) })),
      ).toThrow();
    });

    it("claim_secret_hashがNULLだとfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(activeRow({ claim_secret_hash: null as unknown as Uint8Array })),
      ).toThrow();
    });

    it("claim_secret_hashがtext（64hex文字列）だとfail-closed（digest長64とBLOB長32を混同しない）", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(
          activeRow({ claim_secret_hash: makeHex(64, "row-secret-as-text") as unknown as Uint8Array }),
        ),
      ).toThrow();
    });

    it("claim_secret_hashが不正型（number）だとfail-closed", () => {
      expect(() =>
        mapRelayRegistrationClaimRow(activeRow({ claim_secret_hash: 12345 as unknown as Uint8Array })),
      ).toThrow();
    });
  });

  describe("readRegistrationClaim: 実DBで壊れたclaim_secret_hash行はfail-closed", () => {
    /**
     * claim_secret_hash BLOB列のCHECK/NOT NULL制約をこのtableだけ限定的に無効化し
     * （sqlite_masterのCREATE TABLE文を直接relax）、正規のissueRegistrationClaimでは
     * 作れない壊れた行を作って、row mapper自身のfail-closedをDB制約経由ではなく
     * 直接証明する。
     */
    function relaxClaimSecretHashConstraint(): void {
      const raw = new Database(dbPath);
      raw.unsafeMode(true);
      raw.pragma("writable_schema = 1");
      const tableRow = raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'relay_registration_claims'`)
        .get() as { sql: string };
      const relaxedSql = tableRow.sql.replace(
        `claim_secret_hash BLOB NOT NULL CHECK(typeof(claim_secret_hash) = 'blob' AND length(claim_secret_hash) = 32)`,
        `claim_secret_hash BLOB`,
      );
      if (relaxedSql === tableRow.sql) {
        throw new Error("claim_secret_hashのCREATE TABLE文言が変わっており、テスト用relaxが当たっていません");
      }
      raw
        .prepare(`UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'relay_registration_claims'`)
        .run(relaxedSql);
      raw.pragma("writable_schema = 0");
      raw.unsafeMode(false);
      raw.close();
      // sqlite_masterの書換えは既存connectionのin-memory schemaへ反映されないため、
      // 一度close/reopenしてschemaを再読込させる（このraw connection自体を使い回さない）。
    }

    it("1byteに壊れたclaim_secret_hash行はreadRegistrationClaimがthrowする", () => {
      const { installation } = adopt();
      const { claimId } = issue(installation, { now: 1_000 });
      store.close();
      relaxClaimSecretHashConstraint();
      const raw = new Database(dbPath);
      raw
        .prepare(`UPDATE relay_registration_claims SET claim_secret_hash = ? WHERE claim_id = ? COLLATE BINARY`)
        .run(Buffer.from([0x01]), claimId);
      raw.close();
      store = new SqliteKanbanStore(dbPath);
      expect(() => store.readRegistrationClaim(claimId)).toThrow();
    });

    it("NULLに壊れたclaim_secret_hash行はreadRegistrationClaimがthrowする", () => {
      const { installation } = adopt();
      const { claimId } = issue(installation, { now: 1_000 });
      store.close();
      relaxClaimSecretHashConstraint();
      const raw = new Database(dbPath);
      raw
        .prepare(`UPDATE relay_registration_claims SET claim_secret_hash = NULL WHERE claim_id = ? COLLATE BINARY`)
        .run(claimId);
      raw.close();
      store = new SqliteKanbanStore(dbPath);
      expect(() => store.readRegistrationClaim(claimId)).toThrow();
    });

    it("TEXT型に壊れたclaim_secret_hash行はreadRegistrationClaimがthrowする", () => {
      const { installation } = adopt();
      const { claimId } = issue(installation, { now: 1_000 });
      store.close();
      relaxClaimSecretHashConstraint();
      const raw = new Database(dbPath);
      raw
        .prepare(`UPDATE relay_registration_claims SET claim_secret_hash = ? WHERE claim_id = ? COLLATE BINARY`)
        .run(makeHex(64, "text-secret"), claimId);
      raw.close();
      store = new SqliteKanbanStore(dbPath);
      expect(() => store.readRegistrationClaim(claimId)).toThrow();
    });
  });
});
