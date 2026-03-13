# HomeGuard 詳細仕様書

## 1. 概要

HomeGuard は、VS Code において `$HOME` 直下全体を workspace として開くことに起因する情報露出、誤操作、拡張機能による過剰走査、不要な外部送信のリスクを低減するための軽量セキュリティ支援ツールである。

ただし、実害の観点では情報露出だけでなく、破壊的削除、誤コミット、誤公開、誤実行のほうが深刻になりうる。したがって本仕様は、`open` を入口としつつ、将来的には workspace 全体に対する危険操作ガードへ拡張する前提を持つ。

本ツールは次の 2 系統で構成する。

1. **CLI ラッパー**

   * `code ~`
   * `code $HOME`
   * `cd ~ && code .`
   * `code /absolute/path/to/home`
     を検知し、警告または安全な退避先への誘導を行う。
2. **VS Code 拡張**

   * GUI からの `Open Folder...`
   * 起動済み workspace への folder 追加
   * multi-root workspace への混入
     を検知し、通知、除去、退避先誘導を行う。

加えて、拡張機能や VS Code 本体に対する **Privacy Hardening / Telemetry Audit** を補助機能として持つ。

---

## 2. 目的

### 2.1 主目的

* `$HOME` 全体を誤って開く操作を検知・抑止する。
* 秘密情報の可視化範囲を縮小する。
* `code .` 習慣による無自覚な home 直開きを防ぐ。
* ユーザーに安全な作業先を即時提示する。

### 2.2 副目的

* VS Code 利用時の privacy hardening を容易にする。
* telemetry 設定の監査と一括適用を支援する。
* 社内利用時の軽量なポリシー実装の土台を提供する。

---

## 3. 想定リスク

### 3.1 情報露出リスク

`$HOME` 配下には通常、以下が存在しうる。

* `~/.ssh/`
* `~/.gnupg/`
* `~/.aws/`
* `~/.config/gcloud/`
* `.env`
* `.npmrc`
* `.pypirc`
* `.netrc`
* 各種 token, credential, cookie, private key
* 個人文書、写真、業務メモ、履歴ファイル

これらが VS Code の file tree、全文検索、recent files、拡張機能の watcher、AI 補助機能などの対象となる。

### 3.2 誤操作リスク

* `code .` を home 上で実行
* 一括検索置換の誤爆
* Git の誤初期化、誤 add、誤 commit
* formatter / linter / rename の意図しない適用
* ターミナルの `rm`, `mv`, `chmod` の対象範囲拡大
* 他 repo への機密ファイル混入

### 3.3 破壊・公開リスク

以下は情報露出よりも優先して抑止すべき対象である。

* explorer / search / refactor からの大量削除
* save に伴う formatter / code action / organize imports の広範囲適用
* Git の `add`, `commit`, `push`, `publish` による誤公開
* task / debug / extension command / terminal からの破壊的スクリプト実行
* package publish や container / cloud deploy の誤起動
* AI 補助や自動化による意図しない一括変更

### 3.4 拡張機能・通信リスク

* telemetry
* usage report
* crash report
* language server による広範囲走査
* AI 拡張による context 収集
* remote / webview / helper binary による通信

---

## 4. 設計原則

1. **最終的に何を開こうとしているかで判定する。**

   * 引数の文字列ではなく解決後の実パスを見る。
2. **単純拒否より、安全な代替を提示する。**
3. **勝手に壊さない。**

   * 強制設定変更は管理モードに限定する。
4. **監査 → 提案 → 明示適用を基本とする。**
5. **CLI と GUI の両入口を塞ぐ。**
6. **危険操作は実行直前で止める。**
7. **小さい実装で高い実効性を狙う。**

---

## 5. システム構成

## 5.1 コンポーネント

### A. CLI ラッパー

役割:

* `code` コマンド実行時の事前検知
* ターミナルへの warning 表示
* 必要に応じた Escape Folder への自動リダイレクト

候補実装:

* shell script
* Node.js script
* small native wrapper

### B. VS Code 拡張

役割:

* 起動時 workspace の検査
* folder 追加時の検査
* warning message の表示
* workspace からの除去
* Escape Folder / Safe Folder の提示
* telemetry audit と privacy hardening
* save / task / terminal / git / publish 前後の安全チェック

### C. 設定ストア

* VS Code user settings
* workspace settings
* 拡張内部の known telemetry key table
* 変更前バックアップ

---

## 6. ユースケース

### 6.1 CLI からの home 直開き

```bash
code ~
code $HOME
code /Users/akira
```

期待動作:

* warning を表示
* policy に応じて以下のいずれかを実行

  * 続行
  * ブロック
  * Escape Folder へリダイレクト

### 6.2 `code .` 習慣

```bash
cd ~
code .
```

期待動作:

* `.` を実パス解決し `$HOME` と一致したら検知
* `Opening "." here is equivalent to opening "$HOME".` を表示
* Escape Folder / Safe Subfolder を提示

### 6.3 GUI からの Open Folder

期待動作:

* 拡張起動後の workspace を検査
* `$HOME` を検出したら warning 表示
* policy により自動除去または代替提示

### 6.4 Multi-root workspace

期待動作:

* 既存 workspace に `$HOME` が追加された場合も検知
* 当該 folder のみ除去可能

### 6.5 Privacy Hardening

期待動作:

* VS Code 本体と既知拡張の telemetry 関連設定を監査
* 変更候補を一覧表示
* one-click で適用
* rollback 可能

### 6.6 Workspace Safety Guard

期待動作:

* 危険な workspace では save, task, terminal, git, delete, publish を追加監視対象にする
* 実行前に risk summary と safer alternative を提示する
* policy に応じて warn / require confirmation / block を切り替える
* workspace trust とは別に、HomeGuard 独自の safety judgement を持つ

---

## 7. 判定仕様

## 7.1 正規化ルール

判定前に次を行う。

1. `~` を home path に展開
2. 環境変数を展開
3. `.` や `..` を解決
4. `realpath` により symlink を解決
5. Windows では case-insensitive 比較
6. 末尾スラッシュ差異を吸収

## 7.2 危険判定条件

以下のいずれかに該当したら **HomeOpenDetected** とみなす。

* 開こうとしている path の正規化結果が `homedir()` と一致
* `code .` 実行時に `PWD` の正規化結果が `homedir()` と一致
* multi-root で追加される folder が `homedir()` と一致

## 7.3 許可判定条件

以下は通常許可。

* `~/work/projectA`
* `~/src/foo`
* `~/.config/myapp`
* allowList に明示された path

## 7.4 高リスク補助判定

以下は optional warning 対象。

* `~/.ssh`
* `~/.gnupg`
* `~/.aws`
* `~/.config/gcloud`
* `~/Library`（macOS）
* `AppData`（Windows）

これらは home 全体ではないが高感度ディレクトリとして扱える。

---

## 8. ポリシーモード

### 8.1 Warn モード

* warning を表示する
* 開くこと自体は許可
* 初期導入向け

### 8.2 Redirect モード

* warning を表示
* Escape Folder へ自動遷移
* 個人利用の推奨既定

### 8.3 Block モード

* home 直開きを拒否
* Escape Folder または Safe Folder 選択のみ許可
* 社内配布向け

### 8.4 Audit-only モード

* 何も止めない
* ログと可視化のみ

---

## 9. Escape Folder 仕様

## 9.1 目的

* `$HOME` 直開き時の安全な退避先を提供する。
* 警告だけで作業が止まることを避ける。

## 9.2 種類

### Persistent Escape Folder

推奨既定:

```text
~/work/_escape
```

特徴:

* 継続作業向き
* 見失いにくい
* Git 管理へ移行しやすい
* 再起動後も残る

### Ephemeral Escape Folder

例:

```text
$TMPDIR/vscode-home-escape-<timestamp>
```

特徴:

* 単発の検証向き
* 破棄前提
* 継続作業には不向き

## 9.3 推奨既定

* 既定: Persistent Escape Folder
* オプション: Ephemeral Escape Folder

## 9.4 自動初期化

Persistent Escape Folder 作成時に以下を自動生成可能。

* `README.md`
* `.gitignore`
* `.homeguard.json`

README 例:

```md
# Escape Folder
This folder is used as a safe workspace when opening the entire home directory is blocked or redirected.
```

---

## 10. CLI ラッパー仕様

## 10.1 コマンド名

候補:

* `safe-code`
* `homeguard-code`
* `code` の wrapper alias

## 10.2 入力

* 引数列
* 環境変数
* 現在作業ディレクトリ `PWD`
* 実際の home directory

## 10.3 処理フロー

1. 引数を解釈
2. `code .` の場合は `PWD` を解決
3. すべての対象 path を正規化
4. home 直開き判定
5. policy に基づき分岐
6. 最終的に本物の `code` を exec

## 10.4 対応ケース

| 入力               | 判定   | 既定動作            |
| ---------------- | ---- | --------------- |
| `code ~`         | 危険   | redirect / warn |
| `code $HOME`     | 危険   | redirect / warn |
| `cd ~ && code .` | 危険   | redirect / warn |
| `code ~/work`    | 許可   | そのまま            |
| `code`           | 設定次第 | 通常はそのまま         |
| `code a b`       | 個別判定 | 危険 path のみ対処    |

## 10.5 メッセージ仕様

stderr 例:

```text
Warning: opening the entire home directory is risky.
Current target resolves to: /Users/akira
Consider opening a project subdirectory instead.
Redirecting to: /Users/akira/work/_escape
```

---

## 11. VS Code 拡張仕様

## 11.1 起動時チェック

対象イベント:

* `activate()`

処理:

* 現在の `workspaceFolders` を列挙
* 各 folder を正規化
* home 判定
* 該当時は通知

## 11.2 workspace 変更時チェック

対象イベント:

* `vscode.workspace.onDidChangeWorkspaceFolders`

処理:

* 追加された folder を走査
* home 判定
* policy に応じて除去 / 警告 / リダイレクト

## 11.3 通知 UI

想定ボタン:

* `Open Escape Folder`
* `Choose Safe Folder`
* `Remove from Workspace`
* `Keep Open Once`
* `Dismiss`

メッセージ例:

```text
You opened your home directory. This may expose secrets and increase accidental edits.
Open a subdirectory or use the Escape Folder instead.
```

## 11.4 Command Palette

提供コマンド候補:

* `HomeGuard: Open Escape Folder`
* `HomeGuard: Choose Safe Folder`
* `HomeGuard: Remove Home Folder from Workspace`
* `HomeGuard: Audit Telemetry Settings`
* `HomeGuard: Apply Privacy Hardening`
* `HomeGuard: Roll Back Privacy Hardening`

---

## 12. Privacy Hardening / Telemetry Audit 仕様

## 12.1 目的

* VS Code と既知拡張の設定ベース telemetry を監査する。
* 制御可能なものを一括で無効化する。
* 不明なものをユーザーに可視化する。

## 12.2 方針

* 強制既定ではなく `audit -> plan -> apply`
* rollback を提供
* unknown policy の拡張は別表示

## 12.3 対象

### A. VS Code 本体

* telemetry 関連設定
* crash report 関連設定

### B. 既知拡張

* 拡張ごとの既知 key table を持つ
* 例:

  * `*.enableTelemetry`
  * `*.telemetry.enabled`
  * `*.sendUsageData`

### C. 高通信拡張の補助表示

* AI assistant
* cloud sync
* remote helper
* language server

## 12.4 結果分類

* `Safe`: OFF 済み
* `Actionable`: OFF 可能
* `Unknown`: 設定不明
* `Risky`: 通信が強い可能性あり

## 12.5 適用仕様

* user settings へ反映
* 変更前のバックアップ保存
* 差分表示
* rollback コマンドで復元

## 12.6 限界

以下は保証しない。

* 非公開設定による通信停止
* 拡張内バイナリや webview の外部通信遮断
* 設定なしで埋め込まれた usage report の停止

従って本機能は「制御可能な telemetry の監査と抑制」である。

---

## 13. 設定項目案

```json
{
  "homeGuard.enable": true,
  "homeGuard.mode": "redirect",
  "homeGuard.escapeFolder": "~/work/_escape",
  "homeGuard.enableEphemeralEscape": true,
  "homeGuard.checkOnStartup": true,
  "homeGuard.checkOnWorkspaceFolderAdd": true,
  "homeGuard.cli.checkDotFromHome": true,
  "homeGuard.cli.redirectDotFromHomeToEscape": true,
  "homeGuard.allowList": [
    "~/work",
    "~/projects",
    "~/.config/myapp"
  ],
  "homeGuard.highRiskFolders": [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud"
  ],
  "homeGuard.safety.enableSaveGuard": true,
  "homeGuard.safety.enableGitGuard": true,
  "homeGuard.safety.enableTerminalGuard": true,
  "homeGuard.safety.enableTaskGuard": true,
  "homeGuard.safety.enableDeleteGuard": true,
  "homeGuard.safety.enablePublishGuard": true,
  "homeGuard.safety.requireConfirmationForDestructiveActions": true,
  "homeGuard.safety.blockHighRiskPublish": true,
  "homeGuard.privacy.auditOnStartup": false,
  "homeGuard.privacy.offerHardening": true,
  "homeGuard.privacy.knownTelemetryProfile": "default",
  "homeGuard.privacy.backupBeforeApply": true
}
```

---

## 14. ログと状態管理

## 14.1 ログ方針

* 既定でローカルのみ
* telemetry は本ツール自身でも送信しない方針を推奨
* イベントログは最小限

## 14.2 保存候補

* extension globalState
* local JSON log file
* output channel

## 14.3 記録対象

* home 直開き検知回数
* redirect 発生回数
* hardening 適用内容
* rollback 実行履歴

機微情報を避けるため、完全 path の永続保存は optional にする。

---

## 15. セキュリティ要件

1. 本ツール自身は外部通信しないことを既定とする。
2. telemetry は既定で無効とする。
3. path 判定は正規化後に行う。
4. symlink 迂回を考慮する。
5. settings 書換時はバックアップを取る。
6. rollback を提供する。
7. Escape Folder 作成時に過度な権限変更を行わない。
8. 破壊的操作や公開操作は、可能な限り実行直前に再判定する。
9. terminal / task / git / publish のガードは誤検知より見逃し低減を優先する。

---

## 16. 非機能要件

### 16.1 軽量性

* activate 後の処理は小さく保つ
* path 判定は O(number of folders)
* 常時 watcher の追加は最小限

### 16.2 可搬性

対応対象:

* macOS
* Linux
* Windows

### 16.3 保守性

* known telemetry key table を外部 JSON 化可能にする
* path normalization を共通 utility に集約

### 16.4 可観測性

* Output Channel を用意
* verbose mode で判定過程を出せるようにする

---

## 17. エラーハンドリング

### 17.1 Escape Folder 作成失敗

動作:

* error message 表示
* fallback として `Choose Folder` を提示

### 17.2 realpath 解決失敗

動作:

* 失敗を warning として扱う
* 解決可能な範囲で比較
* verbose log に記録

### 17.3 settings 書換失敗

動作:

* 部分適用を明示
* rollback 不可時はその旨表示

---

## 18. 画面・文言案

### 18.1 Home 直開き警告

```text
You opened your home directory.
This may expose secrets and increase accidental edits.
Use a subdirectory or the Escape Folder instead.
```

### 18.2 `code .` 特化警告

```text
Current directory is your home directory.
Opening "." here is equivalent to opening your entire home.
```

### 18.3 Hardening 提案

```text
Privacy hardening options are available for VS Code and installed extensions.
Review and apply the suggested changes.
```

---

## 19. MVP 範囲

### 19.1 MVP に含める

* CLI ラッパー
* `code ~`, `code $HOME`, `code .` from home 検知
* VS Code 起動時チェック
* folder 追加時チェック
* warning message
* Escape Folder への誘導
* 基本設定項目
* save / git / terminal / task / delete / publish へ広げるための policy モデルと command surface 定義

### 19.2 MVP から外す

* 全拡張の網羅的 telemetry 制御
* 複雑な policy engine
* remote/container 固有最適化
* org 配布用の集中管理機能
* 全ターミナル入力の完全インターセプト
* すべての外部 CLI / publish provider の網羅対応

---

## 20. 将来拡張

1. 高感度ディレクトリ単位の警告
2. Git 初期化や add / commit / push / publish の安全ガード
3. save / refactor / delete の実行前プレビューと require-confirmation
4. task / terminal / debug 実行の危険コマンド検知
5. AI 拡張向け context-scope hardening
6. 組織配布用 policy profile
7. known telemetry profile の自動更新
8. path risk score 表示
9. safe workspace launcher
10. 製品名を Workspace Safety Guard に拡張する再設計

## 20.1 製品進化の方向

HomeGuard は「home directory を開かない」ための名前と設計を持つが、実際に守りたいのは workspace 上の危険操作全般である。

このため製品としては、次の段階で **Workspace Safety Guard** に進化できる。

* 第1段階: home 直開き検知と escape folder
* 第2段階: save / git / terminal / task / delete / publish の safety hooks
* 第3段階: policy, audit, rollback, org profile を含む workspace-wide safety platform

---

## 21. 実装優先順位

### Phase 1

* path normalization utility
* CLI wrapper
* VS Code startup / folder-add detection
* Escape Folder support

### Phase 2

* UI polish
* allowList / denyList
* output channel
* backup / rollback

### Phase 3

* telemetry audit
* privacy hardening apply
* known key table 拡張

---

## 22. 受け入れ条件

1. `code ~` で警告が出ること。
2. `cd ~ && code .` で警告が出ること。
3. GUI から `$HOME` を開いた場合に拡張が通知すること。
4. redirect モードで Escape Folder が開くこと。
5. allowList 配下は通常通り開けること。
6. telemetry audit が既知設定を列挙できること。
7. hardening 適用前にバックアップが作られること。

---

## 23. まとめ

HomeGuard は、`$HOME` 直開きという小さく見えるが実害の大きい操作に対して、CLI と VS Code 拡張の二段構えで対処する軽量セキュリティツールである。

本ツールの中核は、危険な引数の検出ではなく、**最終的に何を開こうとしているかの判定** にある。また、単なる禁止ではなく、Escape Folder と Privacy Hardening により、作業継続性と実用性を保ちながら安全性を高める点に価値がある。

さらに次段階では、open の防止に留まらず、save / git / terminal / task / delete / publish まで含めた **Workspace Safety Guard** へ拡張することで、秘密情報流出だけでなく、破壊的削除・誤コミット・誤公開・誤実行の抑止を主目的に据える。
