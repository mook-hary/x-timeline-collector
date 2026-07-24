# ADR-004: Editorial Similarity

## Status

Accepted

## Context

同一テーマの候補が重複すると、Review / Publish のノイズになる。外部 Embedding API に依存すると、オフライン再現性・コスト・秘密情報管理が問題になる。まずはローカルで決定的に動く類似判定が必要だった。

## Decision

- **Local 判定のみ**（OpenAI / Embedding API は使わない）。
- 比較対象は `title` + `summary` + `body` + `tags`（空は無視）。
- 正規化後テキストの **文字 bigram** に対する **Dice 係数**（0〜1）を採用する。
- Store は `findSimilar` / `findSimilarById` で全件比較する。
- 将来 Embedding に差し替えできるよう、Similarity モジュール境界を分離する（スコアの意味は 0〜1 の類似度として維持）。

Bigram + Dice を選ぶ理由は、日本語・英数字を壊しにくく、実装が小さく、同じ入力で同じ結果になるためである。

Embedding を採用しない理由は、外部依存・非決定性・キー管理・オフラインテストの難しさを、基盤段階では避けたいためである。

## Alternatives

1. **単語トークン Jaccard** — 日本語分かち書きが別依存になる。
2. **編集距離のみ** — 長文・部分一致に弱い。
3. **最初から Embedding** — 品質上限は高いが、基盤の再現性と依存方針に合わない。

## Consequences

### メリット

- ネットワーク不要でテストが安定する。
- Rules の `high-similarity` や Ranking の novelty に同じ指標を渡せる。
- アルゴリズム差し替え時も API 形を保てる。

### デメリット

- 意味的に近いが表記が大きく異なる文章は取りこぼす。
- 全件スキャンはスケールに弱い。

### 将来変更する条件

- 意味的重複の見逃しが運用上の問題になったとき。
- アイテム数増大で local n-gram 全件比較が遅いとき。
- 自前または管理された Embedding インデックスを導入できるとき（Similarity 実装のみ置換）。
