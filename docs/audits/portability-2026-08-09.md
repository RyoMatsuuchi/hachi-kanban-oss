# Portability audit — 2026-08-09

## 結論

監査時点では、別の利用者が GitHub から現行 hachi-kanban を pull して使うことはできない。

- local `main`: `59b60d39edfb0cadc745574c5a5f2afba7339f44`
- `origin/main`: `785310b680a7f76ed32f7b97bef81819569dd5fa`
- relation: local が 112 commits ahead、0 behind
- remote repository: private、default branch `main`
- collaborator: repository owner のみ、pending invitation なし
- remote branch / PR / tag / release: `main` 1本、PR・tag・release なし

fresh clone は remote SHA になり、local で追加済みの `bin/hachi` と orchestrator command を含まない。
remote の旧 SHA に対する CI success は、未公開 112 commits の検証証拠ではない。

## remoteへ公開するだけでは残る変更前の導入差分

- 4つの LaunchAgent template と Raycast script が特定ユーザー・clone path・pnpm path を固定
- 既定 profile が repository 外の even-terminal bridge と token path を前提
- setup / config init / CLI symlink installer が無い
- README が source 開発手順のみで、Node/pnpm/provider auth/transport/state separation を説明しない
- full doctor が direct-only config でも未使用 bridge を検査する
- macOS clean-clone / minimum Node / plist render の CI が無い

## この変更で扱う範囲

- direct-first の fail-closed setup
- private state permission と config example
- portable CLI Node override
- path を埋め込まない LaunchAgent template + renderer
- active profile transport に基づく doctor
- install / environment / state separation の文書化
- native same-provider messaging の design（delivery planeのみ。未実装）

## この変更だけでは完了しない範囲

- remote への push、PR、merge、access grant
- 同一 SQLite board の複数端末共有
- even-terminal / G2 appliance の配布
- provider account、model entitlement、OAuth/login の配布
- production state の移行

上記はそれぞれ explicit authorization、別のarchitecture、または利用者自身の認証が必要である。
