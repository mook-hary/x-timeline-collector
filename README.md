# x-timeline-collector

自分専用の X (Twitter) タイムライン収集・整理ツールです。

## この文書について

| | |
|---|---|
| **扱うこと** | 目的、責務、パイプライン、セットアップ、実行方法、設定、既知の制約 |
| **扱わないこと** | フィールド定義・Source of Truth・キャッシュ契約などのデータ仕様詳細 |

データ仕様の正本は [`docs/DATA_CONTRACT.md`](docs/DATA_CONTRACT.md) です。

---

## Public vs local layout

This repository is structured so a public GitHub tree can exist without shipping private timeline data.

| Path | Visibility | Role |
|---|---|---|
| Application source (`*.js`, `lib/`), `test/`, `docs/`, `README.md` | Public | Source code and documentation |
| `config/`, `digest.config.json`, `.env.example`, `package.json`, `package-lock.json` | Public | Configuration templates and package metadata |
| `.github/workflows/` | Public | CI / Pages workflows |
| `site/` | Public (curated) | Reviewed static site (manual Pages deploy) |
| `output/digest-reader/` | Optional public | Generated Digest Reader HTML for GitHub Pages |
| `.env` | Local only | Secrets template is `.env.example` — never commit real keys |
| `browser-data/` | Local only | Playwright/Chromium profile (cookies / sessions) |
| `knowledge-base/` | Local only | Private knowledge store |
| `.pipeline-work/` | Local only | Disposable pipeline working files |
| `logs/` | Local only | Local runner / launchd logs |
| `output/` (except digest-reader) | Local only | Disposable intermediate pipeline data |
| `runs/`, `runs-*/` | Local only | Run workspaces and retest artifacts |

Flow:

1. Run the pipeline locally → writes disposable data under `output/`
2. Review the local Reader (`npm run reader:open` or `npm run reader:serve`)
3. To publish Reader: `npm run publish` (or manually commit `output/digest-reader` files and push `main`)
4. GitHub Pages deploys **only** `output/digest-reader` (not the rest of `output/`)
5. Optional curated app: `npm run build:site` → commit `site/` → run “Deploy Personal Timeline” manually

### Public-release checklist

- [ ] `.env`, `browser-data/`, `knowledge-base/`, `output/*` (except intentional `output/digest-reader`), `runs/`, `runs-*/`, `.pipeline-work/`, `logs/` are untracked
- [ ] `npm run audit:public` passes
- [ ] `npm run validate:site` passes (when publishing `site/`)
- [ ] Pages Reader deploy uploads `output/digest-reader` only
- [ ] No home-directory absolute paths, raw timeline dumps, or secrets in tracked files

---

## Quick Start

既存の `output/timeline_enriched.json` がある場合（API なし）:

```bash
node pipeline.js --no-api --days 7 \
  --plan-title "今週のタイムライン要点" \
  --audience "一般読者" \
  --length 1200
```

進捗は stderr、Markdown 草稿は stdout です。記事と診断 Report を同時に残す場合:

```bash
node pipeline.js --no-api --days 7 \
  --output article.md \
  --report-output article-report.json
```

Markdown のみファイルへ残す場合:

```bash
node pipeline.js --no-api --days 7 --output article.md
```

複数記事を日刊版へまとめる場合（Manifest に article / report パスを列挙）:

```bash
node daily-edition.js build \
  --manifest daily-manifest.json \
  --output daily-edition.md \
  --report-output daily-edition-report.json
```

1 日分を日付ディレクトリ付きでまとめて実行する場合:

```bash
node daily-runner.js plan \
  --date 2026-07-21 \
  --timezone Asia/Tokyo \
  --no-api

node daily-runner.js run \
  --date 2026-07-21 \
  --timezone Asia/Tokyo \
  --days 1 \
  --category other \
  --no-api
```

LaunchAgent の計画・plist 生成（登録なし）:

```bash
node launchd.js plan \
  --hour 9 \
  --minute 30 \
  --timezone Asia/Tokyo \
  --no-api

node launchd.js generate \
  --hour 9 \
  --minute 30 \
  --timezone Asia/Tokyo \
  --no-api \
  --output /tmp/daily-runner.plist
```

収集から通す場合（Chrome CDP + OpenAI API が必要）:

```bash
node pipeline.js --days 7 --plan-title "今日のメモ"
```

---

## 目的

Playwright でホームタイムラインを取得し、分類・AI補正・要約・重要度付与を経て、検索およびダイジェストに使える JSON へ整えます。

## Current Responsibility（現在の責務）

**現在の責務**

X のタイムライン投稿を収集し、分類・AI補正・要約・重要度付与を行い、検索およびダイジェスト生成に利用できる形へ整えること。

**現時点では責務外**

- 自動投稿
- X への書き込み
- 外部公開
- 記事の自動執筆
- Editor / Editor-in-Chief 機能（人手評価の永続化）
- Topic クラスタリング（AI / 永続クラスタ）
- Knowledge Base の検索・全文索引・外部 DB
- 記事本文の AI 生成（Writer v1 は決定論的 Renderer のみ）
- Knowledge Brief / Editorial Plan / Writer Draft の永続保存

---

## 全体パイプライン

```text
connect.js
  → output/timeline.json
  → analyze.js
  → output/timeline_analyzed.json
  → analyze_ai.js
  → output/timeline_ai.json
  → enrich_ai.js
  → output/timeline_enriched.json
  → search.js / digest.js / editor.js / concepts.js / stories.js
```

役割の分け方:

- **Reporter（収集）:** `connect` → analyze → enrich。投稿を蓄積・分類・補強する
- **Editor（整理）:** `editor.js`。投稿一覧ではなく Topic 単位で俯瞰し、次に読む投稿を見つける
- **Concept Library（継続テーマ）:** `concepts.js`。Editor Topic を時間をまたぐ Concept へまとめる（派生・非永続。AI なし）
- **Story Engine（Editor in Chief）:** `stories.js`。複数 Concept を編集上の主要論点（Story）へ束ねる（定義は `config/stories.json`。派生・非永続。AI なし）
- **Knowledge Draft:** `knowledge.js`。Story から育てる継続的な理解を編集する（ステートレス。保存しない）
- **Knowledge Base:** `knowledge-base.js`。編集済み Knowledge Object をローカル永続化する（履歴・index 付き。AI なし）
- **Knowledge Brief / Editorial Brief v2:** `brief.js`。Knowledge（+ 任意 Story）から編集指示用 Brief を生成する（派生・非永続。AI なし）
- **Editorial Plan:** `editorial-plan.js`。Brief の前に、誰に何をどの形式で書くかの執筆方針を定義する（人間入力・非永続。AI なし）
- **Writer:** `writer.js`。Brief + Plan（+ 任意の Story JSON）を決定論的 Markdown 草稿へ整形する（Renderer・非永続。AI なし）
- **Article Report:** `article-report.js`。Brief + Plan + Markdown から根拠・採用状況を診断する（監査用派生・非 SoT。AI なし）
- **Daily Edition:** `daily-edition.js`。複数の Writer Markdown + Article Report を日刊版へ決定論的に編集配置する（AI なし・自動実行なし）
- **Daily Runner:** `daily-runner.js`。1 日単位で Pipeline + Daily Edition を実行し、日付別成果物と Run Report を残す（運用オーケストレーション）
- **Launchd Adapter:** `launchd.js`。macOS ユーザー LaunchAgent の plist 生成・登録（定時で Daily Runner を起動）
- **Pipeline Runner:** `pipeline.js`。上記 CLI を順に呼ぶオーケストレーション（ビジネスロジックなし）

| 単位 | 役割 |
|---|---|
| Post | 個別投稿 |
| Topic | 時点で観測された話題 |
| Concept | 日付をまたぐ継続テーマ |
| Story | 複数 Concept を束ねた主要論点（出来事） |
| Knowledge | Story から抽出した継続的な理解（長寿命） |
| Brief | Knowledge を執筆用途に並べ替えた派生ビュー |
| Plan | 人間が決める執筆方針（読者・形式・長さなど） |
| Draft | Writer が生成する Markdown 草稿 |
| Article Report | 記事の根拠・不足・採用状況の診断データ（本文ではない） |
| Daily Edition | 複数 Draft をカテゴリ順にまとめた日刊閲覧単位 |

| 段階 | 入力 | 出力 | 責務 | API |
|---|---|---|---|---|
| `connect.js` | Chrome（CDP）／既存 `timeline.json` | `timeline.json`, `timeline.csv` | ホームTLを URL 重複除外で蓄積 | なし |
| `analyze.js` | `timeline.json`, `config/categories.json` | `timeline_analyzed.json`, review 系 | キーワード分類（`analysis`） | なし |
| `analyze_ai.js` | `timeline_analyzed.json` | `timeline_ai.json`, ai progress/cache | 低確信度／「その他」を AI 再分類（`finalAnalysis`） | あり |
| `enrich_ai.js` | `timeline_ai.json` | `timeline_enriched.json`, enrich progress/cache | 重要度・要約・タグ追加（`enrichment`）。分類は変更しない | あり |
| `search.js` | `timeline_enriched.json` | 標準出力 | 条件フィルター検索 | なし |
| `digest.js` | `timeline_enriched.json`, `digest.config.json` | Markdown / JSON（stdout またはファイル） | 注目投稿選定とカテゴリ別まとめ | なし |
| `editor.js` | `timeline_enriched.json` | 標準出力（Topic ビュー） | Topic 単位の編集ビュー（派生・非永続） | なし |
| `concepts.js` | `timeline_enriched.json`（Editor Topic 経由） | 標準出力（Concept ビュー） | 継続テーマの Concept Library（派生・非永続） | なし |
| `stories.js` | `timeline_enriched.json`（Concept 経由）+ `config/stories.json` | 標準出力（Story ビュー） | Story Engine（派生・非永続） | なし |
| `knowledge.js` | （手入力 / Evidence 参照） | 標準出力（JSON） | Knowledge Draft の作成・編集（保存なし） | なし |
| `knowledge-base.js` | Knowledge JSON | `knowledge-base/` | Knowledge Object の永続保存・読出し・履歴 | なし |
| `brief.js` | Knowledge Base（+ 任意 Story） | 標準出力（Brief JSON） | Editorial Brief v2 生成（保存なし） | なし |
| `editorial-plan.js` | （人間入力 / 任意 Brief） | 標準出力（Plan JSON） | Writer 向け Editorial Plan（保存なし） | なし |
| `writer.js` | Brief + Plan（+ 任意 Story） | 標準出力（Markdown） | 決定論的 Markdown Renderer（保存なし） | なし |
| `article-report.js` | Brief + Plan + Markdown | 標準出力（Report JSON） | 記事診断・監査 Report（KB 非依存） | なし |
| `daily-edition.js` | Manifest + Markdown + Report | 標準出力（Daily Edition Markdown） | 日刊版の決定論的編集（KB/Brief/Plan 非依存） | なし |
| `daily-runner.js` | 日付・設定 | stdout JSON + `runs/<date>/` | 1 日単位の安全実行（lock / retry / Run Report） | Pipeline 経由 |
| `launchd.js` | 時刻・timezone・パス | plist / JSON | macOS LaunchAgent の生成・install | なし（登録時のみ OS） |
| `pipeline.js` | 既存 CLI 群 | stderr 進捗 + stdout Markdown | エンドツーエンド実行（オーケストレーション） | 段階による |

フィールドの正本・フォールバック・ライフサイクルは [DATA_CONTRACT](docs/DATA_CONTRACT.md) を参照してください。

---

## セットアップ

```bash
npm install
cp .env.example .env
# AI 段階を使う場合: .env に OPENAI_API_KEY を設定
```

収集は通常の Google Chrome をリモートデバッグで起動し、Playwright から接続します。

```bash
# 先に通常の Chrome をすべて終了してから
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-debug-profile"
```

起動した Chrome で https://x.com/home を開き、ログインした状態にしておきます。

---

## 毎朝（Digest Reader → Pages）

### フルパイプライン（推奨）

```bash
npm run morning
npm run morning -- --dry-run    # 実行予定のみ
```

実行順:

1. Collect (`connect.js --once`)
2. Analyze → AI Analyze → Enrich
3. Publish（`npm run publish` 相当: Reader 生成 → test → audit → commit → push）

Reader 生成は Publish 内で1回だけ行い、二重実行しません。

### ローカル Runner のみ（公開しない）

```bash
npm run morning:runner -- --open
npm run reader                  # enriched から Reader のみ
npm run morning:runner -- --from-enriched --open
npm run morning:runner -- --skip-collect --open
npm run morning:runner -- --skip-ai --open
```

関連: `npm run collect` / `analyze` / `analyze:ai` / `enrich` / `publish`。詳細は `node scripts/morning-pipeline.js --help` / `node scripts/morning.js --help`。

終了時に Summary を表示し、実行結果を `.pipeline-work/history/YYYY-MM-DD-HHmmss.json` に保存します（履歴保存に失敗しても Pipeline は失敗扱いしません）。

### Editorial Content Store（基盤）

投稿候補・記事候補を共通フォーマットで保存するストアです（Morning Pipeline への組み込みはまだありません）。

```js
const { createEditorialStore } = require("./lib/editorial-store");
const store = createEditorialStore(); // .pipeline-work/editorial/

store.create({ source: "news", type: "article", title: "...", body: "..." });
store.update(id, { score: 0.9 }); // status は変更不可
store.transition(id, "review");
store.transition(id, "approved");
store.transition(id, "scheduled", { scheduledAt: "2026-07-25T07:00:00.000Z" });
store.listReadyToPublish();
store.findSimilar(candidate, { threshold: 0.7 });
store.findSimilarById(id);
store.evaluate(id, { includeSimilarity: true });
store.find(id);
store.list();
store.listByStatus("draft");
store.listBySource("aikido");
```

Workflow: `draft` → `review` → `approved` → `scheduled` / `published` → `archived`（状態変更は `transition()` のみ）。

類似判定はローカル（文字 bigram + Dice、外部 API なし）。`lib/editorial-similarity.js`。
公開前ルールは `lib/editorial-rules.js`（判定のみ・状態は変更しない）。

1 コンテンツ = `.pipeline-work/editorial/<id>.json`。

### 毎朝自動実行（launchd）

macOS のユーザー LaunchAgent で、毎朝 `npm run morning` 相当を自動実行します（Morning Pipeline 本体は変更しません）。

```bash
npm run scheduler:install      # 登録（デフォルト 07:00 / Asia/Tokyo）
npm run scheduler:status       # 登録状態を確認
npm run scheduler:uninstall    # 解除（未登録でも正常終了）
```

時刻を変える例:

```bash
npm run scheduler:install -- --hour 7 --minute 0 --timezone Asia/Tokyo
```

- plist は `.pipeline-work/launchd/` に生成し、`~/Library/LaunchAgents/` へ登録します
- Label: `com.x-timeline-collector.morning-pipeline`（一意）
- 再 install しても重複登録しません（既存を bootout → bootstrap）
- sudo / cron は使いません
- 実行時刻は Mac のシステム時刻（タイムゾーン設定）に従います

---

## 実行方法

### 1. 収集 — `connect.js`

```bash
node connect.js --once   # 保存後に終了（Morning / 自動化向け）
node connect.js          # 保存後も待機（従来どおり。終了は Ctrl+C）
node connect.js --help
```

- 最大 50 件／最大 15 スクロールでホームTLを取得し、`output/timeline.json` に**蓄積**
- 併せて `output/timeline.csv`（UTF-8 BOM）を生成
- URL で重複除外。既存の `collectedAt` は変更しない
- `--once` なしではブラウザを閉じない（終了は `Ctrl+C`）

旧方式（専用プロファイル起動）: `node index.js`（うまくいかない場合は上記 CDP 方式を推奨）

### 2. キーワード分類 — `analyze.js`

```bash
node analyze.js
node analyze.js --help
```

- 入力: `output/timeline.json`
- 設定: `config/categories.json`（カテゴリ名／順序の正本＋キーワード重み）
- 出力: `timeline_analyzed.json`、`uncategorized.*`、`output/review/*.txt`、`review_low_confidence.txt`
- 一致キーワードの重み合計でカテゴリ決定。確信度は high / medium / low
- 詳細な採点ルールはコードと review 出力で確認。スキーマは DATA_CONTRACT を参照

### 3. AI 再分類 — `analyze_ai.js`

```bash
node analyze_ai.js --limit 5
node analyze_ai.js --cache-stats
node analyze_ai.js --help
```

- 対象: `analysis.confidence === "low"` またはカテゴリ「その他」
- 入力: `timeline_analyzed.json` → 出力: `timeline_ai.json`
- 進捗: `ai_progress.json`／キャッシュ: `ai_cache.json`
- デフォルト `--limit` は 10（上限 50）。high/medium は API せずキーワード結果を `finalAnalysis` に載せる
- API 利用には料金が発生しうる
- **完了判定は URL だけでは行わない**（入力内容・model・prompt/schema version が一致する場合のみ再利用）。詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md)

### 4. 補強（重要度・要約）— `enrich_ai.js`

```bash
node enrich_ai.js --limit 5
node enrich_ai.js --cache-stats
node enrich_ai.js --help
```

- 入力: `timeline_ai.json` → 出力: `timeline_enriched.json`
- 進捗: `enrich_progress.json`／キャッシュ: `enrich_cache.json`
- カテゴリは変更せず `enrichment`（importance / summary / tags / reason）のみ追加
- importance 目安: 5 強く有用 … 1 広告・ノイズ
- analyze_ai と同様、**契約一致時のみ** progress/cache を再利用する

### 5. 検索 — `search.js`

条件フィルター検索です。relevance スコア付き全文検索や AI 検索ではありません。

```bash
node search.js --help
node search.js --category AI
node search.js --category AI --category プログラミング・IT
node search.js --tag AI --tag アニメ
node search.js --text "OpenAI animation"
node search.js --importance 4 --tag Cursor --explain
node search.js --from 2026-07-01 --to 2026-07-15 --limit 10
node search.js --category AI --json --limit 2
node search.js --category AI --explain --json
```

| オプション | 説明 |
|---|---|
| `--category <名前>` | カテゴリ完全一致。複数指定は **OR**（`categories.json` で検証） |
| `--importance <1-5>` | `enrichment.importance` が指定値以上 |
| `--tag <語>` | タグ部分一致（大小無視）。複数指定は **AND** |
| `--author <語>` | `authorName` / `authorHandle` を部分一致（大小無視） |
| `--text <語...>` | 空白区切り語を **AND**（大小無視） |
| `--from <YYYY-MM-DD>` | `postedAt` が指定日以降（ローカル日付の 0:00:00） |
| `--to <YYYY-MM-DD>` | `postedAt` が指定日以前（ローカル日付の 23:59:59.999 まで含む） |
| `--limit <件数>` | 絞り込み・ソート後の表示上限 |
| `--json` | 結果を JSON で標準出力（`--explain` なし時は従来どおり投稿配列） |
| `--explain` | 一致理由を表示。`--json` 併用時は `{ post, match }` 配列 |
| `--help`, `-h` | ヘルプ |

制約・補足:

- 異なる種類の条件同士は **AND**
- `--text` は空白区切り AND。`--tag` 複数は AND。`--category` 複数は OR
- カテゴリ読取: `finalAnalysis.category` → なければ `analysis.category` → `"その他"`
- タグ照合: `finalAnalysis.tags` / `enrichment.tags`（表示）＋ `matchedKeywords`（分類根拠・補助）
- 正式入力は **`output/timeline_enriched.json` のみ**
- 日付は **`postedAt` のみ**（`collectedAt` フォールバックなし）。期間指定時は欠損除外
- 並び: importance 降順 → `postedAt` 新しい順（欠損は後ろ）
- 詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md)

### 6. ダイジェスト — `digest.js`

注目投稿の自動選定とカテゴリ別まとめを Markdown または JSON で出します。AI 要約やベクトル検索は行いません。

```bash
node digest.js --help
node digest.js --today
node digest.js --from 2026-07-01 --to 2026-07-15 --top 10
node digest.js --category AI --min-importance 4
node digest.js --today --output output/digest_today.md
node digest.js --from 2026-07-14 --to 2026-07-15 --json
node digest.js --today --explain
node digest.js --today --explain --json
node digest.js --full
```

| オプション | 説明 |
|---|---|
| `--today` | 今日（ローカル 0:00〜23:59:59）を対象。`--from` / `--to` と併用不可 |
| `--from <YYYY-MM-DD>` | 指定日以降（ローカル日境界） |
| `--to <YYYY-MM-DD>` | 指定日以前（当日ローカル終端まで含む） |
| `--category <名前>` | `finalAnalysis.category` の完全一致（欠損時は互換フォールバックあり） |
| `--min-importance <1-5>` | `enrichment.importance` が指定値以上 |
| `--top <件数>` | 注目投稿の上限（未指定時 5） |
| `--full` | カテゴリ別一覧を省略せず全件表示 |
| `--output <パス>` | Markdown または JSON をファイルへ保存 |
| `--json` | 構造化 JSON を出力（`--explain` なし時は従来構造のまま） |
| `--explain` | 選定理由と Digest 統計を表示。`--json` 併用時は `topPosts` を `{ post, selection }` 形式にし `selectionStats` を付与 |
| `--help`, `-h` | ヘルプ |

**Top 選定（注目投稿）**

- スコア: `personalScore = importance × 10 + categoryWeight × 3`
- `categoryWeight` は `digest.config.json` の `categoryWeights`
- 既定で importance が `topMinimumImportance`（3）未満は Top 対象外
- `topExcludedCategories`（既定: 広告・PR）は Top から除外
- カテゴリあたり最大 `maxPostsPerCategoryInTop`（3）、著者あたり最大 `maxPostsPerAuthorInTop`（2）
- 同一話題は軽量 `topicKey` で抑制（`topicCap`、未設定時の既定は 1）
- 件数不足時は **topicCap のみ緩和**（categoryCap / authorCap は維持）
- Top 内で同一 URL は重複除外
- `--explain` の選定メタ・統計は派生情報であり、投稿データや enriched JSON には保存しない

`topicKey` の生成規則は [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) を参照。

正式入力は **`output/timeline_enriched.json`**。期間指定時の日付は **`postedAt` のみ**（ローカル日付。search と同一境界。`collectedAt` フォールバックなし）。

### 7. Editor — `editor.js`

投稿を「読む」のではなく、同じ話題を Topic にまとめて俯瞰するための編集ビューです。AI 要約は行いません。

```bash
node editor.js --help
node editor.js --today
node editor.js --from 2026-07-01 --to 2026-07-15
node editor.js --category AI --limit 10
node editor.js --today --json
```

| オプション | 説明 |
|---|---|
| `--today` | 今日（ローカル 0:00〜23:59:59）を対象。`--from` / `--to` と併用不可 |
| `--from <YYYY-MM-DD>` | 指定日以降（ローカル日境界） |
| `--to <YYYY-MM-DD>` | 指定日以前（当日ローカル終端まで含む） |
| `--category <名前>` | カテゴリ完全一致（互換フォールバックあり） |
| `--limit <件数>` | 表示する Topic 数の上限 |
| `--json` | Topic 配列を含む JSON を標準出力 |
| `--help`, `-h` | ヘルプ |

- Topic Key は Digest と同じ契約（詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md)）
- Key を作れない投稿は一投稿＝一 Topic
- Editor View / Topic Summary は派生情報であり、投稿データには保存しない
- 正式入力は **`output/timeline_enriched.json`**

### 8. Concept Library — `concepts.js`

Editor の Topic を、日付をまたぐ継続テーマ（Concept）へまとめる派生ビューです。AI による概念抽出・要約は行いません。Concept は投稿やファイルへ保存しません。

| | Topic | Concept |
|---|---|---|
| 役割 | その時点で観測された話題 | 複数日・複数 Topic にまたがる継続テーマ |
| Identity | 投稿 Identity ではない | 投稿 Identity ではない（正本は `url`） |

```bash
node concepts.js --help
node concepts.js --today
node concepts.js --from 2026-07-01 --to 2026-07-15
node concepts.js --category AI --category プログラミング・IT
node concepts.js --min-days 2 --min-topics 2 --limit 10
node concepts.js --explain
node concepts.js --json
node concepts.js --explain --json
```

| オプション | 説明 |
|---|---|
| `--today` | 今日（ローカル 0:00〜23:59:59）を対象。`--from` / `--to` と併用不可 |
| `--from <YYYY-MM-DD>` | 指定日以降（ローカル日境界） |
| `--to <YYYY-MM-DD>` | 指定日以前（当日ローカル終端まで含む） |
| `--category <名前>` | Concept 内に当該カテゴリの Topic/投稿が含まれる場合に一致（複数指定は OR。`categories.json` で検証） |
| `--min-days <N>` | `activeDays`（postedAt のローカル日付ユニーク数）が N 以上 |
| `--min-topics <N>` | Concept 内 Topic 数が N 以上 |
| `--limit <N>` | フィルター・ソート後の表示上限 |
| `--json` | Concept 配列を JSON 出力 |
| `--explain` | 統合理由を表示。`--json` 併用時は `{ concept, explanation }` 配列 |
| `--help`, `-h` | ヘルプ |

- Concept Key / Topic Key の詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md)
- 正式入力は **`output/timeline_enriched.json`**

### 9. Story Engine — `stories.js`

Concept をさらに束ね、編集上の主要論点（Story）として俯瞰する Editor in Chief ビューです。AI による Story 生成は行いません。Story 集計は保存しません。

一つの Concept は複数 Story に所属できます。どの Story にも入らない Concept は `unassignedConcepts` として保持します（正式 Story にはしません）。

```bash
node stories.js --help
node stories.js --today
node stories.js --from 2026-07-01 --to 2026-07-15
node stories.js --story ai-agents --story models-reasoning
node stories.js --category AI --min-concepts 1 --limit 5
node stories.js --show-unassigned --explain
node stories.js --json
node stories.js --explain --json
```

| オプション | 説明 |
|---|---|
| `--today` | 今日（ローカル 0:00〜23:59:59）を対象。`--from` / `--to` と併用不可 |
| `--from <YYYY-MM-DD>` | 指定日以降（ローカル日境界） |
| `--to <YYYY-MM-DD>` | 指定日以前（当日ローカル終端まで含む） |
| `--category <名前>` | Story 内に当該カテゴリの Concept/投稿が含まれる場合に一致（複数は OR） |
| `--story <ID>` | Story ID で絞り込み（複数は OR。`label` ではなく `id`） |
| `--min-days <N>` | Story の `activeDays` が N 以上 |
| `--min-concepts <N>` | Story の `conceptCount` が N 以上 |
| `--limit <N>` | フィルター・ソート後の表示上限 |
| `--show-unassigned` | 未分類 Concept を末尾に表示 |
| `--json` | `{ stories, unassignedConcepts, statistics }` |
| `--explain` | 構成・スコア根拠。`--json` 時は `stories[]` が `{ story, explanation }` |
| `--help`, `-h` | ヘルプ |

**`config/stories.json` の編集**

| フィールド | 意味 |
|---|---|
| `id` | 安定 ID（必須・一意。CLI の `--story` で指定） |
| `label` | 表示名 |
| `description` | 定義上の説明（観測 summary ではない） |
| `includeTags` | 一致させたい人間向けタグ（正規化後の完全一致。複数表記を列挙） |
| `includeCategories` | カテゴリ条件（`includeTags` が空のときのみ主条件） |
| `excludeTags` | 除外タグ（一致したら不採用） |
| `priority` | スコアへの加点（大きいほど上位寄与） |

マッチング規則・Score 式の詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。正式入力は **`output/timeline_enriched.json`**。

### 10. Knowledge Draft Workflow — `knowledge.js`

Story（出来事）から育てる継続的な理解を、Knowledge Draft として作成・編集します。AI は使いません。**ファイルへは保存しません**（永続化は `knowledge-base.js`）。`--input` は読み取り専用で、結果は標準出力の JSON です。純 Knowledge JSON と `{ knowledge, operation }` ラッパーの両方を受け付けます。

| | Story | Knowledge |
|---|---|---|
| 役割 | 観測された主要論点 | 人が育てる理解 |
| 寿命 | 短〜中（派生ビュー） | 長い（Knowledge Base に永続） |
| 根拠 | Concept / 投稿の集計 | Evidence（参照のみ） |

```bash
node knowledge.js --help
node knowledge.js create --id ai-agents --title "AIエージェント" --summary "本文"
node knowledge.js add-evidence --input /tmp/k.json --type story --id ai-agents
node knowledge.js update --input /tmp/k.json --confidence 70
node knowledge.js transition --input /tmp/k.json --to review
node knowledge.js validate --input /tmp/k.json
```

| コマンド | 説明 |
|---|---|
| `create` | Draft 作成（status=draft, version=1） |
| `update` | title / summary / notes / confidence を更新 |
| `add-evidence` | story / concept / post 参照を追加（重複は変更なし） |
| `remove-evidence` | 参照を削除（未存在は変更なし） |
| `transition` | status 遷移（`--to`） |
| `validate` | Knowledge JSON を検証 |

- **version:** 意味のある変更時のみ +1（同値更新・重複 Evidence・同 status では増やさない）
- **updatedAt:** version と同じく意味のある変更時のみ更新。`createdAt` は不変
- **status 遷移:** draft↔review、review→published、published→archived、archived→draft（詳細は DATA_CONTRACT）
- **review / published:** summary と Evidence が必要（published は title も）
- Evidence は参照のみ（投稿コピーなし）
- 出力は `{ knowledge, operation }`（validate は `{ ok, knowledge }`）

### 11. Knowledge Base — `knowledge-base.js`

編集済み Knowledge Object をローカルに永続保存します。投稿や Story の倉庫ではありません。AI・外部 DB・検索索引は使いません。

| | `knowledge.js` | `knowledge-base.js` |
|---|---|---|
| 役割 | ステートレスな編集 | 永続ストレージ操作 |
| 入出力 | JSON → stdout | JSON ↔ `knowledge-base/` |
| 履歴 | なし | version スナップショット |

保存ディレクトリ（既定 `./knowledge-base/`、`--base-dir` で切替）:

```text
knowledge-base/
  items/<id>.json              # 現行 Knowledge（正本）
  history/<id>/000001.json     # 変更不能な履歴
  index.json                   # 一覧用（items から再生成可）
```

ローカル個人データとして扱う場合は `.gitignore` に `knowledge-base/` を入れています。Git 管理したい場合は ignore を外してください。

```bash
node knowledge-base.js --help
node knowledge-base.js init
node knowledge-base.js save --input /tmp/k1.json
node knowledge-base.js show --id ai-agents
node knowledge-base.js show --id ai-agents --version 1
node knowledge-base.js list
node knowledge-base.js history --id ai-agents
node knowledge-base.js rebuild-index
node knowledge-base.js validate
node knowledge-base.js validate --base-dir /tmp/kb-test
```

| コマンド | 説明 |
|---|---|
| `init` | ディレクトリと空 index を作成（再実行可・既存非破壊） |
| `save` | 検証済み Knowledge を保存（純 JSON または `{ knowledge, operation }`） |
| `show` | 現行または `--version` の履歴を表示 |
| `list` | 一覧（`--json` 可）。index が無ければ再生成 |
| `history` | version 一覧 |
| `rebuild-index` | items から index を再生成（本体・履歴は変更しない） |
| `validate` | 整合性確認（失敗時は非 0） |

推奨ワークフロー:

```bash
node knowledge.js create --id ai-agents --title "AIエージェント" --summary "本文" \
  --story ai-agents > /tmp/k1.json
node knowledge-base.js save --input /tmp/k1.json

node knowledge.js update --input /tmp/k1.json --summary "改訂" > /tmp/k2.json
node knowledge-base.js save --input /tmp/k2.json
```

- **新規:** version 1 のみ。**更新:** 現行 version + 1 のみ（同値・飛越し・巻戻し拒否）
- **競合:** 古い Knowledge からの上書きを拒否（楽観的制御）
- **operation メタは保存しない。** 入力ファイルは変更しない
- **index は再生成可能。** 詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)

### 12. Knowledge Brief / Editorial Brief v2 — `brief.js`

Knowledge Base の Knowledge から、編集指示用の構造化 Brief を生成します。`--stories` を渡すと headline / angle / keyFacts / risks 等の Editorial Brief v2 を付与します。記事本文ではありません。AI・URL 取得・自動要約は使いません。**Brief / Knowledge Base ともに保存・変更しません**（標準出力のみ）。

| | Workflow | Knowledge Base | Brief |
|---|---|---|---|
| 役割 | 編集 | 永続 | 編集指示（派生） |
| 変更対象 | なし（stdout） | items / history / index | なし（stdout） |

```bash
node brief.js --help
node brief.js build --knowledge ai-agents --title "AIエージェントの現在" --purpose explainer
node brief.js build --knowledge creative-tech --stories /tmp/stories.json
node brief.js build --status published
node brief.js validate --input /tmp/brief.json
```

| コマンド | 説明 |
|---|---|
| `build` | Knowledge を選び Brief JSON を出力 |
| `validate` | Brief JSON を検証（読み取り専用） |

- **既定 status:** `published` のみ。draft / review / archived は `--allow-status` で明示許可
- **claims:** Knowledge summary の非変形参照（Knowledge ごとに 1 件）。空 summary / Evidence 0 は usable=false + gaps
- **Evidence:** Identity 統合 + `evidenceProvenance`（どの Knowledge 由来か）。本文は取得しない
- **gaps:** 機械的不足（low-confidence 既定閾値 50）
- **constraints:** Writer 固定制約（`--constraint` で追加可）
- **sourceSnapshot:** 参照した Knowledge の id / version / status / updatedAt（鮮度追跡用）
- **statistics:** 件数・confidence 集計
- `--base-dir` で Knowledge Base パス切替

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 13. Editorial Plan — `editorial-plan.js`

Writer の直前段階で、誰に・何を・どの形式で・どの長さで書くかを定義します。事実は Brief、方針は Plan です。AI・記事本文生成はしません。**Plan / Brief / Knowledge Base を保存・変更しません。**

| | Brief | Editorial Plan |
|---|---|---|
| 役割 | 何が分かっているか（事実・根拠） | どう書くか（方針） |
| 入力 | Knowledge Base | 人間入力（+ 任意 Brief） |
| 保存 | しない | しない |

```bash
node editorial-plan.js --help
node editorial-plan.js build \
  --brief /tmp/brief.json \
  --title "AIエージェントの現在" \
  --purpose explain \
  --audience "AIに詳しくない一般読者" \
  --knowledge-level beginner \
  --format explainer \
  --tone clear \
  --formality neutral \
  --language ja \
  --length 1200 \
  --min-length 900 \
  --max-length 1500 \
  --required "専門用語を説明する" \
  --exclude "根拠のない将来予測" \
  --constraint "見出しを使用する"
node editorial-plan.js validate --input /tmp/plan.json
```

| コマンド | 説明 |
|---|---|
| `build` | Editorial Plan JSON を標準出力 |
| `validate` | Plan JSON を検証（読み取り専用） |

- **audience / format / tone / length:** 読者・形式・文体・分量の目安
- **required / exclude / constraints:** 必須観点・禁止内容・Plan 固有制約（Brief constraints はコピーしない）
- **briefReference:** Brief を渡した場合の id / generatedAt 参照（Brief 全体は複製しない）
- title 未指定時のみ Brief title を補完。purpose 等は Brief から推論しない

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 14. Writer v2 — `writer.js`

Brief（事実）と Editorial Plan（方針）から、決定論的な Markdown 草稿を生成します。任意で `--stories`（Story JSON）を渡すと、投稿・Concept の具体情報を本文へ反映します。AI・要約・言い換えは使いません。Knowledge Base は読みません。**保存しません**（stdout のみ）。同じ入力からは常に同じ Markdown になります。

```bash
node writer.js --help
node writer.js build --brief /tmp/brief.json --plan /tmp/plan.json
node writer.js build --brief /tmp/brief.json --plan /tmp/plan.json --stories /tmp/stories.json
node writer.js validate-input --brief /tmp/brief.json --plan /tmp/plan.json
```

| コマンド | 説明 |
|---|---|
| `build` | Markdown を標準出力 |
| `validate-input` | Brief / Plan 整合性のみ確認 |

- `--stories` あり: 具体タイトル +「何が起きたか / なぜ重要なのか / 注目ポイント / 情報源」
- `--stories` なし（または具体情報不足）: Plan.structure 順の従来フォールバック
- claims は言い換えず掲載（`usable=false` は本文不採用 + 注記）
- gaps は「注意事項」に `message` をそのまま列挙
- Constraints / Statistics / Source Snapshot は HTML コメントで末尾に埋込（読者向け本文に Confidence 等を出さない）

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 15. Article Report — `article-report.js`

Brief + Editorial Plan + Writer Markdown から、記事の根拠・不足・採用状況を確認する決定論的な診断 Report を生成します。**記事本文ではありません。** AI・外部取得・Knowledge Base 読込みはありません。入力ファイルは読み取り専用です。Report は Knowledge Base へ保存しません。

Writer Markdown との違い: Writer は草稿本文、Article Report はその監査・レビュー用メタデータです。

```bash
node article-report.js --help
node article-report.js build \
  --brief /tmp/brief.json --plan /tmp/plan.json --article /tmp/article.md
node article-report.js build ... --confidence-threshold 50 --output /tmp/article-report.json
node article-report.js validate --input /tmp/article-report.json
```

| コマンド | 説明 |
|---|---|
| `build` | Report JSON を標準出力（`--output` 時のみ保存） |
| `validate` | Report JSON の整合性確認 |

確認できること:

- 使用 Knowledge / version / Claim 採用（usable・rendered・omitted）
- Evidence 件数・confidence（`--confidence-threshold`、既定 50）
- Brief.gaps（非変形）と constraints（Brief / Plan 分離）
- checks（機械的整合）と reviewSummary（pass / warning / fail）
- `readyForAiRewrite`（error 0・usable 全 rendered・briefReference 一致・すべて published 等の機械的規則）

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 16. Daily Edition — `daily-edition.js`

複数の Writer Markdown と Article Report を、カテゴリ順の日刊版 Markdown へまとめます。**新しい事実は作りません。** 記事本文の要約・言い換えはしません。AI・Knowledge Base / Brief / Plan 読込み・自動実行（cron 等）はありません。

Writer 記事との違い: Writer は 1 記事の草稿、Daily Edition は複数草稿の編集・配置結果です。掲載可否は Article Report（`readyForAiRewrite` / status 等）を正本に機械判定します。

```bash
node daily-edition.js --help
node daily-edition.js build \
  --manifest daily-manifest.json \
  --output daily-edition.md \
  --report-output daily-edition-report.json
node daily-edition.js build --manifest … --exclude-warnings
node daily-edition.js validate --input daily-edition-report.json
```

Manifest 例（`date` + `items` 必須。パスは Manifest 位置からの相対または絶対）:

```json
{
  "date": "2026-07-21",
  "title": "Daily Edition",
  "items": [
    { "article": "politics.md", "report": "politics-report.json", "category": "politics", "priority": 10 },
    { "article": "economy.md", "report": "economy-report.json", "category": "economy", "priority": 20 }
  ]
}
```

| 項目 | 説明 |
|---|---|
| category / categoryOrder | Manifest 指定のみ（本文から推測しない）。既定順あり |
| priority | カテゴリ内昇順（未指定 1000） |
| 掲載可否 | pass/warning + ready + usable≥1 等。`--exclude-warnings` で pass のみ |
| 見出し | 記事 H1→H3、H2→H4…（コード/コメント内は非変換） |
| 編集上の注意 | Report warning 等を末尾に機械列挙 |
| Edition Report | 掲載/除外理由・checks・`publishable` の診断 JSON |

stdout は Daily Edition Markdown のみ。`--output` / `--report-output` 指定時のみ保存。

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 17. Pipeline Runner — `pipeline.js`

既存 CLI を順番に呼び、Markdown 草稿と Article Report までを 1 コマンドで実行します。`--daily-manifest` 指定時のみ Daily Edition も実行します。ビジネスロジックは各 CLI に任せます。

```bash
node pipeline.js --help
node pipeline.js --no-api --days 7 --plan-title "今週の要点" --audience "一般読者"
node pipeline.js --no-api --days 14 --output article.md --report-output article-report.json
node pipeline.js --no-api --daily-manifest daily-manifest.json \
  --daily-output daily-edition.md --daily-report-output daily-edition-report.json
```

| オプション | 説明 |
|---|---|
| `--days` | 対象日数（editor / concepts / stories の期間） |
| `--base-dir` | Knowledge Base パス |
| `--plan-title` / `--purpose` / `--audience` / `--length` | Editorial Plan 向け |
| `--no-api` | 収集・AI をスキップ（既存 enriched を使用） |
| `--output` | Markdown をファイルへも保存 |
| `--report-output` | Article Report JSON を保存（未指定でも Report 検証は実行） |
| `--confidence-threshold` | Report の confidence 閾値（既定 50） |
| `--daily-manifest` | Daily Edition Manifest（指定時のみ実行） |
| `--daily-output` | Daily Edition Markdown 保存（manifest 時は必須） |
| `--daily-report-output` | Edition Report JSON 保存 |

進捗は stderr、通常記事 Markdown のみが stdout です（Daily Edition は混在させません）。`reviewSummary.status=fail` のとき Pipeline は非 0 終了します。warning のみなら成功です。中間ファイルは `.pipeline-work/` に置きます。

Pipeline 成功後、朝の入口と Pages 用サイトも生成されます。

| パス | 役割 |
|---|---|
| `output/index.html` | ローカル用 Personal Dashboard（**Git 管理外**） |
| `output/edition/` | 最新号 Preview（**Git 管理外**） |
| `output/archive/<date>/` | 日付別 Archive（**Git 管理外**） |
| `site/` | GitHub Pages 用。レビュー済みの公開静的一式のみをコミット |

```bash
open output/index.html   # ローカル確認（private）
npm run build:site       # 承認した内容だけ site/ へコピー（意図的な公開ステップ）
npm run validate:site
open site/index.html     # Pages と同じ構成
```

公開デモに戻す場合:

```bash
npm run build:site:demo
```

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 17.1 Personal Web App（GitHub Pages / ホーム画面）

#### Digest Reader（推奨・iPhone 固定 URL）

生成済み Reader（`output/digest-reader`）だけを GitHub Pages に載せます。リポジトリ全体や他の `output/` は公開しません。

**公開 URL（このリポジトリ）:**  
https://mook-hary.github.io/x-timeline-collector/

##### 更新手順

```bash
npm run publish
```

`publish` は Reader 生成 → test → audit → `index.html` / `style.css` のみ commit → `git push origin main` まで行います（`main` 以外では拒否）。

手動で行う場合:

```bash
npm run reader
git add output/digest-reader/index.html output/digest-reader/style.css
git commit -m "Publish Digest Reader"
git push origin main
```

- `main` への push、または Actions の **Deploy Digest Reader Pages** 手動実行でデプロイされます。
- ワークフロー: `.github/workflows/deploy-reader-pages.yml`

##### GitHub 側の設定

1. Repository **Settings → Pages**
2. **Source** を **GitHub Actions** にする
3. 初回は Actions でワークフローを実行し、成功後に上記 URL を開く

#### curated `site/`（手動）

`site/` は追加ビルドなしで載せられる静的サイトです（外部 CDN / Google Fonts / 外部 JS なし）。  
自動デプロイは Reader 側です。`site/` を公開したいときだけ Actions の **Deploy Personal Timeline** を手動実行します。

1. `npm run build:site` → `npm run validate:site` / `npm run audit:public`
2. `site/` をコミットして push
3. Actions で “Deploy Personal Timeline” を Run workflow

#### iPhone ホーム画面に追加（Safari）

1. Pages の Reader URL を Safari で開く
2. 共有ボタン → **ホーム画面に追加**
3. 名前は「Timeline」などで保存

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 18. Daily Runner — `daily-runner.js`

1 日分の Pipeline + Daily Edition を安全に 1 コマンドで実行します。Daily Edition Builder との違い: Builder は編集・配置、Runner は日付ディレクトリ・lock・ログ・Run Report 付きの運用実行です。記事内容の生成・要約はしません。OS スケジューラ（launchd/cron）登録はまだ行いません。

```bash
node daily-runner.js --help
node daily-runner.js plan --date 2026-07-21 --timezone Asia/Tokyo --no-api
node daily-runner.js run --date 2026-07-21 --timezone Asia/Tokyo --days 1 --category other --no-api
node daily-runner.js validate --input runs/2026-07-21/attempts/1/run-report.json
```

| 項目 | 説明 |
|---|---|
| 日付別ディレクトリ | `runs/<YYYY-MM-DD>/attempts/<N>/`（output / work / logs 分離） |
| 成果物 | article.md / article-report.json / daily-edition.md / daily-edition-report.json / manifest.json / run-config.json / run-report.json / logs |
| lock | `.lock` 排他。stale は `--recover-stale-lock`（自動削除なし） |
| retry | failed のみ `--retry` で新 attempt（completed は上書き不可） |
| category | `--category` 明示のみ（既定 `other`。本文から推測しない） |
| dry-run / plan | 実行計画 JSON のみ（ファイル変更なし） |
| stdout / stderr | 成功時は結果 JSON / 進捗は stderr（Markdown 非混在） |
| exit code | 0 成功 / 1 実行失敗 / 2 CLI 検証 / 3 lock / 4 完了済み / 5 Report 検証 |
| secrets | API キー・Cookie・環境変数一覧を run-config / ログへ保存しない |

`--no-api` では Pipeline 契約に従い API・収集をスキップします。本番 API を使った試験は不要です。

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

### 19. Launchd Adapter — `launchd.js`

macOS のユーザー LaunchAgent（`~/Library/LaunchAgents`）向けに、Daily Runner を定時実行する plist を生成・検証・登録します。Daily Runner との違い: Runner は 1 日の処理本体、Adapter は OS への登録だけです。Linux cron / Windows タスクは扱いません。

```bash
node launchd.js --help
node launchd.js plan --hour 9 --minute 30 --timezone Asia/Tokyo --no-api
node launchd.js generate --hour 9 --minute 30 --timezone Asia/Tokyo --no-api --output /tmp/daily-runner.plist
node launchd.js validate-plist --input /tmp/daily-runner.plist
```

| 項目 | 説明 |
|---|---|
| 対応 OS | macOS のみ（ユーザー LaunchAgent）。system daemon / sudo 不可 |
| 時刻 | `--hour` / `--minute` 必須（ローカル）。任意 `--weekdays`（1=Sun … 7=Sat） |
| パス | Node / `daily-runner.js` / runs / logs は絶対パス。WorkingDirectory=projectDir |
| KeepAlive | 使わない（常駐化しない）。`RunAtLoad` は明示時のみ |
| install | 明示実行時のみ launchctl。既存異なる plist は `--replace`（backup 付き） |
| status / uninstall | 登録状態の確認・解除。runs / Knowledge Base / ログは消さない |
| secrets | API キー・Cookie を plist / 設定 JSON へ保存しない |

launchd はターミナルの PATH / nvm を前提にしません。Chrome は自動起動しません（通常運用で Chrome CDP が必要な場合は、実行時刻に利用可能である必要があります）。`--no-api` の LaunchAgent は既存 enriched データを使う契約です。

実登録例（手動・試験では未実行）:

```bash
node launchd.js install --hour 9 --minute 30 --timezone Asia/Tokyo --no-api
node launchd.js status
node launchd.js uninstall
```

詳細契約は [DATA_CONTRACT](docs/DATA_CONTRACT.md)。

---

## 設定ファイル

| ファイル | 役割 |
|---|---|
| `config/categories.json` | **カテゴリ名称と順序の Source of Truth**。キーワード分類の重み・`minimumScore` もここに定義。`lib/categories.js` 経由で analyze_ai / digest も参照 |
| `config/stories.json` | Story Engine の明示的 Story 定義（id / label / tags / categories / priority） |
| `config/knowledge-status.json` | Knowledge の status 一覧・既定値・許可遷移 |
| `digest.config.json` | digest の編集方針。`categoryWeights`、`topMinimumImportance`、`topExcludedCategories`、`maxPostsPerCategoryInTop`、`maxPostsPerAuthorInTop`、`categoryDisplayLimit`。任意で `topicCap`（未指定時はコード既定 1） |
| `.env` / `.env.example` | `OPENAI_API_KEY`（必須・AI段階）、`OPENAI_MODEL`（任意・未設定時 `gpt-5-mini`） |

カテゴリを追加するときは、まず `config/categories.json` を更新し、必要なら `digest.config.json` の重みを足します。

---

## ドキュメント

| 文書 | 正本とする内容 |
|---|---|
| [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) | データモデル、Source of Truth、フォールバック、キャッシュ契約、後方互換、データライフサイクル |
| 本 README | 利用方法・パイプライン・設定の入口 |

実装やスキーマを変えるときは、先に DATA_CONTRACT を確認・更新してからコードを変更してください。

---

## 入出力ファイル（概要）

| ファイル | 段階 |
|---|---|
| `output/timeline.json` | 収集 Raw（**local-only**） |
| `output/timeline_analyzed.json` | キーワード分類後（**local-only**） |
| `output/timeline_ai.json` | AI 再分類後（`finalAnalysis`）（**local-only**） |
| `output/timeline_enriched.json` | 補強後。search / digest / editor / concepts / stories の正式入力（**local-only**） |
| `output/ai_*.json` / `enrich_*.json` | AI の進捗・キャッシュ（再開用。投稿の正本ではない）（**local-only**） |
| `output/review/*` など | 人間レビュー用の派生（**local-only**） |
| `site/` | レビュー済みの公開静的サイトのみを Git 管理 |

詳細は [DATA_CONTRACT](docs/DATA_CONTRACT.md) を参照してください。

`.env`、`browser-data/`、`knowledge-base/`、`output/`、`runs/`、`runs-*/`、`.pipeline-work/`、`logs/` は Git にコミットしません。公開前に `npm run audit:public` を実行してください。

---

## 既知の制約

- 旧データには著者情報が欠けている投稿が存在する
- `postedAt` が欠損している投稿が存在する（期間指定の検索・digest では候補外になる。`collectedAt` へのフォールバックはない）
- `search.js` / `digest.js` / `editor.js` / `concepts.js` / `stories.js` は `output/timeline_enriched.json` を必要とする
- AI 処理（`analyze_ai.js` / `enrich_ai.js`）には API キーが必要
- AI 処理は progress / cache により中断後に再開できる（URL だけでは完了としない）
- 本文・分類・model・prompt/schema version が変わると再処理対象になる
- 旧形式の cache / progress は契約情報欠落のため再利用されない場合がある
- cache / progress 削除や契約不一致での再処理時には API 呼び出しと費用が発生しうる
- `--from` / `--to` はローカル日付基準（search と digest で同一）
