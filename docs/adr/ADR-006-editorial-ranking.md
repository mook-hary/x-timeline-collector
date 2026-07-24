# ADR-006: Editorial Ranking

## Status

Accepted

## Context

Review Queue や Publish Candidates では、複数候補から「先に見るべきもの」を決める必要がある。単一スコアや担当者の感覚だけに頼ると、再現性がない。AI 採点はコストと非決定性の問題がある。

Rules と Similarity の結果を共通の数値指標へ落とし、重み付きで並べる仕組みが必要だった。

## Decision

Multi-metric の決定的 Ranking を採用する。

- **指標（各 0〜100）:** `quality` / `novelty` / `freshness` / `readiness`
- **最終 score:** 重み付き和（小数第2位）、範囲 0〜100
- **Default weights:** quality 0.40, novelty 0.25, freshness 0.20, readiness 0.15（合計 1）
- quality は Rules 失敗から減点、novelty は `maxSimilarity` から算出、freshness は日時差、readiness は status
- 同点時は `updatedAt` 新しい順、さらに `id` 昇順

AI を使わない理由は、同じ入力で同じ順位を保証し、オフライン・CI・Bot が同じ結果を共有するためである。

## Alternatives

1. **単一メトリクス（例: freshness のみ）** — 単純だが品質・重複を反映できない。
2. **LLM に順位付けさせる** — 説明は上手いが非決定的で高い。
3. **人手の固定 priority フィールドのみ** — 運用負荷が高く、自動化しづらい。

## Consequences

### メリット

- 内訳（metrics / reasons）が説明可能。
- weights で方針を調整できる。
- Rules / Similarity と連携しやすい。

### デメリット

- 重み設計がドメイン依存で、初期値は仮説にすぎない。
- 指標が増えると解釈が難しくなる。

### 将来変更する条件

- 実運用データで重みの再校正が必要になったとき。
- クリック率や公開成果などフィードバック信号を取り込めるとき。
- それでも説明可能性より精度が優先され、学習モデル導入が妥当になったとき。
