# コントリビュートについて

hachi-kanban は作者個人のローカル運用のために作られた実験的なプロジェクトです。
コントリビュートは歓迎しますが、**大きな変更は必ず先に Issue で相談してください**。
方向性が合わない PR は、内容が良くてもクローズすることがあります。
応答の速さは約束できません。

## Issue の出し方

### バグ報告

次の情報があると再現できます。

- 何をしたか（実行したコマンド、board の状態）
- 期待した挙動と実際の挙動
- 環境: OS、Node.js のバージョン（`node -v`）、pnpm のバージョン（`pnpm -v`）
- transport（`direct` / `bridge`）
- `hachi doctor --offline` の出力

**ログや設定を貼る前に、認証情報を必ず取り除いてください。**
bridge token、API キー、provider のセッション ID、社内のホスト名・
個人情報などを貼らないようにお願いします。

脆弱性は Issue ではなく、[`SECURITY.md`](SECURITY.md) の手順で報告してください。

### 機能提案・仕様の議論

仕様の正本は [`docs/contract.md`](docs/contract.md) です。
状態機械、データモデル、policy、不変条件はすべてここで定義されており、
実装が contract と食い違っていれば実装がバグです。

そのため、**挙動の変更を伴う提案は contract の変更提案**になります。
contract を直接編集した PR を先に出すのではなく、まず Issue で
「現在の contract のどの節の、どの不変条件を、なぜ変えたいのか」を書いてください。
そのうえで実装方針を決めます。

## PR の出し方

1. Issue で方針を合わせる（typo 修正など自明なものは不要）
2. `main` からブランチを切る
3. 変更を入れて、下記の検証を通す
4. PR を出す。説明には、何を変えたか・なぜ変えたか・どう検証したかを書く

PR の粒度は小さくしてください。無関係な整形や依存更新を混ぜないでください。

## 開発の前提

pnpm workspace のモノレポです。

```bash
# 前提: Node.js 22.13 以上 / pnpm 10.17.1
pnpm install --frozen-lockfile
```

`pnpm install` は husky の Git hooks も設定します（root の `prepare` script）。

### 検証コマンド

root の `package.json` に定義されているものです。

```bash
pnpm typecheck                    # 全 package の tsc --noEmit
pnpm test                         # 全 package の vitest run + scripts/*.test.mjs
pnpm lint                         # eslint packages/*/src
pnpm --filter @hachi/web build    # Web 看板の vite build
```

CI（`.github/workflows/ci.yml`）はこの 4 つをこの順で実行します。
CI が使うのは Node.js 24 / ubuntu-latest です（ローカルの最小要件 22.13 とは別）。
PR を出す前にローカルで 4 つすべて通してください。

`pnpm test` は `--workspace-concurrency=1` で package を直列に実行します。
実プロセス・実ファイルシステムを使うテストがあるため、
並列化すると相互干渉して落ちます。**フルスイートを複数同時に走らせないでください。**

個別の package だけ回す場合は、その package 内で vitest を直接実行するのが確実です。

```bash
pnpm --filter @hachi/core run test
```

### Git hooks

- **pre-commit**: `pnpm -r typecheck` と、staged な TypeScript への `eslint --fix`
- **pre-push**: `pnpm test`（フルスイート）

どちらも `HUSKY=0` で skip できますが、常用しないでください。
skip した場合は push 前にフルスイートを別途通してください。

## コーディング規約

### 全般

- **コメントとドキュメントは日本語で書く。** このリポジトリのドキュメントは日本語が正本です
- 識別子（変数名・関数名・型名）は英語。camelCase / PascalCase
- インデントは 2 スペース
- 行末セミコロンあり
- 文字列は二重引用符

### TypeScript

ESLint の flat config（`eslint.config.mjs`）は
`typescript-eslint` の recommended に加えて、次を **error** にしています。

- `@typescript-eslint/no-explicit-any` — `any` は使わない。
  型が定まらない箇所は `unknown` で受けて絞り込む
- `@typescript-eslint/explicit-function-return-type`（`allowExpressions: true`）—
  関数宣言・メソッドには戻り値型を明示する

その他の実装上の約束。

- ES modules（全 package が `"type": "module"`）。CommonJS は使わない
- 実行時のスキーマ検証は `zod`。外部入力（config、provider の出力、
  HTTP リクエスト）はスキーマで検証してから型付きの値として扱う
- SQLite への書き込みは `@hachi/core` の `KanbanDb` 経由に限る
  （`docs/contract.md` §5 の単一書込パス原則）。生の `better-sqlite3` で
  board DB を書き換えない
- 新しい状態遷移やイベント種別を足す場合は、`docs/contract.md` の定義と
  実装をセットで変更する

### テスト

- テストランナーは vitest（`scripts/` 配下のみ `node --test`）
- 挙動を変える PR にはテストを添えてください
- 状態機械に関わる変更は、遷移が拒否されるケース（negative case）も書いてください

## ライセンス

PR を出した時点で、その内容が MIT License（[`LICENSE`](LICENSE)）の下で
配布されることに同意したものとみなします。
