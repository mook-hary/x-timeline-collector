# ADR-005: Editorial Rules

## Status

Accepted

## Context

公開前に「タイトル有無」「短すぎる本文」「類似過多」「公開可能な status か」などを機械的に点検したい。ハードコードを各呼び出しに散らすと、Source / Type ごとの差や severity の扱いが分岐する。

判定結果を返すだけで、Workflow を自動変更しない方針も明確にする必要があった。

## Decision

Rule Engine を独立モジュールとして導入する。

- Rule は `id` / `description` / `severity` (`error`|`warning`|`info`) / `check` を必須とする。
- **Rule 分離:** 既定ルールは `getDefaultRules()`、追加・上書きは呼び出し側で配列を渡す。
- **Source 別 / Type 別:** `sources` / `types` で適用対象を絞り、非対象は `skipped`。
- 全体 `passed` は **error 失敗が 0 件**のときのみ true（warning/info だけでは落とさない）。
- `check` 例外は当該 Rule を failed にし、Engine 全体は止めない。

Rule Engine 採用理由は、公開前ポリシーをデータとして列挙・テストでき、Bot や Dashboard が同じ結果を共有できるためである。

## Alternatives

1. **関数内 if の羅列** — 最初は速いが、Source 差分とテストが肥大化する。
2. **JSON Schema のみ** — 構造検証には向くが、類似度や publish operation 文脈は表現しづらい。
3. **Workflow 遷移時に強制 reject** — 基盤段階では早すぎる。まずは可視化を優先する。

## Consequences

### メリット

- severity と skip 理由が明示される。
- Source / Type でポリシーを段階導入できる。
- Ranking の quality や Publish Candidates の除外に再利用できる。

### デメリット

- Rule が増えると評価コストが上がる。
- 「失敗しても状態は変わらない」ため、運用で結果を見る習慣が必要。

### 将来変更する条件

- 特定 error で `transition` を自動拒否するポリシーを導入するとき。
- Source ごとの Rule パックが大規模化し、パッケージ分割が必要になったとき。
- 外部ポリシーエンジンや監査要件が追加されたとき。
