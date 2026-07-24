# ADR-002: Editorial Store

## Status

Accepted

## Context

Editorial Platform は投稿候補・記事候補を永続化し、Workflow・Similarity・Rules・Ranking から共通参照する必要がある。最初から DB や検索エンジンを導入すると、依存・運用・テストのコストが先行する。一方、単一巨大 JSON は衝突・差分レビュー・部分更新に弱い。

ローカルで再現可能であり、将来のストレージ差し替えが容易な保存形態が求められた。

## Decision

- **保存形式:** JSON ファイルを正本とする。
- **配置:** `.pipeline-work/editorial/`（または Engine の `directory`）。
- **粒度:** **1 Item = 1 File**（`<id>.json`）。
- **API:** `create` / `update` / `find` / `list` / `listByStatus` / `listBySource` など、ストレージ詳細を隠した CRUD 面を提供する。
- **将来 DB 移行:** レコード形と ID 規約を安定させ、Store 実装の背後を差し替え可能にする。利用側は Engine / Store API 経由を原則とする。

JSON を選ぶ理由は、人間が読める・git 差分が取りやすい・テストで一時ディレクトリに容易に再現できるためである。

## Alternatives

1. **単一 `items.json` 配列** — 実装は単純だが、更新競合と差分ノイズが大きい。
2. **SQLite / Postgres を初手で導入** — クエリは強いが、現段階の候補数と開発速度に対して重い。
3. **Knowledge Base 形式へ同居** — Knowledge は別契約の編集オブジェクトであり、投稿候補の Workflow とは責務が異なる。

## Consequences

### メリット

- ローカル完結でデバッグしやすい。
- アイテム単位の読み書き・バックアップが容易。
- テストがファイルシステムだけで完結する。

### デメリット

- 件数増大時に全件スキャン（`list` / Similarity / Ranking）が遅くなる。
- トランザクションや複合クエリは自前実装が必要。

### 将来変更する条件

- アイテム数が多く、list / similarity / ranking が運用上のボトルネックになったとき。
- 複数プロセスからの同時書き込みが常態化したとき。
- リモート共有や監査ログが必須要件になったとき（その時点で DB / object store へ移行）。
