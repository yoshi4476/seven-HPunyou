# セブンセンシズ 毎日ブログ自動更新システム

セブンセンシズ株式会社(大阪市東成区)の LP 集客用ブログを、GitHub Actions + Claude(**Claude Pro/Max サブスク認証** または Anthropic API 従量課金)で毎日自動生成・品質担保・公開・通知するシステムです。認証方式は後述「[Maxプランで従量課金なしで動かす(推奨)](#maxプランで従量課金なしで動かす推奨)」参照。

- LP: https://lp.7senses.co.jp/ **(※仮ドメイン。本番ドメイン確定後に `SITE_URL` と各所コメントを要確認)**
- 戦略の前提: [`../戦略設計書.md`](../戦略設計書.md)(キーワード100本・ペルソナ・KPI)

## パイプライン全体像

```
cron (JST 朝7時: 本流2本 / 夕17時: ニュース1本)
  └─ generate-articles.mjs  キーワードキューから記事生成 → content/drafts/
  └─ quality-loop.mjs       別セッションAIが100点採点。90点未満は差し戻し改稿 (最大5回)
  └─ embed-images.mjs       サムネ生成 + 本文画像の3段フォールバック (AI図解→写真API→ローカル素材)・alt・150KB圧縮
  └─ safety-gate.mjs        機械チェック8項目。合格→publish-queue/ 不合格→human-review/
  └─ (git commit → build & deploy)
  └─ notify-search.mjs      sitemap(差分lastmod)・画像sitemap・IndexNow・GSC ping
  └─ report-slack.mjs       日次レポート (失敗時も必ず送信)
```

## ディレクトリ構成

| パス | 役割 |
|---|---|
| `data/keywords-queue.json` | キーワード100本のキュー (優先度 S/A/B・カテゴリ・消し込み状態) |
| `content/drafts/` | 生成直後〜品質検査中の下書き |
| `content/publish-queue/` | 安全ゲート合格・公開待ち |
| `content/human-review/` | 品質未達 or 安全ゲート不合格 (人間が判断) |
| `content/posted/` | 公開済み |
| `public/images/blog/` | 生成画像 (記事スラッグ別) |
| `logs/` | quality-log / safety-gate-log / sitemap-state / 画像sitemapデータ |
| `templates/article-template.md` | frontmatter スキーマと構成の見本 |

---

## セットアップ手順

### 1. GitHub リポジトリ作成

```bash
cd blog-system
git init
git add .
git commit -m "feat: ブログ自動更新システム初期構築"
gh repo create seven-senses-blog --private --source=. --push
```

### 2. Secrets / Variables 設定

リポジトリの Settings → Secrets and variables → Actions で設定します。

**Secrets(秘匿情報):**

| 名前 | 内容 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | **推奨。** Claude Pro/Max サブスク認証トークン(`claude setup-token` で生成)。設定すると従量課金なしで動作(後述「Maxプランで従量課金なしで動かす」参照)。**このトークンがあれば `ANTHROPIC_API_KEY` は不要** |
| `ANTHROPIC_API_KEY` | Anthropic API キー ([console.anthropic.com](https://console.anthropic.com/) で発行)。従量課金。`CLAUDE_CODE_OAUTH_TOKEN` 未設定時のフォールバックとして使用 |
| `SLACK_WEBHOOK` | Slack Incoming Webhook URL (レポート送信先チャンネル用) |
| `INDEXNOW_KEY` | (任意) IndexNow 用キー。任意の32桁英数字を生成し、サイト直下に `{キー}.txt`(中身はキー自身)を配置する |
| `UNSPLASH_ACCESS_KEY` | (任意) 本文画像フォールバック②の写真API用。取得手順は後述「画像生成の3段フォールバック」参照 |

**Variables(非秘匿設定):**

| 名前 | 内容 |
|---|---|
| `CLAUDE_MODEL` | 使用モデルID。**APIキー認証時は必須**([docs.claude.com](https://docs.claude.com/) で Claude Opus 4.8 の正式IDを確認して設定。スクリプトへのハードコード禁止)。**サブスク認証(`CLAUDE_CODE_OAUTH_TOKEN`)時は省略可**(CLI既定モデルを使用。指定する場合は `sonnet` / `opus` 等のエイリアス推奨) |
| `SITE_URL` | 本番URL (例: `https://lp.7senses.co.jp`)。未設定時はスクリプト内の仮ドメインが使われる |

### 3. Astro プロジェクトへの組込み

このシステムはコンテンツ生成側です。表示側の Astro プロジェクトに以下を組み込みます。

1. Astro 側で Content Collections を定義し、`content/posted/` を記事ソースとして参照する

   ```ts
   // src/content/config.ts
   import { defineCollection, z } from "astro:content";
   export const collections = {
     blog: defineCollection({
       type: "content",
       schema: z.object({
         title: z.string(),
         slug: z.string().optional(),
         description: z.string(),
         category: z.enum(["hojo", "aio", "meo", "dev"]),
         tags: z.array(z.string()),
         date: z.coerce.date(),
         author: z.string(),
         thumbnail: z.string(),
       }),
     }),
   };
   ```

2. `public/images/blog/`・`public/sitemap.xml`・`public/image-sitemap.xml` を Astro の `public/` へ配置(同一リポジトリなら共有、別リポジトリなら CI でコピー)
3. `[...slug].astro` で記事ページを生成し、後述の構造化データを出力する
4. ワークフローの「ビルド & デプロイ」ステップのコメントアウトを解除して `npm run build` を有効化する

### 4. デプロイ (Cloudflare Pages 例)

- **Git 連携方式(推奨・簡単):** Cloudflare Pages でリポジトリを接続 → ビルドコマンド `npm run build` / 出力 `dist` を設定。ワークフローが記事をコミットすると自動デプロイされる
- **wrangler 方式:** `CLOUDFLARE_API_TOKEN` を Secrets に追加し、ワークフローの `npx wrangler pages deploy dist` を有効化する

### 5. 動作確認

```bash
# ローカルで1本ずつ検証 (Node 20 必須)
# 認証はどちらか一方でよい (両方あればサブスク認証を優先)
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # A. サブスク認証 (claude setup-token で生成。CLAUDE_MODEL 任意)
export ANTHROPIC_API_KEY=sk-ant-...               # B. 従量課金 (この場合 CLAUDE_MODEL 必須)
export CLAUDE_MODEL=<docs.claude.com で確認した正式ID>
export UNSPLASH_ACCESS_KEY=...   # 任意 (未設定なら写真APIをスキップ)
npm install
npm run generate      # 記事2本生成
npm run quality       # 採点・改稿
npm run images        # 画像生成
npm run safety        # 安全ゲート
npm run notify        # sitemap・通知
npm run report        # レポート (SLACK_WEBHOOK 未設定なら標準出力)
```

---

## Maxプランで従量課金なしで動かす(推奨)

Anthropic API の従量課金の代わりに、**Claude Pro/Max プランのサブスクリプション認証(Claude Code のトークン)** で記事生成・品質採点・AI図解を動かせます。生成処理は `scripts/claude-client.mjs` が Claude Code CLI(`claude -p` の headless 実行)経由で行うため、API キーの発行・チャージは不要になります。

### 手順

1. **ローカルでトークンを生成する**

   Claude Code をインストール済みのマシンで以下を実行します(Pro/Max プランでのログインが必要)。

   ```bash
   claude setup-token
   ```

   `sk-ant-oat01-...` 形式の長期有効トークンが表示されるので控えます(サブスク認証用の OAuth トークン。API キーとは別物)。

2. **GitHub Secrets に登録する**

   リポジトリの Settings → Secrets and variables → Actions → Secrets に、名前 `CLAUDE_CODE_OAUTH_TOKEN` として登録します。ワークフローはこの Secret を検出すると自動で Claude Code CLI をインストールし、サブスク認証モードで動作します。

3. **`CLAUDE_MODEL` は省略可**

   サブスク認証時は未設定なら CLI の既定モデルが使われます。指定したい場合は `sonnet` / `opus` などの**エイリアス指定を推奨**します(正式IDの調べ直しが不要になるため)。

4. **`ANTHROPIC_API_KEY` は不要になる**

   サブスク認証で運用する場合、`ANTHROPIC_API_KEY` Secret は削除して構いません(残しておいてもトークンが優先されるだけで害はありません)。

### 認証の優先順

`CLAUDE_CODE_OAUTH_TOKEN`(サブスク認証)**>** `ANTHROPIC_API_KEY`(従量課金)。両方設定されている場合はサブスク認証が使われます。どちらも無い場合、各スクリプトは「認証なしのためスキップ」と明示して正常終了(exit 0)します。

### 注意事項

- **利用量は Max プランの枠を消費します。** Claude のサブスクは「5時間ウィンドウ + 週次上限」のレート枠であり、この Actions の実行分も**手元の Claude Code 作業と同じ枠を共有**します。ブログ自動生成が多いと日中の開発作業に使える枠が減る点に注意してください。
- **トークン失効時は Actions が失敗します。** その場合も Slack 日次レポート(失敗時も必ず送信)で検知できます。`claude setup-token` を再実行して Secret を更新してください。
- **大量実行時は頻度を調整してください。** 枠の圧迫を感じたら、`auto-publish.yml` の cron を毎日1本(朝のみ)に減らす、`MAX_REVISIONS` を下げる、などで消費量を抑えられます。

---

## 画像生成の3段フォールバック (embed-images.mjs)

記事本文の画像は、`generate-articles.mjs` が入れる `<!--IMG: (図解内容の説明)-->` マーカー(H2の2〜3個ごと)を `embed-images.mjs` が次の優先順で解決して挿入します。マーカーが無い記事でも H2 2個ごとに自動挿入されます。**どの環境変数が無くても CI は止まりません**(その段をスキップして次へフォールバック)。

| 優先 | 手段 | 条件 | 内容 |
|---|---|---|---|
| ① | AI生成SVG図解 | `CLAUDE_CODE_OAUTH_TOKEN`(サブスク認証)または `ANTHROPIC_API_KEY` + `CLAUDE_MODEL` があり、セクションに数値・比較・手順が含まれる | Claude (claude-client.mjs 経由) に セクション内容を渡し、サイト配色(白 `#fdfcf9` / ネイビー `#1d3461` / ゴールド `#d9b36a`)・日本語ラベル・幅1200 の概念図/手順図/比較図SVGを生成。構文検証(script要素・外部参照なし)→ Sharp で PNG→WebP 変換(150KB以下) |
| ② | 写真API (Unsplash) | `UNSPLASH_ACCESS_KEY` がある | セクション内容から英語クエリを生成して `/search/photos` を検索し、regular サイズをDL→WebP化。クレジット(UTM付リンク)を figcaption に自動挿入(Unsplash License 上は任意だが API ガイドライン準拠のため実装) |
| ③ | ローカル素材 | 常時 | LP同梱の `assets/img/`(documents / paperwork / calculator / handshake / meeting-jp / analytics / chip / code / osaka / building の .webp)からカテゴリ別に選択・圧縮。素材も無い場合は SVGバナーを生成(必ず成功) |

挿入形式は既存記事と同一の `<figure>` ラッパー(角丸・シャドウ・`loading="lazy"`)で、alt(日本語)・width/height を自動付与します。サムネイル生成(SVGテンプレ→PNG/WebP 1200×630)は従来どおり維持しています。

### UNSPLASH_ACCESS_KEY の取得・設定手順 (任意)

1. [unsplash.com/developers](https://unsplash.com/developers) で Unsplash アカウントを作成し「Your apps」→「New Application」
2. ガイドラインに同意してアプリを作成し、表示される **Access Key** を控える(Secret Key は不要)
3. GitHub リポジトリの Settings → Secrets and variables → Actions → Secrets に `UNSPLASH_ACCESS_KEY` として登録
4. ローカル検証時は `export UNSPLASH_ACCESS_KEY=...` を設定
- 無料の Demo 枠は **50リクエスト/時**。本システムは1記事あたり最大5回検索のため通常は十分。超過時は自動で③へフォールバック

### 生成SVG図解の品質確認ポイント (human-review 時)

- **配色**: 白背景 `#fdfcf9` / ネイビー `#1d3461` / ゴールド `#d9b36a` 以外の色が混ざっていないか
- **可読性**: 日本語ラベルが崩れていないか(スマホ縮小でも読める文字サイズ = 元SVGで24px以上)、要素の重なり・はみ出しがないか
- **内容の正確性**: 図中の数値・手順がセクション本文と一致しているか(AI生成のため数値の転記ミスに注意)
- **情報量**: 要素3〜6個に収まっているか。詰め込みすぎの図は削除して②③の画像に差し替えてよい
- **alt**: 図の内容を表す日本語になっているか(`(説明)の図解` 形式で自動生成)
- 機械チェック(script要素・外部参照・パース可否・150KB以下・width/height)は embed-images / safety-gate が自動で担保済み

---

## 週次リライト運用 (GSC 連携)

順位が付き始めた記事を伸ばすための運用です(公開から90日を目安に開始)。

1. **抽出:** Google Search Console の検索パフォーマンスで、過去28日の
   - 平均掲載順位 **11〜20位**(2ページ目 = リライトで1ページ目に入る候補)
   - または 表示回数が多いのに **CTR が同順位帯平均より低い**(タイトル・description 改善候補)
   のクエリ×ページを抽出する
2. **キュー投入:** 該当記事を `content/posted/` から `content/drafts/` へコピーし、リライト観点(不足している検索意図・追加すべき一次情報・タイトル案)をメモとして冒頭コメントに追記
3. **再実行:** `npm run quality && npm run images && npm run safety && npm run notify` を実行。品質ループが再採点し、`notify-search.mjs` が内容ハッシュの変化を検知して該当ページのみ `lastmod` を更新する
4. **自動化(将来):** Search Console API (`searchanalytics.query`) で 1〜2 を自動化し、`report-slack.mjs` の GSC プレースホルダを実装する

## トピッククラスター内部リンク方針

- **ハブ記事 = 「完全ガイド」記事**(例: LLMO対策 完全ガイド)。各カテゴリ (hojo / aio / meo / dev) に1本以上のハブを置く
- **子記事 → ハブ:** 個別トピック記事は本文中から必ず親の完全ガイドへリンクする(「詳しくは完全ガイドへ」)
- **ハブ → 子記事:** 完全ガイドは各章から対応する子記事へリンクする(**双方向リンク**でクラスターを形成)
- **兄弟リンク:** 同カテゴリの関連子記事同士も2本以上相互リンク(安全ゲート④の内部リンク2本以上と整合)
- **アンカーテキスト:** 「こちら」ではなくリンク先キーワードを含める
- 目的: クローラの回遊性向上とトピック権威性の集約。AI検索にも「この分野の体系的情報源」として認識させる

## 構造化データ方針 (Astro 側で実装)

各記事ページの `<head>` に JSON-LD で以下を出力する:

| スキーマ | 内容 |
|---|---|
| `Article` | headline=title / datePublished=date / dateModified=lastmod / image=thumbnail |
| `Person` (author) | `Article.author` に紐づけ。将来的に執筆担当者名+役職で E-E-A-T を強化 |
| `FAQPage` | 記事内 FAQ(2〜3問・回答40〜60字)をそのまま `Question`/`Answer` に変換 |
| `BreadcrumbList` | ホーム → ブログ → カテゴリ → 記事 |
| `ImageObject` | サムネイル(1200×630)を width/height 付きで宣言 |

FAQ 回答を 40〜60 字に制限しているのは、`FAQPage` のリッチリザルトと AI 検索の引用の両方で全文採用されやすい長さのためです。

---

## 品質基準 (再掲)

- 品質ループ: 100点ルーブリック(検索意図20 / AIO適合15 / E-E-A-T15 / SEO技術15 / 可読性15 / 独自性10 / 文字数密度10)、合格ライン **90点**、最大改稿 **5回**
- 安全ゲート: 8項目の機械チェック(出典なし統計 / タイトル重複80% / 文字数・H2 / 内部リンク・リンク切れ / 景表法NGワード / 未来日付 / スコア突合 / 画像不備)
- 文字数: 本流 **5,000字以上** / 完全ガイド **8,000字以上** / ニュース **2,000字前後**

## 人間が行う必要のある残作業

- [ ] GitHub リポジトリ作成・push、Secrets/Variables 設定(上記手順 1〜2)
- [ ] **認証の設定(どちらか一方)**: 推奨は `claude setup-token` → Secrets `CLAUDE_CODE_OAUTH_TOKEN` 登録(「Maxプランで従量課金なしで動かす」参照)。従量課金なら `ANTHROPIC_API_KEY` を登録
- [ ] **`CLAUDE_MODEL` の設定(APIキー認証時のみ必須)**: docs.claude.com で Opus 4.8 の正式IDを確認して Variables に登録。サブスク認証時は省略可(指定するなら `sonnet` 等のエイリアス推奨)
- [ ] **本番ドメインの確定**: `lp.7senses.co.jp` は仮。確定後 `SITE_URL` Variable を設定し、`generate-articles.mjs` / `embed-images.mjs` / `notify-search.mjs` / テンプレート内の仮ドメインコメントを確認
- [ ] Astro プロジェクトへの組込み(Content Collections・記事ページ・構造化データ)とワークフローのビルド/デプロイステップ有効化
- [ ] Cloudflare Pages 等のデプロイ先設定
- [ ] IndexNow キー生成とサイト直下への `{キー}.txt` 配置
- [ ] Google Search Console へのサイト登録と sitemap.xml / image-sitemap.xml の送信(初回は手動)
- [ ] Slack Incoming Webhook の発行
- [ ] `content/human-review/` の定期確認体制(未達記事の手直し・破棄判断)
- [ ] 記事内の一次情報URL(IT導入補助金公式サイト等)の実在確認と最新公募要領との整合チェック(生成AIの誤引用対策)
- [ ] 週次リライト運用の開始(GSC データが溜まる公開後90日目安)
