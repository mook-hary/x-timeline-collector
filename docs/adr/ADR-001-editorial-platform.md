# ADR-001: Editorial Platform

## Status

Accepted

## Context

本リポジトリは当初、X タイムライン収集と Digest Reader 公開を中心に成長してきた。一方で、ニュース要約・合気道メモ・アニメ記録・ブログ下書きなど、将来の複数コンテンツ系統を同じ品質基準で扱いたい需要が増えている。

Reader は「読むための最終成果物」としては有効だが、投稿候補・記事候補の状態管理・重複検知・公開前チェック・優先順位付けまでは担わない。これらの判断を Morning Pipeline や各 Bot に散在させると、ルールが分岐し再現性が落ちる。

そこで、収集パイプラインとは別に、編集可能な Knowledge Product を扱う共通基盤（Editorial Platform）を定義する必要があった。

## Decision

Editorial Platform を次の原則で置く。

- **目的:** 複数ソースの投稿・記事候補を、共通フォーマット・共通 Workflow・共通評価で管理する。
- **Reader との関係:** Reader / GitHub Pages は配信面。Editorial Platform はその上流にある候補管理・品質判定の層とする。現状はまだ Morning Pipeline へは組み込まない。
- **Knowledge Product:** タイムラインの生データではなく、人がレビューし公開判断できる「編集可能な成果物」を第一級の対象とする。
- **Engine 中心構成:** 利用側の共通入口は Editorial Engine。内部は Store / Workflow / Similarity / Rules / Ranking に分割し、低水準モジュールも直接利用可能とする。
- **将来追加予定の系統:**
  - Aikido
  - Animation
  - Blog
  - Others（ニュース以外の個人コンテンツ）

## Alternatives

1. **Reader 拡張だけで完結する** — 表示と運用状態が混線しやすい。
2. **Morning Pipeline に直接埋め込む** — 収集と編集判断の責務が結合し、Bot 横断の再利用が難しい。
3. **外部 CMS / DB を最初から導入する** — 現時点の規模に対して過剰。ローカル JSON で学習曲線と依存を抑える。

## Consequences

### メリット

- ソース横断で同じ状態遷移・ルール・順位付けを使える。
- Reader / Bot / 将来 UI が同じ Engine を入口にできる。
- 低水準モジュールを個別に差し替え・検証できる。

### デメリット

- レイヤが増え、初見の理解コストが上がる。
- 当面は Morning Pipeline と未接続のため、運用導線が二系統になる。

### 将来変更する条件

- Aikido / Animation / Blog など複数系統が本運用に入り、単一 Engine では不足するとき。
- Reader や外部配信が Editorial 状態を直接要求するようになったとき。
- 永続化を DB / リモート同期へ移す意思決定（ADR-002）が確定したとき。
