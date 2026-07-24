# OP-001 First Publish Runbook

知識収集から X への**初回 1 件投稿**までを、安全かつ再現可能な手順としてまとめた運用 Runbook です。

- 対象: Knowledge 1 件 → X 投稿 1 件
- 対象外: 自動投稿・Scheduler・Thread / Reply / Media / OAuth ログインフロー

関連実装: Source Intake → Extractor → Candidate Review → Knowledge → Draft → Editorial Bridge → X Formatter → Publisher → Publish Ledger

---

## 前提

| 項目 | 内容 |
|------|------|
| Node | 本リポジトリで `npm test` が通る環境 |
| 認証 | 実投稿時のみ `.env` に `X_USER_ACCESS_TOKEN`（値は Git に含めない） |
| 作業単位 | 1 Source → 1 Knowledge → 1 Editorial → 1 X Post |
| 安全原則 | Preview → Dry-run → `--confirm` の順。飛ばさない |

確認用 CLI（一覧）:

```bash
npm run aikido:source:list
npm run aikido:review:list
npm run aikido:knowledge:list
npm run aikido:publish:list
```

---

## Step 1: Source 登録

Web URL から取得するか、手動で Source Intake へ登録する。

### Web（明示 URL）

```bash
npm run aikido:collect:web -- https://example.com/aikido/article
```

### 手動（Node）

```js
const { createAikidoSourceIntake } = require("./lib/aikido-source-intake");
const intake = createAikidoSourceIntake();

intake.createSource({
  sourceType: "article", // official-site / dojo-site / interview / article / book / ...
  title: "合気道の中心",
  url: "https://example.com/aikido/center",
  rawText: "本文または抜粋…",
  // または notes: "出典メモ"
});
```

### 確認

```bash
npm run aikido:source:list -- --status=collected --limit=5
npm run aikido:source:list -- --id=<source-id>
```

- [ ] Source 作成成功（ID が付与されている）
- [ ] URL または `rawText` / `notes` のいずれかがある（出典）
- [ ] `sourceType` が適切

記録欄: `sourceId=____________`

---

## Step 2: Candidate 生成

Knowledge Extractor を実行する（自動で Knowledge / Review は作られない）。

```js
const { createAikidoSourceIntake } = require("./lib/aikido-source-intake");
const { createAikidoKnowledgeExtractor } = require("./lib/aikido-knowledge-extractor");
const { createAikidoCandidateReview } = require("./lib/aikido-candidate-review");

const intake = createAikidoSourceIntake();
const extractor = createAikidoKnowledgeExtractor({ provider: myProvider });
const review = createAikidoCandidateReview();

const extraction = intake.extractKnowledge("<source-id>", { provider: myProvider });
// または extractor.extractFromSource(source)

review.createReviews(extraction);
```

### 確認

```bash
npm run aikido:review:list -- --status=pending
npm run aikido:review:list -- --hasWarnings
npm run aikido:review:list -- --id=<review-id>
```

- [ ] Candidate / Review が生成されている
- [ ] `warnings` を読んだ（要修正なら Step 3 で直す）

記録欄: `reviewId=____________`

---

## Step 3: Review → Knowledge

人が確認・修正し、承認後に Knowledge を生成する。

```js
const { createAikidoCandidateReview } = require("./lib/aikido-candidate-review");
const { createAikidoKnowledgeStore } = require("./lib/aikido-knowledge");

const knowledge = createAikidoKnowledgeStore();
const review = createAikidoCandidateReview({ knowledgeStore: knowledge });

// 必要なら内容修正
// review.updateReview("<review-id>", { title, summary, content, tags, ... });

review.approveReview("<review-id>");
const { knowledge: created } = review.createKnowledgeFromReview("<review-id>");
console.log(created.id);
```

### 確認

```bash
npm run aikido:review:list -- --id=<review-id>
npm run aikido:knowledge:list -- --id=<knowledge-id>
```

- [ ] Review を承認した
- [ ] 必要なら修正した
- [ ] Knowledge が生成された（`knowledgeId` を控える）

記録欄: `knowledgeId=____________`

---

## Step 4: Draft 生成（確認）

Editorial 登録前に、生成される Draft を目視する（保存しない）。

```js
const { createAikidoKnowledgeStore } = require("./lib/aikido-knowledge");
const knowledge = createAikidoKnowledgeStore();

const draft = knowledge.generateDraft("<knowledge-id>");
console.log(draft.title);
console.log(draft.body);
console.log(draft.metadata.templateId);
console.log(draft.metadata.knowledgeCategory);
```

または Bridge の dry-run:

```bash
npm run aikido:editorial -- --id=<knowledge-id> --dry-run --json
```

### 確認

- [ ] 本文が意図どおり（リライトされていないテンプレ出力）
- [ ] category / template が妥当
- [ ] 文字数がおおむね 280 以内（超過は後で warning になる）

---

## Step 5: Editorial 登録

Draft → Editorial Store（Bridge。Rule / Ranking / Publish は行わない）。

```bash
npm run aikido:editorial -- --id=<knowledge-id> --json
```

### 確認

出力の `editorialId`（または作成された item の `id`）を控える。

```js
const { createEditorialStore } = require("./lib/editorial-store");
const store = createEditorialStore();
const item = store.find("<editorial-id>");
console.log(item.body);
console.log(item.metadata);
```

- [ ] Editorial Item が作成された
- [ ] `metadata.knowledgeId` / `templateId` / `bridgeVersion` がある
- [ ] `status` は `draft`（Workflow はまだ進めない）

記録欄: `editorialId=____________`

---

## Step 6: Preview（Formatter）

```bash
npm run aikido:x:preview -- --id=<editorial-id>
npm run aikido:x:preview -- --id=<editorial-id> --json
```

### 確認

- [ ] 本文
- [ ] 改行
- [ ] 文字数（`(N chars)` / `estimatedLength`）
- [ ] `warnings` なし（超過がある場合は本文または Knowledge を直して Step 4–5 からやり直し）

ハッシュタグを付ける場合のみ（任意）:

```bash
npm run aikido:x:preview -- --id=<editorial-id> --includeHashtags
```

---

## Step 7: Dry Run（必須）

```bash
npm run aikido:publish:x -- --id=<editorial-id>
# または明示
npm run aikido:publish:x -- --id=<editorial-id> --dry-run --json
```

### 確認

- [ ] Mode が dry-run / `execute: false`
- [ ] Summary の `Dry-run: 1`（Published: 0）
- [ ] Ledger に増えていない

```bash
npm run aikido:publish:list -- --editorialId=<editorial-id> --json
```

→ `[]` であること。

- [ ] validation 成功（Errors: 0、SKIP でもない）

Duplicate で Skipped になった場合は Step 9 / Rollback の Duplicate を見る。初回なら通常は出ない。

---

## Step 8: Publish（`--confirm` のみ）

```bash
npm run aikido:publish:x -- --id=<editorial-id> --confirm
```

環境変数 `X_USER_ACCESS_TOKEN` が必要。トークンをログやチャットに貼らない。

### 確認

- [ ] `Published: 1`
- [ ] `remoteId` が表示されている
- [ ] Errors: 0

記録欄: `remoteId=____________` / `publishedAt=____________`

---

## Step 9: Ledger 確認

```bash
npm run aikido:publish:list
npm run aikido:publish:list -- --provider=x --status=published --editorialId=<editorial-id> --json
```

### 確認

- [ ] `status=published`
- [ ] `checksum` あり（本文そのものは保存されない）
- [ ] `remoteId` が Step 8 と一致
- [ ] `knowledgeId` / `editorialId` が一致

---

## Step 10: X 上の表示確認

ブラウザまたは X アプリで当該投稿を開く。

- [ ] 投稿内容が Preview と一致
- [ ] 改行が崩れていない
- [ ] ハッシュタグ（付けた場合）
- [ ] 表示崩れ・途切れなし

記録欄: 投稿 URL `https://x.com/i/web/status/<remoteId>` またはプロフィール上の URL  
`postUrl=____________`

---

## Rollback / 失敗時

### Dry-run 段階の失敗

何もしない。Editorial / Knowledge はそのまま。修正して Step 6 から再実行。

### Publish 失敗（API エラー等）

1. CLI の Errors / メッセージを確認（トークンは含まれない想定）
2. Ledger が保存されていないことを確認:

```bash
npm run aikido:publish:list -- --editorialId=<editorial-id> --json
```

3. 原因（401 / 429 / 検証エラー等）を直してから、再度 **Step 7 → Step 8**
4. 途中で X 側だけ成功し Ledger だけ無い疑いがある場合は、X 上の投稿有無を先に確認（二重投稿防止）

### Duplicate（Skipped）

`--force` の前に必ず確認する。

```bash
# Editorial
# （Node で find、または前回控えた editorialId）

# Ledger
npm run aikido:publish:list -- --editorialId=<editorial-id> --json
```

- 同一 `editorialId` または同一 `checksum` が既にある
- 意図した再投稿でなければ `--force` しない
- 再投稿が必要なときだけ:

```bash
npm run aikido:publish:x -- --id=<editorial-id> --confirm --force
```

---

## Checklist

### 投稿前

- [ ] 出典確認（Source URL / notes）
- [ ] 誤字脱字確認（Knowledge / Draft / Preview）
- [ ] 280 文字以内（Preview warning なし）
- [ ] Preview 確認（Step 6）
- [ ] Dry-run 成功（Step 7）
- [ ] Ledger 重複なし（`aikido:publish:list -- --editorialId=...` が空）

### 投稿後

- [ ] X 表示確認（Step 10）
- [ ] Ledger 保存（Step 9）
- [ ] `remoteId` 取得
- [ ] 投稿 URL を記録

---

## 他テーマへの流用

同じ 10 ステップでよい。変えるのは入力だけ。

| 変数 | 例 |
|------|-----|
| Source URL / 手動本文 | ニュース記事・道場ページなど |
| `sourceType` / Knowledge `category` | `article` / `principle` など |
| `knowledgeId` / `editorialId` | 各 Step の記録欄 |

自動投稿・一括 `--category` 実投稿は、初回 Runbook を通したあと運用ルールを別途決める。

---

## Acceptance（OP-001）

- [ ] この手順だけで初回 1 件投稿を完了できる
- [ ] 失敗時に見る場所（Dry-run / Ledger / Duplicate）が明確
- [ ] 合気道以外のテーマにも同じ手順を流用できる
