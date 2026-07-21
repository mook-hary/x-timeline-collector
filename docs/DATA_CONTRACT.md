# DATA_CONTRACT

| | |
|---|---|
| **Version** | 2.16 |
| **Status** | Active |
| **Last Updated** | 2026-07-21 |

x-timeline-collector のデータ契約書。

利用手順・CLI・セットアップは [README.md](../README.md) を正とする。  
本文書は各スクリプトと成果物が従うべき「何が正式なデータか」のみを定義する。

### この文書が扱うこと

- データモデルとパイプライン上の成果物の役割
- Source of Truth / フォールバック / 不変条件
- キャッシュ・進捗契約
- 後方互換とデータライフサイクル

### この文書が扱わないこと

- インストール手順、Chrome 起動、実行コマンド
- CLI オプション一覧と使い方の例
- プロンプト文面、採点アルゴリズムの実装詳細
- AI 要約など未実装機能の仕様確定

---

## 0. Purpose

このドキュメントの目的は次のとおりである。

1. プロジェクト全体で正式なデータとその意味を定義する
2. 各スクリプトの責務境界をデータ面で分離する
3. Source of Truth（どのフィールドが正か）を定義する
4. 既存データの後方互換を維持するための前提を明文化する
5. 将来の機能追加時に、契約を壊さないための基準を置く

コードの書き方、プロンプト文面、実行コマンドは対象外とする。

---

## 1. Pipeline

データの正規な流れは次のとおりである。

```text
connect
  ↓
timeline.json
  ↓
analyze
  ↓
timeline_analyzed.json
  ↓
analyze_ai
  ↓
timeline_ai.json
  ↓
enrich_ai
  ↓
timeline_enriched.json
  ↓
search / digest / editor / concepts / stories
```

| 段階 | 一文の責務 |
|---|---|
| **connect** | X ホームタイムラインから投稿を収集し、URL 単位で蓄積する。 |
| **timeline.json** | 収集時点の生データ（Raw）を保持する。 |
| **analyze** | キーワード設定に基づき分類結果 `analysis` を付与する。 |
| **timeline_analyzed.json** | Raw にキーワード分類を載せた中間成果物である。 |
| **analyze_ai** | 低確信度または「その他」のみを AI 再分類し、`finalAnalysis` を付与する。 |
| **timeline_ai.json** | 最終カテゴリ契約（`finalAnalysis`）を持つ中間成果物である。 |
| **enrich_ai** | カテゴリは変更せず、重要度・要約・タグ等の `enrichment` を付与する。 |
| **timeline_enriched.json** | 検索・ダイジェスト・Editor・Concept・Story が読む正式な運用データである。 |
| **search / digest / editor / concepts / stories** | enriched データを消費する。新たな分類レイヤは追加しない。editor は Topic、concepts は Concept、stories は Story の派生ビューを返す。 |

上流ファイルを下流が書き戻してはならない。各 Producer は自分の出力ファイルのみを生成・更新する。

---

## 2. Canonical Data Model

### 2.1 `output/timeline.json`

| 項目 | 内容 |
|---|---|
| **Responsibility** | 収集された投稿の Raw スナップショット。分類・要約を含まない。 |
| **Producer** | `connect.js` |
| **Consumer** | `analyze.js` |
| **Regeneratable** | 再収集が必要。下流ファイルから完全復元はできない。 |

### 2.2 `output/timeline_analyzed.json`

| 項目 | 内容 |
|---|---|
| **Responsibility** | Raw にキーワード分類 `analysis` を載せた段階。 |
| **Producer** | `analyze.js` |
| **Consumer** | `analyze_ai.js`、人間レビュー成果物の元データ |
| **Regeneratable** | `timeline.json` と `config/categories.json` があれば API なしで再生成可能。 |

### 2.3 `output/timeline_ai.json`

| 項目 | 内容 |
|---|---|
| **Responsibility** | 最終カテゴリ契約 `finalAnalysis` を持つ段階。キーワード結果 `analysis` は保持する。 |
| **Producer** | `analyze_ai.js` |
| **Consumer** | `enrich_ai.js` |
| **Regeneratable** | `timeline_analyzed.json` から再生成可能だが、未キャッシュ分は API 再実行が必要。 |

### 2.4 `output/timeline_enriched.json`

| 項目 | 内容 |
|---|---|
| **Responsibility** | 運用上の正式データ。分類・補強情報を含む完成形。 |
| **Producer** | `enrich_ai.js` |
| **Consumer** | `search.js`、`digest.js` |
| **Regeneratable** | `timeline_ai.json` から再生成可能だが、未キャッシュ分は API 再実行が必要。 |

補助成果物（契約の主系列外）:

| ファイル | 役割 |
|---|---|
| `output/timeline.csv` | Raw の表形式ビュー。正本は `timeline.json`。 |
| `output/review/*.txt` 等 | 人間レビュー用派生。正本ではない。 |
| `output/digest_*.md` 等 | digest の表示成果。再実行で作り直せる。 |

---

## 3. Canonical Fields

投稿オブジェクト上の主要フィールド契約。

| Field | Owner | Responsibility | Required | Mutable |
|---|---|---|---|---|
| `url` | connect | 投稿の一意識別子 | はい（運用上必須） | いいえ（同一投稿として扱うキー） |
| `text` | connect | 投稿本文 | ほぼ必須（空がありうる） | 収集時のみ。下流は変更しない |
| `authorName` | connect | 表示名 | いいえ（欠損ありうる） | 収集時のみ |
| `authorHandle` | connect | `@` 付きハンドル | いいえ（欠損ありうる） | 収集時のみ |
| `postedAt` | connect | 投稿日時（元投稿側） | いいえ（欠損ありうる） | 収集時のみ |
| `collectedAt` | connect | 本ツールが取得した日時 | はい | 新規追加時のみ設定。既存行は変更しない |
| `analysis` | analyze | キーワード分類の完全な記録 | analyzed 以降ではい | analyze 再実行時に置換。他段階は触らない |
| `finalAnalysis` | analyze_ai | 最終カテゴリ契約 | ai 以降ではい | analyze_ai 再実行時に置換。enrich 以降は触らない |
| `enrichment` | enrich_ai | 重要度・要約・検索用タグ等 | enriched 以降ではい | enrich_ai 再実行時に置換。search/digest は触らない |

補足:

- Raw（`timeline.json`）に `analysis` / `finalAnalysis` / `enrichment` は存在しない。
- 下流は上流フィールドを削除・改変せず、自分のレイヤだけを追加する。

---

## 4. Source of Truth

### 4.1 category

| 項目 | 内容 |
|---|---|
| **Canonical Source** | `finalAnalysis.category` |
| **Consumer** | `enrich_ai.js`（入力カテゴリ）、`search.js`、`digest.js` |
| **Notes** | 正式値は常に `finalAnalysis.category`。`search.js` / `digest.js` は欠損・移行途中データ向けに `analysis.category` → `"その他"` へフォールバックしてよい（`finalAnalysis.category` がある場合は必ずそれを使う）。enrich はカテゴリを変更しない。カテゴリ名の集合は `config/categories.json` のキーと一致する固定集合を正とする（「その他」を含む）。 |

### 4.2 confidence

| 項目 | 内容 |
|---|---|
| **Canonical Source** | 用途により分離する。キーワード確信度の正は `analysis.confidence`（`"high"` \| `"medium"` \| `"low"`）。AI 確信度の正は `finalAnalysis.confidence`（`0`〜`1` の数値）。 |
| **Consumer** | `analyze_ai.js` は `analysis.confidence` を対象選定に使う。search / digest は confidence を条件に使わない。 |
| **Notes** | 二つの confidence は尺度が異なる。相互に置換・比較してはならない。 |

### 4.3 tags / keywords

| 項目 | Canonical Source | Consumer | Notes |
|---|---|---|---|
| 分類根拠キーワード | `analysis.matchedKeywords` | レビュー・分類改善・search（補助） | `{ keyword, weight }`。人間向けタグではない。search は照合対象に含めうるが、通常表示の Tags とは区別する。 |
| AI 分類タグ | `finalAnalysis.tags` | search / digest（合算側） | 文字列配列。keyword パスでは空配列がありうる。 |
| 補強タグ | `enrichment.tags` | search / digest（合算側） | 検索しやすい短いタグ。表示・検索では `finalAnalysis.tags` と合算する。 |

タグの「一つの正本配列」は定義しない。search の人間向け表示タグは `finalAnalysis.tags` + `enrichment.tags`（大小無視で重複除去）。search の照合はそれに加え `matchedKeywords.keyword` を含めてよい。

### 4.3.1 search 条件の論理（Version 1.3）

| 条件 | 論理 |
|---|---|
| 異なる種類の条件同士 | AND |
| 複数 `--category` | OR（`config/categories.json` の名称で検証） |
| 複数 `--tag` | AND（各語はタグ集合への部分一致） |
| `--text` の空白区切り複数語 | AND（各語は検索対象テキスト全体のどこかに存在） |

`--explain` が付与する一致メタ情報は派生情報であり、投稿 JSON へ保存しない。

### 4.4 date

| 項目 | 内容 |
|---|---|
| **Canonical Source（投稿時点）** | `postedAt` |
| **Canonical Source（取得時点）** | `collectedAt` |
| **Consumer** | search / digest / editor / concepts / stories の期間フィルターと日時ソートは **`postedAt` のみ**を用いる。 |
| **Notes** | `collectedAt` は収集メタデータであり、期間検索の正ではない。`postedAt` 欠損時に `collectedAt` へフォールバックする契約は **存在しない**。 |

日付フィルターの境界（search / digest / editor / concepts / stories 共通）:

- `--from` / `--to` / digest の `--today` は、実行環境の **ローカル日付** として解釈する。
- `--from YYYY-MM-DD` はローカル `00:00:00.000` 以降。
- `--to YYYY-MM-DD` はローカル `23:59:59.999` まで含む。
- 正式な投稿日時は **`postedAt` のみ**。`collectedAt` へのフォールバックは行わない。
- 期間指定があるとき、`postedAt` 欠損・不正な投稿は対象外とする。
- 期間指定がないとき、`postedAt` 欠損投稿も候補に残りうる（他条件のみで絞る）。
- search と digest は同一の境界実装（`lib/date-range.js`）を使う。

### 4.5 summary

| 項目 | 内容 |
|---|---|
| **Canonical Source** | `enrichment.summary` |
| **Consumer** | `search.js`（`--text` 対象および表示）、`digest.js`（表示） |
| **Notes** | 表示時のみ、summary が空なら `text` を用いる（digest ではさらに空なら「要約なし」）。summary の正本はあくまで `enrichment.summary` である。 |

### 4.6 reason

| 項目 | Canonical Source | Consumer | Notes |
|---|---|---|---|
| 分類理由 | `finalAnalysis.reason` | 主に AI 分類の説明 | カテゴリ選定の理由。 |
| 重要度理由 | `enrichment.reason` | digest 注目投稿、search の `--text` | 重要度判断の理由。分類理由とは別フィールドである。 |

両者を混ぜて一つの reason として扱ってはならない。

### 4.7 importance

| 項目 | 内容 |
|---|---|
| **Canonical Source** | `enrichment.importance` |
| **Consumer** | `search.js`、`digest.js` |
| **Notes** | 整数 `1`〜`5` が正規値。pending 時など一時的に `0` がありうるが、完了した enrichment では `1`〜`5` を正とする。 |

### 4.8 personalScore（派生値）

| 項目 | 内容 |
|---|---|
| **Canonical Source** | 永続フィールドではない。`digest.js` / `lib/digest-core.js` が `importance` と `digest.config.json` のカテゴリ重みから計算する派生値。 |
| **Consumer** | digest の注目投稿選定・表示 |
| **Notes** | 基本式は `importance × 10 + categoryWeight × 3`。投稿 JSON に保存される正式フィールドではない。 |

### 4.9 Digest 選定メタ・topicKey（派生値・Version 1.4）

| 項目 | 内容 |
|---|---|
| **Canonical Source** | 永続フィールドではない。Digest 実行時にのみ生成される派生値。 |
| **Consumer** | `digest.js` の注目投稿選定・`--explain` 表示。`editor.js` / `lib/editor-core.js` の Topic グルーピング（同一契約） |
| **Notes** | 投稿 Identity は引き続き `url`。`topicKey` は永続 Identity ではない。投稿データへ `topicKey` / selection metadata を書き込まない。 |

### 4.10 Editor View（派生情報・Version 1.5 / EP-004）

| 項目 | 内容 |
|---|---|
| **Canonical Source** | 永続フィールドではない。`editor.js` / `lib/editor-core.js` が enriched 投稿から実行時に生成する派生ビュー。 |
| **Consumer** | 編集者が Topic 単位で俯瞰・次に読む投稿を選ぶための表示 |
| **Notes** | Editor は投稿一覧ではなく Topic 単位で整理する。Topic は投稿 Identity ではない。投稿 Identity は `url`。 |

契約要点:

- Topic Key は Digest（§4.9）と同じ生成契約を用いる（`lib/digest-core.js` の `buildTopicKey`）。
- Topic Key を生成できない投稿は、Editor 上では一投稿＝一 Topic（singleton）として扱う。互いに同一 Topic にはしない。
- Topic の `summary` は AI 生成しない。優先順は `enrichment.summary` → 投稿本文先頭 → `"(no summary)"`。Topic Summary は保存しない。
- カテゴリ読取は `finalAnalysis.category` → `analysis.category` → `"その他"`。
- タグは人間向けのみ（`enrichment.tags` → `finalAnalysis.tags`）。`matchedKeywords` は使わない。
- Editor View / Topic 構造は投稿データや enriched JSON へ書き戻さない。

#### 掲載可否判断（EP-004）

`editor.js decide`（`lib/editor-decision.js`）は Story + Editorial + Knowledge から **掲載するか**だけを判定する（順位付け・紙面構成は行わない）。

各 Story:

```json
{ "storyId": "...", "decision": "accept|hold|reject", "reason": ["..."] }
```

- **accept**: evidence あり・Story 成立・Editorial 生成済み
- **hold**: evidence不足 / Storyが弱い / Knowledge不足 / Editorial未生成
- **reject**: 質問投稿 / 宣伝のみ / 根拠不足 / Story重複

Pipeline は既存 `editor.json`（topics 等）を維持したまま `decisions` 配列を追加する。Writer / Article Report / Daily Edition の契約は変更しない。

#### 掲載優先順位（EP-005）

`editor.js rank`（`lib/editor-ranking.js`）は `decision === "accept"` の Story のみを決定論的に順位付けし、`editor.ranking[]` を追加する。`topics` / `decisions` は変更しない。`hold` / `reject` は ranking 対象外。対象 0 件時は `ranking: []`。

各要素:

```json
{
  "storyId": "...",
  "rank": 1,
  "score": 82,
  "factors": {
    "evidence": 25,
    "freshness": 20,
    "publicInterest": 15,
    "editorialReadiness": 12,
    "informationDensity": 10
  },
  "reasons": ["..."]
}
```

- **score**: 0〜100（整数）。factors 合計を clamp。
- **factors 上限**: evidence 0–30 / freshness 0–25 / publicInterest 0–20 / editorialReadiness 0–15 / informationDensity 0–10
- **tie-break**: score → evidence → freshness → editorialReadiness → storyId 昇順
- **Editorial**: 検証済み情報のみ加点（不採用フィールドは使わない）
- **用途**: 内部編集判断。現段階では Writer / Daily Edition の掲載制御に使用しない
- Pipeline 順: Topic → Decision → Ranking → Edition → 後段。紙面構成・本数制限は行わない

#### Edition Layout（EP-006）

`editor.js edition`（`lib/editor-edition.js`）は `decisions[]` + `ranking[]` + Story から **その日の掲載対象と掲載順**を決定し、`editor.edition` を追加する。`topics` / `decisions` / `ranking` は変更しない。score の再計算・decision の再判定はしない。

```json
{
  "edition": {
    "version": "1.0",
    "selected": [
      { "storyId": "...", "rank": 1, "score": 92, "section": "top", "position": 1 }
    ],
    "omitted": [
      { "storyId": "...", "reasonCode": "edition-capacity" }
    ],
    "summary": {
      "candidateCount": 0,
      "selectedCount": 0,
      "omittedCount": 0,
      "topCount": 0,
      "secondaryCount": 0,
      "briefCount": 0
    }
  }
}
```

- **掲載候補**: `decision===accept` かつ ranking に存在し Story 特定可能（一意）
- **全体上限**: 9件（top≤1 / secondary≤3 / brief≤5）
- **section 割り当て**: position1=top、2–4=secondary、5–9=brief
- **順序**: rank 昇順 → score 降順 → storyId 昇順。`position` は selected 内 1始まり
- **score 絶対閾値**: なし（EP-006 は紙面配置のみ）
- **hold / reject**: 掲載しない（大量 omitted 記録はしない）
- **omitted reasonCode**: `edition-capacity` / `not-ranked` / `story-not-found` / `duplicate-story`
- **用途**: 内部編集判断。EP-006 時点では Writer / Daily Edition の掲載制御に未使用

#### Writer Selection（EP-007）

Pipeline の Writer 入力 Story は `editor.edition.selected[]` に制限する（`lib/writer-selection.js`）。selected 外の Story は Writer 対象外。処理順は selected の `position` 昇順（欠損時は `rank` 昇順 → `storyId` 昇順）。score / Decision / Ranking / Edition を Writer が再判定しない。

- **duplicate selected**: 最初の有効 1 件のみ。warning `duplicate-selected-story`
- **selected Story 不在**: 対象外。warning `selected-story-not-found`。繰り上げ補完しない
- **empty selection**: Writer 対象 0 件。全件フォールバックしない（Pipeline は Writer skip）
- **Pipeline**: `edition.selected[]` 必須。欠損時はエラー（暗黙の全 Story 生成なし）
- **Writer 単体 CLI**: `--editor` なしは従来互換。`--editor` 指定時は Edition 必須
- **本文契約**: H1 / claims / sources / Editorial 連携は変更しない。section / rank / score / position は本文へ出さない
- **Daily Edition**: EP-007 では紙面表示へ未接続（Writer 出力を従来どおり処理）

### 4.11 Concept Library（派生ビュー・Version 1.6）

| 項目 | 内容 |
|---|---|
| **Canonical Source** | 永続フィールドではない。`concepts.js` / `lib/concept-core.js` が Editor Topic から実行時に生成する派生ビュー。Source of Truth ではない。 |
| **Consumer** | 継続テーマの俯瞰、将来の Editor in Chief / Knowledge Base 入力 |
| **Notes** | Concept は投稿 Identity ではない。投稿 Identity は `url`。Concept / explanation を投稿や専用永続ファイルへ保存しない。 |

責務の分離:

| キー | 役割 |
|---|---|
| **Topic Key** | その時点の話題の重複判定（短期） |
| **Concept Key** | 日付をまたぐ継続テーマの統合判定（長期） |

Concept Key 契約:

- AI / embedding / 類義語辞書は使わない。人間向けタグを主要材料とし、無い場合のみ Topic summary から安全にフォールバックする。
- category 単独・Topic Key 単独・singleton Topic の URL を Concept Key の意味キーにしない。
- `matchedKeywords` は Concept 材料に使わない。
- 意味のある Concept Key を生成できない Topic は無理に統合せず、一 Topic＝一 Concept（derived singleton）とする。内部一意キーと意味キーを区別し、永続 Identity にしない。

その他:

- `activeDays` は各投稿 `postedAt` から算出したローカル日付のユニーク数。`postedAt` 欠損は加算しない。`collectedAt` へフォールバックしない。
- カテゴリ読取は `finalAnalysis.category` → `analysis.category` → `"その他"`。Concept の `category` は支配カテゴリ、`categories` は内訳。
- 複数 `--category` は OR。支配カテゴリ一致ではなく、Concept 内に当該カテゴリの Topic または投稿が含まれる場合に一致する。
- `--explain` メタは非永続。

### 4.12 Story Engine（派生ビュー・Version 1.7）

| 項目 | 内容 |
|---|---|
| **Story定義の Source of Truth** | `config/stories.json`（人間が管理する明示的定義） |
| **実行時集計** | `stories.js` / `lib/story-core.js` が Concept Library から生成する非永続ビュー |
| **Notes** | Story は投稿・Topic・Concept Identity ではない。投稿 Identity は `url`。Story 集計・explain を投稿や専用永続ファイルへ保存しない。Knowledge Base の Source of Truth ではない。定義変更により過去の派生結果は変わり得る。 |

階層:

| 単位 | 役割 |
|---|---|
| **Post** | 個別投稿 |
| **Topic** | 時点で観測された話題 |
| **Concept** | 日付をまたぐ継続テーマ |
| **Story** | 複数 Concept を束ねた編集上の主要論点 |

Story ID:

- 人間管理の安定 ID（定義 Identity）。空不可・定義内一意。
- 表示 `label` と分離する。投稿 URL / Concept Key から自動生成しない。

Concept → Story マッチング（Rule B）:

1. `excludeTags` に正規化後完全一致するタグがあれば不一致。
2. `includeTags` が1件以上ある場合、Concept の人間向けタグとの正規化後完全一致が必須（部分一致しない）。
3. `includeTags` が空の場合のみ、`includeCategories` のいずれかを Concept が含む（category / categories / 内包投稿）ことで一致。
4. `includeTags` と `includeCategories` の両方が空は不正設定。
5. `matchedKeywords` は使わない。
6. 一つの Concept は複数 Story へ所属してよい。同一 Story 内への重複追加はしない。
7. どの Story にも一致しない Concept は捨てず `unassignedConcepts` として保持する。

Story Score（派生・将来変更可）:

```text
score =
  maxImportance * 10
  + activeDays * 4
  + conceptCount * 3
  + topicCount
  + priority
```

- `priority` は Story 定義の編集優先度（大きいほど上位寄与）。
- score は投稿・Concept へ保存しない。構成値は `--explain` で確認できる。

その他:

- `activeDays` は Story 内の重複除去後投稿の `postedAt` ローカル日付ユニーク数。Concept の activeDays を単純加算しない。`collectedAt` フォールバックなし。
- カテゴリ読取は `finalAnalysis.category` → `analysis.category` → `"その他"`。Story の `categories` は投稿数ベースの内訳。
- 複数 `--category` は OR。Story 内包含判定。
- `observedTags`（`tags`）と定義の `configuredTags` / `includeTags` を混同しない。

### 4.13 Knowledge Object（Version 1.8）

| 項目 | 内容 |
|---|---|
| **役割** | Story から抽出・育成する継続的な「理解」。Story（出来事）より長寿命。 |
| **表現** | `lib/knowledge-core.js` / `knowledge.js`。一件の Knowledge Object を生成・検証・直列化する。 |
| **永続** | Knowledge Object は Knowledge Layer の永続 Source of Truth 候補。保存は Knowledge Base（§4.15）。`knowledge.js` 自体は保存しない。 |
| **Notes** | Story / Concept / Topic 集計は派生ビュー。Knowledge はそれらへの参照（Evidence）を持ち、投稿本文をコピーしない。top-level `stories` / `concepts` / `posts` は `evidence.*` の互換エイリアスであり、両方が存在して不一致なら検証失敗（黙って片方を採用しない）。 |

階層の関係:

| 単位 | 寿命のイメージ | 性質 |
|---|---|---|
| **Story** | 短〜中 | 観測・編集上の論点（派生） |
| **Knowledge** | 長 | 人が育てる理解（永続候補） |

必須フィールド（相当）:

| フィールド | 契約 |
|---|---|
| **id** | 人間管理の安定 ID。Story ID とは別。空不可。UUID 不要。 |
| **title** | 表示タイトル。Story label とは別。将来変更可。 |
| **summary** | 本文。AI 生成しない。人間入力。初期空文字可。 |
| **status** | `config/knowledge-status.json` の許可値と遷移。既定 `draft`。 |
| **stories / concepts / posts** | **互換エイリアス**。serialize 時は `evidence.*` と同期する。 |
| **evidence** | **参照の Source of Truth**。`{ stories, concepts, posts }` に Identity 文字列（Story id / Concept key / 投稿 URL）のみ。投稿オブジェクトを埋め込まない。 |
| **confidence** | `0`〜`100`。手入力。自動計算しない。 |
| **notes** | 自由記述文字列。 |
| **version** | `1` 以上の整数。初期 `1`。意味のある変更時のみ +1。serialize / deserialize では変えない。 |
| **createdAt / updatedAt** | ISO8601。`createdAt` は不変。`updatedAt` は意味のある変更時のみ更新。`createdAt ≤ updatedAt`。 |

Evidence Identity:

- Story: `id`（空不可）
- Concept: `conceptKey`（空不可。singleton URL を意味キーにしない）
- Post: `url`（空不可）
- 重複判定は種別内の Identity 文字列完全一致（大小文字を区別）

### 4.14 Knowledge Draft Workflow（Version 1.9）

| 項目 | 内容 |
|---|---|
| **役割** | 人間が Knowledge Draft を作成・編集・Evidence 追加・status 遷移する操作層。AI 生成ではない。 |
| **実装** | `lib/knowledge-workflow.js`（操作）→ `lib/knowledge-core.js`（構造・検証） |
| **永続** | Workflow CLI はファイル保存しない。永続化は Knowledge Base（`knowledge-base.js` / §4.15）。入力 JSON は読み取り専用。 |
| **Notes** | 各操作は新しい Knowledge Object を返す。入力を破壊的変更しない。`operation` メタは非永続（Knowledge Base にも保存しない）。 |

操作:

| 操作 | 責務 |
|---|---|
| **createDraft** | id / title 必須。status=draft、version=1、createdAt=updatedAt=now |
| **updateDraft** | title / summary / notes / confidence のみ。id / createdAt / evidence / version / status は不可。同値なら version・updatedAt 不変 |
| **addEvidence** | 種別明示。正規化・重複追加なし。追加時のみ version+1 / updatedAt 更新 |
| **removeEvidence** | Identity で削除。未存在は変更なし（エラーにしない） |
| **transitionStatus** | 許可遷移のみ。同 status は変更なし |

status 遷移（`config/knowledge-status.json` が SoT）:

- draft → review
- review → draft
- review → published
- published → archived
- archived → draft

禁止例: draft → published / draft → archived / published → review / archived → published

移行条件:

- **draft → review:** summary 非空、Evidence ≥ 1
- **review → published:** title 非空、summary 非空、Evidence ≥ 1

version / updatedAt を増やす変更: 人間編集の値変化、Evidence 追加/削除、status 変化。  
増やさない: 同値更新、重複 Evidence、未存在削除、同 status、serialize / deserialize / validate。

Digest 注目投稿の選定制約（§4.9 補足）:

| 制約 | 意味 |
|---|---|
| **categoryCap** | `maxPostsPerCategoryInTop`。カテゴリあたりの選定上限。不足時も自動緩和しない。 |
| **authorCap** | `maxPostsPerAuthorInTop`。著者あたりの選定上限。不足時も自動緩和しない。 |
| **topicCap** | 同一 `topicKey` の選定上限。`digest.config.json` に任意項目 `topicCap` があればそれを使い、未指定時はコード既定値 `1`。 |

選定パス:

1. **第1パス:** categoryCap / authorCap / topicCap をすべて適用して personalScore 順に選定する。
2. **第2パス:** 指定件数に満たない場合のみ、categoryCap / authorCap は維持したまま topicCap だけを緩和して不足分を補う。第2パス採用は `selectionPass = 2` かつ `topicCapRelaxed = true` として区別する。

`topicKey` 生成（軽量・非 AI）:

- 人間向けタグを優先: `enrichment.tags` → `finalAnalysis.tags`（大小無視で重複除去、順序差を吸収するため正規化後にソート）。
- タグが使えない場合: `enrichment.summary` → 投稿本文 → 本文中の外部リンク由来の安定情報。
- 投稿自身の `url` は Topic Key にしない。
- `analysis.matchedKeywords` は分類根拠のため主要 Topic Key に使わない。
- `topicKey` を生成できない投稿は、互いに同一話題として扱わない（欠損だけを理由に除外しない）。

`--explain` / selection metadata / Digest 統計は派生情報であり、enriched 投稿へ保存しない。`--explain` なしの Digest JSON 構造は変更しない。

### 4.15 Knowledge Base Storage（Version 2.0）

| 項目 | 内容 |
|---|---|
| **役割** | 人間が編集した Knowledge Object のローカル永続ストレージ。投稿・Story・Concept 本文は保存しない。 |
| **実装** | `lib/knowledge-store.js` / `knowledge-base.js`。AI・外部 DB・全文索引なし。 |
| **既定パス** | `knowledge-base/`（CLI `--base-dir` で切替可。store は呼び出し側が渡すパスを使う） |

ディレクトリ構造（Source of Truth）:

| パス | 役割 |
|---|---|
| `items/<id>.json` | **現行 Knowledge の Source of Truth**。最新 Knowledge Object のみ。 |
| `history/<id>/<zero-padded-version>.json` | 保存時点の**変更不能**な履歴スナップショット（例: `000001.json`）。現行の代わりに暗黙利用しない。 |
| `index.json` | 一覧用の**派生インデックス**。`items/` から再生成可能。唯一の正本にしてはならない。 |

`index.json` 構造:

```json
{
  "version": 1,
  "generatedAt": "...",
  "items": [
    {
      "id", "title", "status", "version", "confidence",
      "createdAt", "updatedAt",
      "evidenceCount", "storyEvidenceCount", "conceptEvidenceCount", "postEvidenceCount"
    }
  ]
}
```

並び: `updatedAt` 降順、同値なら `id` 昇順。summary / notes 全文は索引に載せない。

Knowledge ID とファイル名:

- 既存契約 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` を優先（ドット不可）。
- 空、`.` / `..`、`/` `\`、制御文字、パストラバーサルを拒否。
- 保存層は ID を正規化して別 ID へ潰さない。

保存規則:

| ケース | 規則 |
|---|---|
| **新規** | 現行が無いときのみ。`version` は **1** のみ許可。現行 + `history/.../000001.json` + index 更新。 |
| **更新** | `id` 一致、`createdAt` 不変、保存 `version === 現行 + 1`、`updatedAt` 非逆行、同 version 履歴未作成。 |
| **禁止** | version 同値・飛越し・巻戻し、履歴上書き、不正 Knowledge、Evidence エイリアス不一致。 |
| **楽観的競合** | Workflow の version が 1 ずつ増える契約を利用。保存版の「直前 version = 現行」であること（= 保存 version が現行+1）で判定。古い JSON からの上書きを拒否。 |

永続するもの / しないもの:

- **する:** Knowledge Object、version ごとのスナップショット、派生 index
- **しない:** `operation` メタ、CLI 実行履歴、Story/Concept/Post 本文、AI 出力コピー、validation 結果

保存前検証・書込み:

1. `validateKnowledge()` 完全検証（Evidence エイリアス一致含む）
2. 現行・version 競合確認
3. 新 version 履歴を Atomic Write（既存同名は拒否）
4. 現行 `items/<id>.json` を Atomic Write
5. index を `items/` から再生成して Atomic Write

Atomic Write は一時ファイルへ書いて rename。完全な複数ファイル・トランザクションは v1 対象外。

障害時の扱い（v1）:

- 現行ファイルを破損させない（Atomic Write）
- 既存履歴を上書きしない
- 履歴だけ先行して現行更新に失敗した場合、整合性検証で検出可能。現行を巻き戻さない
- index は常に `rebuild-index` で再生成可能（不正 index を黙って置換しない。存在しない場合の list は自動再生成可）

整合性検証（`validateKnowledgeBase`）は Knowledge / index を変更せず、ディレクトリ構造・現行・履歴連続性・createdAt 一貫・updatedAt 非逆行・index 一致などを可能な限り複数エラーで報告する。

入力 Knowledge ファイルは読み取り専用。Story Engine 出力は引き続き派生ビュー。**Knowledge Base 内の現行 Knowledge が Knowledge Layer の永続 Source of Truth** である。

### 4.16 Knowledge Brief Builder / Editorial Brief v2（Version 2.10）

| 項目 | 内容 |
|---|---|
| **役割** | Knowledge（および任意の Story）から、**編集指示用の派生ビュー（Editorial Brief）**を生成する。記事本文ではない。 |
| **実装** | `lib/brief-core.js` / `lib/brief-editorial.js` / `brief.js`。AI・URL 取得・記事本文生成なし。 |
| **永続** | Brief は **永続 Source of Truth ではない**。今回ファイル保存しない（標準出力のみ）。 |
| **非変更** | Knowledge Base / Knowledge Object / version / status / Evidence / index / Story 生成を変更しない。 |

Brief は Knowledge ではない。Writer は Brief（事実・編集指示）と Plan（方針）を入力とし、Knowledge Base を直接読む設計を既定にしない。

使用 Knowledge の status 規則:

- **既定:** `published` のみ
- 明示 ID 指定でも既定は published のみ
- `draft` / `review` / `archived` を含めるには `--allow-status` で明示許可
- 未確定 Knowledge を無意識に Writer へ渡さない

選択順:

- **明示 ID 指定時:** CLI 指定順を維持（重複 ID は初出のみ）
- **status 検索時:** status 優先（published → review → draft → archived）→ confidence 降順 → updatedAt 降順 → id 昇順

#### 互換フィールド（既存 Writer / Plan / Article Report）

| フィールド | 契約 |
|---|---|
| **id** | Brief 一時 ID（Knowledge ID とは別）。空・制御文字不可。未指定時は自動生成可。 |
| **title** | 執筆企画タイトル。CLI 入力優先。未指定かつ Editorial headline がある場合はそれを用いる。それ以外は Knowledge title 系フォールバック / `(untitled brief)`。 |
| **purpose** | 人間入力の自由文字列。既定 `research-note`。AI 判断しない。 |
| **status** | Brief 自身の状態。今回固定 `draft`（Knowledge status とは別）。 |
| **generatedAt** | ISO8601。生成時刻（注入可能）。 |
| **knowledge** | Writer 向け要約表示（id / title / summary / status / version / confidence / notes / updatedAt）。 |
| **claims** | Knowledge ごとに 1 件。`text` は summary の**非変形**参照（後方互換）。 |
| **evidence** | 複数 Knowledge の参照 Identity 統合（stories / concepts / posts）。本文は持たない。 |
| **evidenceProvenance** | 各 ref → 所属 knowledgeIds。 |
| **gaps** | 機械的不足検出のみ。 |
| **constraints** | Writer 固定制約。Editorial risks がある場合は `編集注意: …` として追加可。 |
| **sourceSnapshot** | 参照 Knowledge の id / version / status / updatedAt 等。 |
| **statistics** | 件数・confidence 集計。 |

#### Editorial Brief v2（追加・任意）

`--stories <path>`（stories.js `--json` 相当）指定時のみ `editorial` を付与する。未指定時は従来 Brief（`editorial` なし）で後方互換。

```text
editorial: {
  version: 2,
  articles: [
    {
      knowledgeId, storyId,
      headline,   // タイトル候補。カテゴリ名のみは避ける
      lead,       // 冒頭 2〜3 文の指示
      angle,      // 強調観点を 1 つ
      whyNow,     // 今日読む理由（無ければ空文字）
      audience,   // 入力から明確な場合のみ。推測しない（空可）
      keyFacts[], // 必ず伝える短文事実
      evidence[], // { url, authorName, authorHandle, postedAt, text }
      risks[]     // 書いてはいけないこと・注意
    }
  ]
}
```

Editorial は Story → Concept → Topic → Post を参照して決定論的に構築する。Knowledge summary だけで headline / angle を作らない。入力にない事実を追加しない。

claim usable 判定:

- summary 非空かつ Evidence ≥ 1 → `usable: true`
- summary 空または Evidence 0 → `usable: false`（拒否せず gap で表現）
- published 以外を明示許可した場合は reason 等で状態を明示

gaps（例）: empty-summary / no-evidence / low-confidence / non-published / archived / no-evidence-type / mixed-status / no-knowledge。  
confidence 低さの既定閾値は **50**（`--confidence-threshold` で変更可）。

Brief Validation: 既存フィールドに加え、`editorial` がある場合は version=2・articles 配列・各 article の型を検証する。`editorial` 欠落（レガシー Brief）は有効。

CLI は Knowledge 0 件でエラー。Brief 生成は Knowledge version を変更しない。Pipeline は workDir の `stories.json` を Brief へ渡してよい。

### 4.17 Editorial Plan（Version 2.2）

| 項目 | 内容 |
|---|---|
| **役割** | 人間が決める**執筆方針**。誰に・何を・どの形式で・どの長さで伝えるかを定義する。 |
| **実装** | `lib/editorial-plan-core.js` / `editorial-plan.js`。AI・記事本文生成なし。 |
| **永続** | **非永続**。保存しない。version / updatedAt はない（再生成する）。 |
| **非変更・非読込** | Knowledge Brief を変更しない。Knowledge Base を読まない・変更しない。 |

Editorial Plan は Knowledge でも Brief でも記事本文でもない。事実・Evidence・Knowledge 本文を Plan に保存しない。Brief の constraints と Plan の constraints は別物であり、Writer が Brief + Plan を統合する。

CLI 出力契約: `build` は **純 Plan JSON** を標準出力する。入力ファイルは読み取り専用。

主要フィールド:

| フィールド | 契約 |
|---|---|
| **id** | 一時 ID。空・制御文字不可。未指定時 `plan-<UTC timestamp>`。 |
| **title** | 人間入力優先。未指定時は Brief.title → `(untitled plan)`。Brief / Knowledge の title は変更しない。Brief の purpose 等は自動採用しない。 |
| **purpose** | 自由文字列。既定 `explain`。AI 判断しない。 |
| **audience** | `{ description, knowledgeLevel }`。knowledgeLevel は `beginner` \| `intermediate` \| `advanced` \| `expert` \| `unspecified` に制限。 |
| **format** | 推奨: `article` / `explainer` / `news-summary` / `research-note` / `internal-memo` / `social-post` / `outline`。空・制御文字不可の**自由文字列も許可**（推奨外は custom）。既定 `article`。 |
| **tone** | `{ style, formality }`。style は自由文字列（既定 `clear`）。formality は `casual` \| `neutral` \| `formal`（既定 `neutral`）。 |
| **language** | 出力言語。空・制御文字不可。既定 `ja`。厳密な ISO 検証はしない。 |
| **length** | `{ unit, target, minimum, maximum }`。unit は `characters` \| `words`（日本語既定 `characters`）。いずれも 1 以上の整数。`minimum ≤ target ≤ maximum`。Writer は厳密一致ではなく目安として扱う。 |
| **structure** | `{ id, label, required }[]`。順序維持。id 重複不可。既定: introduction / body / conclusion。セクション本文は作らない。 |
| **requiredPoints** | 必須観点の文字列配列。空不可・重複除去・初出順。 |
| **excludedPoints** | 禁止内容の文字列配列。同上。 |
| **constraints** | Plan 固有の Writer 制約のみ。Brief constraints をコピーしない。 |
| **briefReference** | 任意。`{ id, generatedAt, title?, knowledgeIds? }`。Brief 全体は複製しない。Brief 入力時は `validateBrief` で完全検証し、参照の id / generatedAt を記録。 |
| **createdAt** | ISO8601。生成時刻。 |

Plan Validation: Plan 専用。Brief / Knowledge として validate しない。上記フィールド・length 整合・structure・配列・briefReference・createdAt を確認。記事本文・Knowledge/Evidence 本文フィールドを拒否。

### 4.18 Writer v2 — Deterministic Markdown Renderer（Version 2.12）

| 項目 | 内容 |
|---|---|
| **役割** | Knowledge Brief（事実・編集指示）と Editorial Plan（方針）を **決定論的に Markdown 草稿へ整形**する Renderer。任意の Story JSON がある場合は投稿・Concept の具体情報を本文へ反映する。 |
| **実装** | `lib/writer-core.js` / `lib/writer-content.js` / `lib/writer-editorial.js` / `lib/writer-editorial-validate.js` / `writer.js`。AI / LLM / 自動要約なし。 |
| **入力** | Brief + Plan（必須）。`--stories`（任意・stories.js `--json` 相当）。Knowledge Base 非依存。 |
| **出力** | Markdown 文字列（標準出力）。**保存しない。** 同一入力 → 同一出力。 |
| **非変更** | Brief / Plan / Knowledge / Knowledge Base / Story 生成ロジックを変更しない。 |

事実ソースは Story（および Brief claims 互換）。**Editorial Brief（`brief.editorial.articles[]`）は編集指示**であり、単独の事実ソースにはしない。`editorial` 欠落・空・無効時は従来の Story ベース Writer へフォールバックする。

#### Editorial Brief 利用（EP-001）

対象 article の選択（決定的）: storyId 一致 → knowledgeId 一致 → Brief.title=headline → Plan.title=headline → 配列先頭。

利用フィールド: `headline`（タイトル候補）/ `lead`（リード）/ `angle`（焦点）/ `whyNow`（なぜ重要か）/ `keyFacts`（重複除去して補足）/ `risks`（禁止事項。本文非表示）。`audience` は保持のみ（本文へ読者ラベルを出さない）。

タイトル優先: 具体的な Plan.title（Daily/カテゴリ/slash 以外）→ Editorial headline → Story 由来タイトル → Brief.title。Story と矛盾して不採用となった Editorial headline と同一の Plan/Brief title はスキップする。

#### Editorial Brief 検証（EP-002）

Writer は Editorial 情報を **Story と照合したうえで**利用する。矛盾時は Story を優先し、確認できない事実は Writer へ渡さない。

- **Evidence 照合**（決定的）: URL 完全一致 → authorHandle+postedAt+text → authorHandle+text → postedAt+text → text。一致しない Evidence は事実ソースにしない（内部 `validation.warnings` のみ）。
- **keyFacts**: Story / 一致済み根拠で確認できる場合のみ採用。明白な意味的重複は除去。日付・価格などの明白な矛盾は不採用し `validation.conflicts` へ記録。
- **headline / lead / whyNow**: Story と矛盾または未確認の断定を含む場合は不採用（lead は安全な文だけ残してよい）。whyNow は時間性の根拠がある場合のみ。
- **validation**: 内部診断（`matchedEvidenceCount` / `rejectedKeyFacts` / `rejectedFields` / `conflicts` / `warnings`）。読者向け Markdown には出さない。検証失敗時は利用可能な情報だけで従来 Writer へフォールバックする。

#### Story 入力がある場合（v2 本文）

代表 Concept / Topic は importance → postCount → newestPostedAt → 配列順で決定。投稿は URL（なければ author+postedAt+text）で重複除去する。

推奨構成: H1 → リード → `## 何が起きたか` → `## なぜ重要なのか` → `## 注目ポイント`（任意）→ `## 情報源`（投稿がある場合のみ）。

読者向け本文に Confidence / Evidence count 等の内部診断値を出さない（末尾 HTML コメントへ集約）。

#### Story 入力がない / 具体情報不足（後方互換フォールバック）

従来どおり Plan.structure 順。introduction / conclusion は固定テンプレート。本文に Brief.claims を配置（言い換えない）。`usable=false` は固定注記。gaps は「注意事項」。タイトル: Plan.title → Brief.title → `(untitled article)`。

HTML コメント metadata:

- Constraints（Plan.constraints + Brief.constraints）
- Statistics（Brief.statistics）
- Source Snapshot（Brief.sourceSnapshot の id / version 等）

入力検証: Brief valid、Plan valid、briefReference がある場合は id / generatedAt 一致。`--stories` 欠落でも Brief+Plan のみでフォールバックしクラッシュしない。

Pipeline は `writer-selection` で `edition.selected[]` から `stories-selected.json` を作り Writer へ渡す。Plan.title 未指定時は **具体的な Brief.title（Editorial headline）を優先**し、それがない場合のみ Story 由来タイトルを Plan に同期して Article Report の H1 照合を維持する。

### 4.19 Pipeline Runner（Version 2.4）

| 項目 | 内容 |
|---|---|
| **役割** | 既存 CLI を順番に呼び、収集〜 Markdown 草稿〜 Article Report までを 1 コマンドで実行する**オーケストレーション層**。 |
| **実装** | `lib/pipeline-runner.js` / `pipeline.js`。ビジネスロジック（分類・Brief 構築・執筆推論など）は持たない。 |
| **非変更** | 各レイヤーの契約・CLI 実装を書き換えない。独自 validate を追加しない（各 CLI の既存検証を利用）。 |

標準実行順:

```text
connect → analyze → analyze-ai → enrich
→ editor → concept → story
→ knowledge → knowledge-base
→ brief → editorial-plan → writer（`--stories` 任意）
→ article-report
→ Markdown (stdout のみ)
```

`--no-api` / `--from-enriched` では connect / analyze-ai / enrich をスキップし、既存 `output/timeline_enriched.json` を利用する（API・Chrome 不要）。途中失敗時は成功済みステップを報告し非 0 終了。Markdown は既定で保存しない（`--output` で任意保存可）。進捗は stderr。stdout は Markdown のみ（Report JSON と混在させない）。`--report-output` 指定時のみ Report JSON を保存。未指定でも Report 生成・検証は実行する。`reviewSummary.status=fail` のとき Pipeline は失敗（非 0）。warning のみなら成功。Writer には workDir の `stories.json` を渡し、Plan.title 未指定時は具体的な Brief.title を優先（なければ Story 由来タイトル）。

### 4.20 Article Report v1（Version 2.5）

| 項目 | 内容 |
|---|---|
| **役割** | Brief + Editorial Plan + Writer Markdown から、記事の根拠・不足・採用状況を確認する**診断・監査用の派生データ**。記事本文ではない。 |
| **実装** | `lib/article-report-core.js` / `article-report.js`。AI / 外部 URL / Evidence 本文取得なし。 |
| **入力** | Brief JSON + Plan JSON + Writer Markdown（v1 フォールバックまたは v2。すべて読み取り専用）。Knowledge Base は読まない・変更しない。 |
| **出力** | Article Report JSON（stdout）。`--output` 指定時のみ atomic write で保存。Knowledge Base 配下へは保存しない。 |
| **非 SoT** | Report は Source of Truth ではない。履歴機能なし。Brief / Plan / Markdown / Knowledge を変更しない。 |

#### Report 構造（最低限）

`id`, `generatedAt`, `article`, `sources`（brief / plan / knowledge）, `claims`, `evidence`, `confidence`, `gaps`, `constraints`（brief / plan 分離）, `sourceSnapshot`, `checks`, `reviewSummary`, `statistics`。

Report id は一時識別子（推奨 `report-<UTC timestamp>`）。`--id` で指定可。trim 後空不可・制御文字不可。ファイル名契約には使わない。`generatedAt` は ISO8601（時刻注入可）。

#### article.length 計測規則

| unit | 規則 |
|---|---|
| `characters` | HTML コメント除去 → 改行除外 → その他 Markdown 文字は含める → Unicode code point 数（`Array.from`） |
| `words` | HTML コメント除去 → 空白区切り → 空トークン除外（厳密な自然言語分割はしない） |

`withinTargetRange`: Plan.length の minimum と maximum がある場合のみ判定。target のみなら `null` 可。

#### Markdown 解析範囲

フル Markdown パーサは使わない。Writer 出力契約（v1 フォールバックおよび v2 見出し）:

- 先頭 H1（Plan.title を正本とし、H1 不一致は error check。Report 生成自体は可能）
- H2 見出し数（HTML コメント内は除外）
- `sectionCount`: planned（Plan.structure 由来）と additional（例: 「注意事項」）を分離
- claim 完全一致（言い換え推測・部分一致禁止。HTML コメントは照合対象外）
- 固定 metadata HTML コメント（Constraints / Statistics / Source Snapshot）
- 固定「注意事項」見出し

同一 `claim.text` が複数 Knowledge にある場合、Knowledge ID 単位の出現位置は追跡しない。テキスト存在をもって各 usable claim の `rendered` を判定する（制限を契約として明記）。

#### claims / evidence / confidence

- `claims.items[].text` は Brief claim.text の非変形。`usable` は Brief の値。`rendered` は visible Markdown への完全一致。
- usable 欠落 / unusable 本文混入は error check。
- Evidence は Brief 統合 Evidence の件数集計のみ（本文未取得）。
- confidence は Brief.knowledge から集計。threshold 既定 50（`--confidence-threshold`）。0 件でも安全。

#### gaps と checks

- `gaps`: Brief.gaps を非変形で含める。Report が意味的 gap を推論しない。
- 入出力整合性（タイトル不一致・claim 欠落・長さ範囲外等）は `checks` へ記録。
- constraints の意味的遵守は判定しない（metadata 記録の有無までは検証可）。

#### sourceSnapshot

Brief.sourceSnapshot の id / version / status / updatedAt を保持。Markdown Source Snapshot コメントとの対応を checks で確認。Knowledge Base への鮮度確認・stale 判定は行わない。

#### checks / reviewSummary / readyForAiRewrite

checks: `type`, `status`（pass|warning|error）, `severity`（info|warning|error）, `message`, `details`。

最低限: brief-valid, plan-valid, writer-input-valid, brief-reference-match, markdown-title-match, structure-present, usable-claims-rendered, unusable-claims-not-rendered, gaps-section-present, constraints-metadata-present, statistics-metadata-present, source-snapshot-metadata-present, target-length, input-files-read-only。

`reviewSummary.status`: error があれば `fail`、なければ warning があれば `warning`、それ以外 `pass`。

`readyForAiRewrite=true` の機械的条件（すべて必須）:

1. error check が 0
2. Writer 入力 valid
3. usable claim が 1 件以上、かつすべて rendered
4. briefReference 一致（参照がある場合）
5. Brief.knowledge がすべて `published`（non-published は warning とし、ready=false）

low confidence / Brief gaps / length 範囲外は warning として許容（ready を直接は落とさないが、error があれば ready=false）。

#### statistics / Validation

Report 固有集計（knowledgeCount, claim 各件数, evidenceCount, gapCount, constraintCount, section / length, check 各件数 等）。Brief.statistics の単純コピーではない。

Validation は Report 自身の整合（件数・confidence 範囲・checks と reviewSummary・sourceSnapshot 重複なし・knowledge 対応・ready 規則・本文非複製）を検証する。Report を Brief / Plan / Knowledge として validate しない。

#### CLI / Pipeline

```text
node article-report.js build --brief … --plan … --article …
node article-report.js validate --input …
```

Brief Reference 不一致・入力不正は CLI エラー。タイトル不一致や claim 欠落は Report 生成可だが `reviewSummary.status=fail`。Pipeline では fail を失敗扱い。stdout に Markdown と Report JSON を混在させない。

### 4.21 Daily Edition Builder v1（Version 2.6）

| 項目 | 内容 |
|---|---|
| **役割** | 同日に生成された複数の Writer Markdown + Article Report を、**決定論的に日刊版 Markdown へ編集・配置**する。新しい事実は作らない。 |
| **実装** | `lib/daily-edition-core.js` / `daily-edition.js`。AI / URL 取得 / 要約 / 言い換えなし。 |
| **入力** | Daily Edition Manifest + 各 item の article Markdown / Article Report（読み取り専用）。Knowledge Base / Brief / Editorial Plan は読まない。 |
| **出力** | Daily Edition Markdown（stdout）と診断用 Edition Report JSON（`--report-output` 時のみ保存）。 |
| **非 SoT** | Daily Edition / Edition Report は Source of Truth ではない。履歴なし。自動実行（cron 等）なし。 |

#### Manifest

最低限: `date`（YYYY-MM-DD）, `items`（1 件以上）。任意: `title`, `subtitle`, `categoryOrder`, `excludedCategories`, `metadata`, `editionId`。

各 item: `article`, `report`, `category`（必須）。`priority`（任意・有限数。未指定は 1000）。

パス解決: Manifest ファイルのディレクトリを基準とする相対パス、または絶対パス。同一 article パス / 同一 report パスは Manifest validation エラー。

#### 掲載可否（Article Report 正本）

掲載可能（既定）: `reviewSummary.status` が `pass` または `warning`、`readyForAiRewrite=true`、`errorCount=0`、`usableClaimCount>=1`、Report valid、Markdown H1 と Report `article.title` 一致、対応不正なし。

掲載不可: `status=fail`、`errorCount>=1`、`usableClaimCount=0`、`readyForAiRewrite=false`、Report validation 失敗、H1 不一致、読込失敗、`excludedCategories`、重複（Report ID / 同一 H1+category）。

`--exclude-warnings`: `status=warning` を非掲載（`pass` のみ）。

除外理由は Edition Report に記録。本文へは含めない。

#### category / 順序

カテゴリは Manifest `item.category` のみ（本文から推測しない）。表示名マップ（politics→政治 等）。未知カテゴリは元文字列を表示。元 category は保持。

categoryOrder 優先: Manifest.categoryOrder → 既定順（politics, economy, society, international, technology, ai, culture, entertainment, sports, other）→ 未知は辞書順で後方。

カテゴリ内記事順: priority 昇順 → confidence average 降順 → title Unicode 順 → Manifest 元順。現在時刻は使わない。

#### Markdown 編集

- Edition H1 = Manifest.title または `Daily Edition`。日付は別行。subtitle 任意。
- 固定導入文のみ（意味的要約なし）。
- 記事 H1 → Edition 内 H3。本文見出し: H1→H3, H2→H4, H3→H5, H4→H5, H5→H6, H6→H6。
- コードブロック内・HTML コメント内の `#` は変換しない。
- Writer 末尾 HTML metadata（Constraints / Statistics / Source Snapshot）は Edition 本文から除外（Edition Report から参照可）。
- 先頭 H1 除去後の本文は言い換えない。
- warning がある掲載記事は末尾 `## 編集上の注意` に checks warning / reviewSummary.reasons / gaps.message を機械列挙（新規注意を作らない。0 件なら省略）。
- 末尾 HTML コメントで Daily Edition Metadata（id / date / generatedAt / included / excluded / categories / source reports）。

#### Edition Report

診断 JSON（本文と分離）。`id`, `date`, `generatedAt`, `title`, `manifest`, `articles`（included/excluded/items）, `categories`, `checks`, `reviewSummary`（`publishable`）, `statistics`。

checks 最低限: manifest-valid, article-files-readable, report-files-readable, report-valid, article-report-title-match, article-count, included-article-count, duplicate-articles, category-order, no-failed-articles-included, edition-markdown-generated, metadata-present, input-files-read-only。

`publishable=true`: error check 0、掲載 1 件以上、fail 記事未掲載、Edition Report valid、Markdown 生成成功。warning は許容（`--exclude-warnings` 時は warning 未掲載も必要）。

`totalCharacterCount`: Daily Edition Markdown から HTML コメント除去後の Unicode code point 数。

#### CLI / Pipeline

```text
node daily-edition.js build --manifest … [--output …] [--report-output …] [--exclude-warnings]
node daily-edition.js validate --input …
```

stdout は Daily Edition Markdown のみ。進捗は stderr。Markdown と JSON を混在させない。

Pipeline: `--daily-manifest` 指定時のみ Daily Edition step（article-report の後）。`--daily-output` 必須。`--daily-report-output` 任意。通常記事 Markdown の stdout 契約は維持（Daily Edition はファイル保存）。未指定時は既存挙動のまま。

### 4.22 Daily Runner v1（Version 2.7）

| 項目 | 内容 |
|---|---|
| **役割** | 1 日分の Pipeline + Daily Edition を安全に実行する**運用オーケストレーション層**。記事生成・分類・Edition 編集ロジックは持たない。 |
| **実装** | `lib/daily-runner-core.js`（純粋計画・Report） / `lib/daily-runner.js`（I/O・lock・spawn） / `daily-runner.js`（CLI）。 |
| **非責務** | AI 意味判断、Knowledge 直接変更、API キー処理、OS スケジューラ登録、自動公開。 |
| **非 SoT** | runs 配下の成果物・Run Report は Source of Truth ではない。 |

#### runDate / timezone / runId / attempt

- `runDate`: YYYY-MM-DD（実在日）。既定は指定 timezone のローカル日付。UTC へ勝手に変換しない。`--date` で明示可。時刻注入可。
- `timezone`: IANA（`Intl` 受理）。未指定は `Intl.DateTimeFormat().resolvedOptions().timeZone`。Pipeline 内のニュース時刻は書き換えない。
- `runId`: 既定 `daily-run-<date>`。retry 時 `daily-run-<date>-rN`。空・制御文字・パス区切り・`.`/`..` 不可。
- `attempt`: 1 始まり。同日 failed の再実行は `--retry` で attempt を増やし、別ディレクトリへ書く（旧成果物を上書きしない）。

#### ディレクトリ

```text
runs/<YYYY-MM-DD>/
  .lock
  attempts/<N>/
    input/ work/ output/ logs/
    manifest.json
    run-config.json
    run-report.json
    output/article.md
    output/article-report.json
    output/daily-edition.md
    output/daily-edition-report.json
```

work / output / logs / run-report / lock を分離。Knowledge Base を日付ディレクトリへ複製しない。paths は run directory 外へ逸脱させない。

#### lock / stale / retry / completed 保護

- `.lock` を `wx` 排他作成。内容: runId, runDate, pid, hostname, startedAt。
- 実行中 lock → 拒否（exit 3）。
- stale（`startedAt` から `--stale-lock-minutes` 既定 180 分超）は `--recover-stale-lock` なしでは拒否。自動削除禁止。
- completed / completed_with_warnings → 再実行拒否（exit 4）。`--force` なし。`--retry` でも completed は上書きしない。
- failed / interrupted → `--retry` なしでは拒否。retry 時は新 attempt ディレクトリ。

#### run-config / Manifest

実行前に正規化設定を `run-config.json` へ atomic 保存。API キー・Cookie・Authorization・環境変数全文・不要な個人情報は保存しない。

Daily Runner が 1 記事 Manifest を生成（category は `--category`、既定 `other`。本文から推測しない）。

#### 実行順 / subprocess

prepare → pipeline → verify-article → build-manifest → daily-edition → verify-edition → finalize。

`spawn(process.execPath, [script, ...args], { shell: false })`。shell 文字列連結禁止。stdout/stderr は各ログファイルへ保存。Runner 自身の stdout に Markdown を流さない。

#### Daily Run Report

`id`, `runDate`, `timezone`, `attempt`, `startedAt`, `completedAt`, `status`, `paths`, `options`, `steps`, `checks`, `statistics`, `errors`。

status: `planned` | `running` | `completed` | `completed_with_warnings` | `failed` | `skipped` | `interrupted`。

steps 最低限: prepare, pipeline, verify-article, build-manifest, daily-edition, verify-edition, finalize。

checks は機械的（lock / 成果物存在 / Article Report・Edition Report の既存結果利用）。記事品質の意味再判定はしない。

atomic write: run-config / manifest / run-report。

#### CLI / stdout / exit

```text
node daily-runner.js run …
node daily-runner.js plan …   # dry-run 相当。ファイル変更なし
node daily-runner.js validate --input …
```

成功時 stdout は結果 JSON。進捗は stderr。`--dry-run` / `plan` は Run Plan JSON のみ（lock・Pipeline・保存なし）。

exit code: `0` 成功 / `1` 実行失敗 / `2` CLI 検証 / `3` lock 競合 / `4` 完了済み / `5` Run Report 検証失敗。

SIGINT / SIGTERM: 子プロセス終了試行、status=`interrupted`、lock 解除試行、exit 非 0。

API アクセスは Pipeline 責務。`--no-api` は既存 Pipeline 契約に従う。OS スケジューラ登録は Launchd Adapter（2.8）が担う。

### 4.23 Launchd Adapter v1（Version 2.8）

| 項目 | 内容 |
|---|---|
| **役割** | Daily Runner を macOS **ユーザー LaunchAgent** から定時実行するための OS 連携層。記事生成ロジックを持たない。 |
| **実装** | `lib/launchd-core.js`（純粋） / `lib/launchd-adapter.js`（I/O・launchctl） / `launchd.js`（CLI）。 |
| **対応** | macOS（darwin）のみ。`~/Library/LaunchAgents` のみ。system daemon / `/Library` / sudo / root domain 禁止。 |
| **非 SoT** | plist・Adapter 設定は Source of Truth ではない。 |

#### Label / plist パス

既定 Label: `com.personal-editorial-intelligence.daily-runner`。英数字・`-`・`_`・`.` のみ。先頭末尾ピリオド・連続ピリオド・空白・パス区切り禁止。plist: `~/Library/LaunchAgents/<label>.plist`。

#### schedule

`--hour`（0–23）と `--minute`（0–59）は generate / install / plan で必須。ローカル時刻。`StartCalendarInterval`。

Weekday（本契約）: `1=Sunday` … `7=Saturday`。未指定は毎日。複数は配列。重複は validation エラー。

#### パス / ProgramArguments

Node.js と `daily-runner.js` は絶対パス。`WorkingDirectory=projectDir`。`shell=false`・配列引数。相対 `node` 禁止。PATH / nvm に依存しない。

定時実行で渡す Daily Runner 引数例: `run --timezone … --runs-dir … --days … --base-dir … --category …` 等。`--date` / `--retry` / `--recover-stale-lock` / `--dry-run` は渡さない。runDate は実行時に Daily Runner が timezone ローカル日付で解決。stale lock の自動回収はしない。

#### plist 構造

`Label`, `ProgramArguments`, `WorkingDirectory`, `StartCalendarInterval`, `StandardOutPath`, `StandardErrorPath`, `ProcessType=Background`。`RunAtLoad` は指定時のみ。`KeepAlive` / `StartInterval` / `EnvironmentVariables` 禁止。XML escape（`& < > " '`）。同一入力は byte 一致（generatedAt を plist に含めない）。

ログ既定: `<projectDir>/logs/launchd/daily-runner.{stdout,stderr}.log`（Daily Runner 日付別 logs とは別）。install 時のみディレクトリ作成。

#### CLI

`generate`（stdout plist / `--output` 時のみ保存。OS 非変更） / `plan`（JSON・非変更） / `validate-plist` / `install`（明示時のみ launchctl） / `uninstall` / `status` / `print-plist`。

install: 既存同一内容は idempotent。内容差異は拒否。`--replace` 時のみ backup + bootout + 書込 + bootstrap。失敗時 rollback 試行。

launchctl: `bootstrap gui/<uid> <plist>` / `bootout gui/<uid> <plist>` / `print gui/<uid>/<label>`。uid=`process.getuid()`。kickstart 必須にしない。

設定 JSON: `.runtime/launchd/<label>.json`（version, paths, schedule, plistHash, installedAt）。secrets 非保存。plist SHA-256 で改変検知。

#### exit code

`0` 成功 / `1` 操作失敗 / `2` CLI 検証 / `3` 非対応 OS / `4` 既存 plist 競合 / `5` plist 検証失敗 / `6` launchctl 失敗 / `7` status 不整合。

Chrome 自動起動なし。API キー管理なし。自動公開・通知なし。

---

## 5. Data Invariants

現状実装が保証する（または運用上必須とする）不変条件。

1. **URL は投稿識別子である。** 蓄積・進捗・重複除外のキーは `url` である。
2. **Raw は分類レイヤを持たない。** `timeline.json` に `analysis` / `finalAnalysis` / `enrichment` を書き込まない。
3. **analyze は `analysis` のみを追加する。** Raw フィールドを改変しない。
4. **analyze_ai は `finalAnalysis` のみを追加する。** `analysis` を上書きしない。
5. **enrich_ai は `enrichment` のみを追加・置換する。** `analysis` / `finalAnalysis` を変更しない。カテゴリ再分類を行わない。
6. **search / digest / editor / concepts / stories は投稿データを永続変更しない。** 読み取り専用消費者である。
7. **カテゴリ名は固定集合である。** 許可名は `config/categories.json` のカテゴリキー（「その他」を含む）に一致する。
8. **キーワード分類の confidence は `"high"` \| `"medium"` \| `"low"` である。**
9. **AI 分類の confidence は `0`〜`1` の数値である。**
10. **完了した `enrichment.importance` は `1`〜`5` の整数である。**
11. **`search.js` / `digest.js` / `editor.js` / `concepts.js` / `stories.js` の正式入力は `output/timeline_enriched.json` である。** 他の timeline ファイルへの自動フォールバックはない。
12. **同一 `url` はパイプライン上で一意である**（収集時に重複除外される）。
13. **既存投稿の `collectedAt` は再収集で更新しない。**
14. **AI 対象選定（analyze_ai）:** `analysis.confidence === "low"` または `analysis.category === "その他"`。それ以外は API せず `finalAnalysis.source = "keyword"` とする。
15. **Concept Library / Story Engine は Source of Truth ではない。** 実行時の派生ビューであり、Concept / Story 集計を投稿や専用ファイルへ永続化しない。
16. **Story 定義の正本は `config/stories.json` である。** 実行時の Story 集計値は定義 Identity ではない。
17. **Knowledge Object は Knowledge Layer の永続 Source of Truth である（Knowledge Base）。** 投稿本文の複製ではなく Evidence 参照を持つ。status 一覧と遷移の正本は `config/knowledge-status.json`。Draft Workflow（`knowledge.js`）は入力を破壊的変更せず保存しない。永続化は Knowledge Base（`items/` が現行正本、`history/` は変更不能スナップショット、`index.json` は派生）。operation メタは非永続。version は新規 1・更新は現行+1 のみ。完全な複数ファイル・トランザクションは v1 対象外（index は再生成可能）。
18. **Brief は編集指示用の派生ビューである（Editorial Brief v2）。** Knowledge Base を変更しない。Brief は Knowledge でも永続 SoT でもない。既定は published のみ。claim は summary の非変形参照（互換）。`--stories` 時は editorial（headline / angle / keyFacts 等）を追加する。今回 Brief は保存しない。
19. **Editorial Plan は人間入力の執筆方針である。** Knowledge / Brief / 記事本文ではない。Brief を変更せず、Knowledge Base を読まない・変更しない。事実や Evidence 本文を持たない。今回保存しない。Writer は Brief + Plan を統合する。
20. **Writer v2 は決定論的 Markdown Renderer である。** Brief（事実）と Plan（方針）を入力とし、任意で Story JSON を受けて具体本文を生成する。Knowledge Base 非依存。推論・言い換え・AI 禁止。同一入力は同一 Markdown。出力は stdout のみ（保存しない）。Story なし時は v1 相当へフォールバックする。
21. **Pipeline Runner はオーケストレーションのみである。** 既存 CLI を順に呼ぶ。独自の分類・執筆ロジックや独自 validate を持たない。`--no-api` 時は既存 enriched を再利用し API を呼ばない。stdout は Markdown のみ。Article Report は stderr 進捗と任意の `--report-output`。
22. **Article Report は記事の診断・監査用派生データである。** 記事本文ではない。Brief + Plan + Writer Markdown のみを観察・集計する。Knowledge Base 非依存。AI・外部取得・自動修正なし。非 SoT・履歴なし。入力を変更しない。
23. **Daily Edition は複数記事の決定論的編集結果である。** 新しい事実を生成しない。Writer Markdown を規則で配置するだけ。Knowledge Base / Brief / Plan 非依存。AI・自動実行・外部取得なし。非 SoT。入力は読み取り専用。
24. **Daily Runner は運用オーケストレーションのみである。** 日付単位で Pipeline / Daily Edition を spawn する。記事ロジック・category 推測・API キー処理を持たない。completed run を上書きしない。shell 不使用。非 SoT。
25. **Launchd Adapter は macOS ユーザー LaunchAgent のみを扱う。** system daemon / sudo 禁止。plist に secrets を保存しない。Node / script は絶対パス。KeepAlive 禁止。実登録は install 明示時のみ。非 SoT。

---

## 6. Fallback Rules

現状仕様のみを記す。改善案は書かない。

### 6.1 category

| 項目 | 内容 |
|---|---|
| **正式値** | `finalAnalysis.category` |
| **フォールバック** | enrich 入力・search / digest / editor / concepts / stories 読取: `finalAnalysis.category` → `analysis.category` → `"その他"`（`finalAnalysis.category` がある場合はそれを優先）。 |
| **フォールバック不可** | 正式値そのものを `analysis.category` に置き換えて保存してはならない。 |

### 6.2 date

| 項目 | 内容 |
|---|---|
| **正式値（期間・ソート）** | `postedAt` |
| **フォールバック** | なし（`collectedAt` へは落ちない） |
| **フォールバック不可** | 期間条件指定時、`postedAt` 欠損・不正は不一致（候補から除外）。digest で期間未指定のときは `postedAt` 欠損でも候補に残る。 |

### 6.3 summary

| 項目 | 内容 |
|---|---|
| **正式値** | `enrichment.summary` |
| **フォールバック（表示）** | 空なら `text`。digest ではさらに空なら固定文言「要約なし」 |
| **フォールバック不可** | summary が無いことを enrichment 未完了と同一視しない（表示フォールバックとは別） |

### 6.4 author

| 項目 | 内容 |
|---|---|
| **正式値** | `authorName` / `authorHandle` |
| **フォールバック（表示）** | ハンドル欠損時は表示上 `@unknown` 等 |
| **フォールバック不可** | 著者キー自体が無い旧データは、著者検索・著者多様性制限の対象にならない場合がある |

### 6.5 tags

| 項目 | 内容 |
|---|---|
| **正式値** | 単一正本なし。人間向け表示は `finalAnalysis.tags` と `enrichment.tags` の合算 |
| **フォールバック** | 片方空でも他方のみで表示しうる。search 照合は `matchedKeywords` も補助対象に含めてよい |
| **フォールバック不可** | `matchedKeywords` を人間向け Tags 表示の代替正本にしない |

### 6.6 reason

| 項目 | 内容 |
|---|---|
| **正式値** | 分類: `finalAnalysis.reason` / 重要度: `enrichment.reason` |
| **フォールバック** | digest 表示で enrichment.reason 空なら「(なし)」 |
| **フォールバック不可** | 分類 reason と重要度 reason の相互フォールバックはしない |

---

## 7. Data Lifecycle

| 種別 | ファイル例 | 保存対象 | 再生成可能 | API 再実行 |
|---|---|---|---|---|
| **Raw** | `timeline.json`, `timeline.csv` | はい（収集の正本） | 再収集のみ | 不要 |
| **Intermediate** | `timeline_analyzed.json`, `timeline_ai.json` | はい | analyzed は API 不要。ai は条件付き | ai 段階は未キャッシュ分で必要 |
| **Final（運用）** | `timeline_enriched.json` | はい | enrich 再実行で可能 | 未キャッシュ分で必要 |
| **Progress** | `ai_progress.json`, `enrich_progress.json` | はい（再開用） | 削除してよい（処理状態がリセットされる） | 進捗削除後、cache が無ければ必要 |
| **Cache** | `ai_cache.json`, `enrich_cache.json` | はい（コスト回避用） | 削除してよい（同一内容でも再課金しうる） | 削除後は再実行時に必要になりうる |
| **Human review** | `output/review/*`, `uncategorized.*`, `review_low_confidence.txt` | 任意 | analyze で再生成 | 不要 |
| **Digest output** | `output/digest_*.md` 等 | 任意 | digest で再生成 | 不要 |

寿命の原則:

- Raw を失うと、それ以降の系列は収集なしに完全復元できない。
- Intermediate / Final は、直前段階と設定・（必要なら）cache があれば作り直せる。
- Progress / Cache は再開とコスト最適化のための付帯データであり、投稿の Source of Truth ではない。

---

## 8. Cache Contract

Progress / Cache は投稿の Source of Truth ではない。再開と結果再利用のための付帯データである。

### 8.0 再利用の原則

| 概念 | 意味 |
|---|---|
| **Identity** | 投稿識別子。現在は `url`。progress の格納キーに用いる。 |
| **Input Fingerprint** | AI へ渡す意味上の入力の安定ハッシュ。 |
| **Execution Contract** | `model` + `promptVersion` + `schemaVersion` + `inputFingerprint` |

AI 結果を再利用できるのは、**Input Fingerprint と Execution Contract が現在の実行と一致する場合のみ**である。  
**URL が同一であるだけでは完了・キャッシュヒットとしない。**

analyze_ai の Input Fingerprint に含むもの（最低限）:

- `authorHandle`, `text`
- keyword `category`, `confidence`
- `categoryScores`, `matchedKeywords`

enrich_ai の Input Fingerprint に含むもの（最低限）:

- `authorHandle`, `text`
- final category
- classification `source`, `confidence`, `reason`, `tags`

Cache key は Execution Contract 全体の安定ハッシュである（model / promptVersion / schemaVersion / inputFingerprint を含む）。

### 8.1 Progress（`ai_progress.json` / `enrich_progress.json`）

| 項目 | 内容 |
|---|---|
| **Responsibility** | 現在の入力・実行契約に対する処理完了記録 |
| **Key** | 投稿 `url`（Identity） |
| **完了条件** | エントリの `inputFingerprint` / `model` / `promptVersion` / `schemaVersion` が現在の契約と一致し、かつ結果フィールドが揃っていること |
| **保存する契約情報** | `url`, `inputFingerprint`, `model`, `promptVersion`, `schemaVersion`, `completedAt`, `source`（および段階の結果フィールド） |
| **Lifetime** | 処理完了後も残る。契約不一致なら再処理対象 |
| **Regeneratable** | はい。投稿内容の正本ではない |

### 8.2 Cache（`ai_cache.json` / `enrich_cache.json`）

| 項目 | 内容 |
|---|---|
| **Responsibility** | 同一 Execution Contract における結果再利用 |
| **Key** | Execution Contract のハッシュ |
| **保存する契約情報** | `inputFingerprint`, `model`, `promptVersion`, `schemaVersion`, `result`, `cachedAt`（互換のため結果のフラット項目も併記しうる） |
| **Lifetime** | 永続してよい。契約が変わるとキーが変わり旧エントリは使われない |
| **Regeneratable** | はい。削除や契約変更で API 再実行・費用が発生しうる |

### 8.3 旧 Cache / Progress

- 既存ファイルを自動削除・自動変換しない。
- 契約情報（`inputFingerprint` / `model` / `promptVersion` / `schemaVersion`）が欠落したエントリは **未一致（legacy）** とし、再利用しない。
- 読み込み自体は継続可能（破壊的に読めなくしない）。

### 8.4 処理優先順位

1. 契約一致の Progress
2. 契約一致の Cache（ヒット時は新契約情報付き Progress を書く）
3. API 実行

Cache / Progress 破損時は上書きせず終了する。

---

## 9. Compatibility

現状データと契約の両立ルール。

| 事象 | 契約上の扱い |
|---|---|
| **旧スキーマ投稿（著者・postedAt キー欠落）** | 合法な後方互換データ。キー欠落をエラーにしない。新規収集は 6 フィールドを持つ。 |
| **postedAt 欠損** | 許容する。期間フィルターでは候補外。期間なし digest では候補に残る。 |
| **author 欠損** | 許容する。著者検索・著者制限の対象外になりうる。 |
| **analysis 保持** | analyze 以降は常に保持。後段は削除しない。 |
| **finalAnalysis 追加** | analysis を置換せず並存する。 |
| **enrichment 追加** | 分類レイヤを置換せず並存する。 |
| **空の `text`** | 稀に許容する。パイプラインは原則継続可能。 |
| **confidence 二尺度** | 互換のため併存を許容する。統合数値への暗黙変換はしない。 |

互換性を破る変更（契約改定が必要）の例:

- Raw へ分類レイヤを書き込む
- `finalAnalysis` を廃止して `analysis` だけにする
- search / digest の入力を enriched 以外へ黙って切り替える（フォールバック追加は契約改定）

---

## 10. Future Extensions

以下は **未実装** である。将来追加する場合は、本契約の改訂としてフィールド Owner・Canonical Source・Consumer を先に定義してから導入する。

| 候補 | 想定する意味 | 状態 |
|---|---|---|
| Topic / 類似話題クラスタ | 同一話題のグルーピング・重複抑制 | Digest（1.4）、Editor Topic（1.5）、Concept（1.6）、Story（1.7）。永続クラスタや AI は未実装 |
| Editor 評価 | 人手の重要度・採用/却下 | Editor View（1.5）。人手評価の永続化は未実装 |
| Knowledge Base エントリ | 長期知識としての正規化レコード | Knowledge Object（1.8）+ Draft Workflow（1.9）+ Storage（2.0）。検索・全文索引・外部 DB・AI は未実装 |
| Knowledge Brief / Writer | 執筆〜日刊版〜日付実行〜定時起動 | Brief〜Daily Runner（2.7）+ Launchd Adapter（2.8）+ Writer v2（2.9）。AI Writer / 通知配信は未実装 |
| Source 信頼度 | 投稿者・媒体の信頼性スコア | 未実装 |
| 執筆状態 | 下書き / 採用 / 公開済み等の編集ワークフロー | 未実装 |
| 埋め込みベクトル | 類似検索用 | 未実装 |
| `collectedAt` を期間検索のフォールバックにする | 日付欠損緩和 | 未実装（現状契約外） |
| cache キーへの model / prompt version 含め | モデル・プロンプト変更の安全な無効化 | 実装済み（Version 1.2） |
| カテゴリ定義の単一モジュール化 | 多重定義の解消 | 実装済み（名称・順序の正本は `config/categories.json`。読取は `lib/categories.js`） |

将来拡張は、既存の `analysis` / `finalAnalysis` / `enrichment` を破壊せず、新レイヤまたは派生インデックスとして追加することを原則とする。

---

## Document Control

| 項目 | 内容 |
|---|---|
| 文書名 | DATA_CONTRACT |
| Version | 2.16 |
| 適用対象 | connect / analyze / analyze_ai / enrich_ai / search / digest / editor / concepts / stories / knowledge / knowledge-base / brief / editorial-plan / writer / article-report / daily-edition / daily-runner / launchd / pipeline およびその入出力 |
| 正本の置き場 | `docs/DATA_CONTRACT.md` |
| 利用手順の正本 | `README.md` |
| 実装との関係 | 実装が本契約と食い違う場合、意図的変更でなければ実装側の修正対象とする。契約を変える場合は本ファイルを先に更新する。 |
| 実装注記 | Launchd=`lib/launchd-core.js` + `lib/launchd-adapter.js`（ユーザー LaunchAgent のみ。実登録は install 明示時）。通常試験では launchctl を呼ばない。 |
