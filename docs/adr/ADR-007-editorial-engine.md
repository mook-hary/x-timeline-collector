# ADR-007: Editorial Engine

## Status

Accepted

## Context

Store / Workflow / Similarity / Rules / Ranking は個別に正しく動いても、利用側が毎回同じ配線（Rules 評価 → Similarity → Ranking → フィルタ）を書くと、実装が分岐する。一方、低水準 API を封印すると、テストや特殊用途の柔軟性が落ちる。

「統合入口」と「直接利用」を両立する境界が必要だった。

## Decision

Editorial Engine を **Facade** として置く。

- `createEditorialEngine()` が共通入口を返す。
- 基本 API（`create` / `update` / `find` / `transition` / `evaluate` / `rank`）は Store への委譲。
- 高水準用途として `getReviewQueue` / `getPublishCandidates` / `getDashboard` を提供する。
- Engine は統合とデフォルト配線（標準 Rules / Weights / `now`）に限定し、アルゴリズム本体は再実装しない。
- 各モジュール（Store 等）は従来どおり直接 require して利用可能とする。

Facade 採用理由は、Bot / Dashboard / 将来 UI が同じ手順で Review / Publish 候補を得られる一方、単体テストや実験は低水準 API で続けられるためである。

## Alternatives

1. **Store に全高水準 API を集約** — Store が肥大化し、永続化とオーケストレーションが混ざる。
2. **Engine のみ公開し低水準を非推奨化** — 現段階の検証・差し替え速度を落とす。
3. **サービスプロセス化（HTTP）** — ローカル基盤としては時期尚早。

## Consequences

### メリット

- 利用側のボイラープレートが減る。
- デフォルト Rules / Weights の一括変更が容易。
- 低水準モジュールの進化を止めない。

### デメリット

- Facade が便利メソッドを増やしすぎると再び肥大化する。
- Engine と Store の二重 API を文書で説明し続ける必要がある。

### 将来変更する条件

- Engine が永続化詳細や Rule 実装を持ち始めたとき（責務侵食の兆候）。
- 複数 Engine プロファイル（例: aikido-only）が必要になったとき。
- リモートサービス境界を切るとき（その場合でも内部モジュール分割は維持する）。
