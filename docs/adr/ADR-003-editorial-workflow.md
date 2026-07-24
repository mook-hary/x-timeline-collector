# ADR-003: Editorial Workflow

## Status

Accepted

## Context

候補コンテンツは「下書き」「レビュー中」「公開可」「予約」「公開済み」「保管」といった運用状態を持つ。`update()` で status を自由変更できると、不正な飛び越し（draft → published など）や日時フィールドの不整合が起きやすい。

公開前チェックや Ranking の readiness は、状態の意味が安定していることを前提にする。

## Decision

明示的な状態遷移モデルを採用し、変更は `transition()` に集約する。

```text
draft
  ↓
review
  ↓
approved
  ↓
scheduled ──→ published
  ↓             ↓
  └────→ published
              ↓
           archived
              ↓
            draft（再利用）
```

許可する主な遷移:

- `draft` → `review`
- `review` → `draft` / `approved`
- `approved` → `draft` / `scheduled` / `published`
- `scheduled` → `approved` / `published`
- `published` → `archived`
- `archived` → `draft`

`scheduled` への遷移では `scheduledAt` を必須とする。対応する日時フィールド（`reviewedAt` 等）は遷移時に記録する。

## Alternatives

1. **自由な status 文字列** — 柔軟だが、Rules / Ranking / Queue の前提が崩れる。
2. **フラグの組み合わせ（isApproved, isPublished…）** — 矛盾状態が増えやすい。
3. **外部ワークフローエンジン** — 現規模では過剰。

## Consequences

### メリット

- 公開判断の経路が読みやすい。
- Review Queue / Publish Candidates の抽出が status ベースで明確。
- 日時監査が遷移と対応する。

### デメリット

- 許可遷移以外はエラーになり、例外フローは明示的な設計が必要。
- 新しい状態を足すときは遷移表・Rules・Ranking の更新が必要。

### 将来変更する条件

- 承認者が複数段階になる（例: legal-review）とき。
- 自動公開ジョブが `scheduled` → `published` を実運用で回すとき。
- 外部 CMS の状態モデルと突き合わせが必要になったとき。
