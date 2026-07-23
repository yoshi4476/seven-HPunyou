// =============================================================
// generate-articles.mjs — 記事生成スクリプト
//
// 役割:
//   1. data/keywords-queue.json から優先度順 (S > A > B → id昇順) に
//      pending キーワードを取得 (通常: 2本 / --news: ニュース型1本)
//   2. Claude (claude-client.mjs 経由) で記事を生成
//      認証はサブスク (CLAUDE_CODE_OAUTH_TOKEN) > APIキー (ANTHROPIC_API_KEY) の順
//   3. content/drafts/ に frontmatter 付き Markdown として保存
//   4. キューを消し込み (status: pending → generated)
//
// 実行: node scripts/generate-articles.mjs [--news]
// 必要な環境変数 (どちらか一方でよい):
//   CLAUDE_CODE_OAUTH_TOKEN … サブスク認証 (Claude Pro/Max)。CLAUDE_MODEL は任意
//   ANTHROPIC_API_KEY       … 従量課金。CLAUDE_MODEL 必須 (ハードコード禁止。README 参照)
//   どちらも未設定なら明確なメッセージを出してスキップ終了 (exit 0)
// =============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_BLOG_DIR = join(ROOT, "..", "blog"); // 同一リポジトリのサイト本体 (公開済み記事)

// 公開済み記事のタイトル一覧 (重複した検索意図の記事を書かせないためにプロンプトへ渡す)
function publishedTitles() {
  const titles = [];
  if (!existsSync(SITE_BLOG_DIR)) return titles;
  for (const d of readdirSync(SITE_BLOG_DIR)) {
    const f = join(SITE_BLOG_DIR, d, "index.html");
    if (d === "category" || !existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/<title>(.*?)[||]/);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}
const QUEUE_PATH = join(ROOT, "data", "keywords-queue.json");
const DRAFTS_DIR = join(ROOT, "content", "drafts");
const MAIN_COUNT = 2;          // 朝の本流記事は2本
const NEWS_COUNT = 1;          // 夕方のニュース記事は1本
const MAX_TOKENS = 16000;      // 8000字ガイド記事でも収まる上限 (APIキーモード時に適用)
const LP_URL = "https://lp.7senses.co.jp/"; // ※仮ドメイン。本番ドメイン確定後に要確認・差し替え

// 文字数要件 (safety-gate.mjs と揃えること)
const MIN_CHARS = { main: 5000, guide: 8000, news: 2000 };

// 景表法・薬機法などに配慮した禁止表現リスト (生成プロンプトにも埋め込む)
const NG_WORDS = [
  "必ず採択", "必ず儲かる", "絶対に儲かる", "絶対に成功", "100%採択", "100%成功",
  "日本一", "業界No.1", "国内No.1", "世界一", "最安値保証", "確実に稼げる",
  "誰でも簡単に儲かる", "リスクゼロ", "損しない", "返金保証で絶対安心",
];

// 会社の一次情報 (LP・提供資料由来)。数値はこのリスト以外を勝手に作らないよう指示する
// 実績数値は「支援50社+・採択通過率90%以上(※当社支援実績)」に統一 (旧: 120社/98% は使用禁止)
const COMPANY_FACTS = `
- 会社: セブンセンシズ株式会社 (大阪市東成区)
- 代表: 原口 優 (代表取締役)
- LP: ${LP_URL} (※仮ドメイン・要確認)
- サービス: AI導入補助金 (IT導入補助金) 申請サポート / システム開発 / AIOコンサルティング / MEOコンサルティング
- 実績: 支援50社+ / 採択通過率90%以上 (※当社支援実績) / 着金まで約2〜3ヶ月 / 補助金上限350万円
- 実績数値を書くときは必ず「※当社支援実績」を添える。「120社」「98%」など旧数値は絶対に使わない
- MEO実績: コーポレートサイト 7senses.co.jp にて MEOツール「G-ran」実績あり
${loadCaseFacts()}
`.trim();

// 支援事例プール (data/case-studies.json)。事実確認済みの事例のみ。
// 記事には1〜2件を自然な文脈で織り込ませる (誇張・創作は禁止)
function loadCaseFacts() {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, "data", "case-studies.json"), "utf8"));
    const lines = d.cases.map((c) => `  - ${c.industry} (${c.size}): ${c.summary}`).join("\n");
    return `- 使用してよい支援事例 (事実。社名は非公開のまま。数値の誇張・創作は禁止。記事には1〜2件を「※当社支援事例」付きで自然に織り込む):\n${lines}`;
  } catch {
    return "";
  }
}

// カテゴリ別サービスハブページ (内部リンク先。トピッククラスターのハブとして必ず言及させる)
const SERVICE_HUBS = {
  hojo: "/service/hojokin/",
  aio: "/service/aio/",
  meo: "/service/meo/",
  dev: "/service/dev/",
};

// ---------------- 共通ユーティリティ ----------------
// Claude 呼び出しの実体は claude-client.mjs (サブスク認証 / APIキーの両対応) に共通化した。
function requireEnv() {
  if (!hasClaudeAuth()) {
    // 認証情報が無い環境 (ローカル検証など) では失敗させず、明確に伝えてスキップする
    console.error("[generate-articles] 認証なし (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY がどちらも未設定) のため記事生成をスキップします。");
    console.error("  サブスク認証: `claude setup-token` で生成したトークンを CLAUDE_CODE_OAUTH_TOKEN に設定 (CLAUDE_MODEL は任意)。");
    console.error("  APIキー認証: ANTHROPIC_API_KEY と CLAUDE_MODEL を設定。詳細は README.md 参照。");
    process.exit(0);
  }
  // APIキーモード (サブスクトークン無し) の場合のみ CLAUDE_MODEL が必須
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_MODEL) {
    console.error("[generate-articles] APIキーモードでは CLAUDE_MODEL が必須のため記事生成をスキップします (README.md 参照)。");
    process.exit(0);
  }
}

// ---------------- プロンプト構築 ----------------
function buildSystemPrompt() {
  return `あなたはセブンセンシズ株式会社のオウンドメディア専属ライターです。中小企業経営者 (ITが得意でない50代を含む) に向けて、検索エンジンとAI検索 (ChatGPT/Perplexity/AI Overview) の両方で評価される日本語記事を書きます。

# 会社の一次情報 (これ以外の実績数値を創作してはならない)
${COMPANY_FACTS}

# 遵守事項 (景品表示法・信頼性)
- 禁止表現 (絶対に使わない): ${NG_WORDS.join(" / ")}
- 特典・割引・実質負担軽減の表現 (「〇〇円OFF」「採択者だけの割引・特典」「先着〇社限定」「実質負担〇〇円」「補助金+割引で導入費を圧縮」等) は書いてはならない (補助金規程上の禁止類型。採択を条件とした利益供与と評価されるリスクがある)
- 効果・成果は断定せず「実績として」「〜の傾向」など根拠を伴う表現にする
- 統計数値・制度情報・固有名詞には必ず出典 (公式サイト等の一次情報URL) を付ける。出典を確認できない数値は書かない
- 制度内容 (補助金額・スケジュール等) は「最新情報は公式サイトで要確認」の注意書きを添える`;
}

// ---------------- 構成案の先行生成 (アウトライン → 執筆の2段階) ----------------
// 長文の一発書きで起きる「検索意図の取りこぼし・後半の失速」を防ぐため、
// 先に構成を確定させ、機械チェックを通った構成に忠実に執筆させる。
function buildOutlinePrompt(kw, mode) {
  const h2 = mode === "news" ? "3〜4個" : "4〜6個";
  return `以下のキーワードで書くブログ記事の「構成案のみ」を作成してください (本文は書かない)。

# 対象キーワード
${kw.keyword} (カテゴリ: ${kw.category} / 記事タイプ: ${mode})

# 構成案に含めるもの (箇条書きのアウトラインのみを出力)
1. タイトル案 (32字前後・主要キーワードと年号を前半に)
2. この検索をする読者の意図3パターン
3. H2見出し ${h2} (検索意図を網羅する順序で)
4. 各H2ごとに: 盛り込む要点3つ / 使う視覚要素 (表・箇条書き・図解マーカーのいずれか1つ以上) / 出典URLや当社一次情報を置く位置
5. FAQ 2〜3問の質問文 (周辺トピックを1問含める)
6. 記事全体で強調 (em-marker) する最重要結論 2〜3箇所の候補`;
}

function isValidOutline(text) {
  // H2に相当する行が4本以上あり、FAQ設計が含まれることを機械確認
  const h2Lines = (text.match(/^\s*(?:[-*#]|\d+[.)]|H2)/gm) || []).length;
  return h2Lines >= 4 && /FAQ|よくある質問/.test(text);
}

function buildArticlePrompt(kw, mode, outline = null) {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  const isGuide = kw.keyword.includes("完全ガイド");
  const type = mode === "news" ? "news" : isGuide ? "guide" : "main";
  const minChars = MIN_CHARS[type];
  const lengthNote =
    type === "news"
      ? `ニュース解説型記事。本文${minChars}字前後 (±20%)。`
      : `本文${minChars}字以上。`;

  return `以下のキーワードで検索1位とAI検索での引用を狙うブログ記事を書いてください。

# 対象キーワード
${kw.keyword} (カテゴリ: ${kw.category} / 記事タイプ: ${type})

${outline ? `# 確定済みの構成案 (この構成に忠実に執筆する。見出し・要素配置を勝手に変えない)
${outline}

` : ""}# 既存記事との重複禁止 (SEOカニバリ防止)
以下は当サイトの既存記事タイトルです。これらと「同じ検索意図」の記事は書かないでください。
テーマが近い場合は、対象読者・業種・切り口を明確に変えて差別化してください。
${publishedTitles().map((t) => `- ${t}`).join("\n")}

# 記事要件 (すべて必須)
1. タイトルは32字前後。キーワードを自然に含める
2. 冒頭200字以内に「${kw.keyword.split(" ")[0]}とは〜である」形式の断言文とキーワードを含める (AI検索の引用対策)
3. 冒頭に「本記事は${yearMonth}時点の情報です」の鮮度表示を入れる
4. 冒頭に「この記事は{具体的な対象者}向けです」の限定表記を入れる
5. 目次 (箇条書きリンク形式) を入れる
6. H2見出しを4〜6個 (ニュース型は3〜4個可)
7. FAQ を2〜3問。各回答は40〜60字で簡潔に (FAQ構造化データ転用前提)
8. 一次情報 (官公庁・公式サイト等) への出典URLを2つ以上、統計・制度数値の近くに含める (例: IT導入補助金事務局 https://it-shien.smrj.go.jp/ 、中小企業庁 https://www.chusho.meti.go.jp/ )
8-2. 上記COMPANY_FACTSの実績・運用知見を1〜2箇所、自然な文脈で織り込む (品質審査のE-E-A-T評価対策。事実の創作は禁止)
8-3. FAQには周辺トピック (不採択時の再申請方法/入金時の会計処理は税理士へ相談 等) を1問含める
9. 各H2セクションの末尾に「▶ 今すぐ試せるアクション」を1つ入れる
10. 記事末尾にセブンセンシズのLP (${LP_URL}) への自然なCTAを入れる
11. ${lengthNote}
12. 比較・料金の情報は Markdown の表 (HTML表としてレンダリングされる) で書く。画像化はしない
13. 同一サイト内の関連記事への内部リンクを2本以上入れる (URLは /blog/{英語スラッグ}/ 形式で、関連しそうな仮スラッグでよい)。加えて、このカテゴリのサービスハブページ ${SERVICE_HUBS[kw.category] || SERVICE_HUBS.hojo} への内部リンクを本文中に1本、自然な文脈で入れる (アンカーテキストはサービス内容を表すキーワードにする)
14. H2見出しの2〜3個ごとに、画像挿入位置マーカー「<!--IMG: (そのセクションの図解内容の説明)-->」を単独行で入れる (後工程の embed-images がこのマーカーを図解画像に置換する。説明は「〜の手順図」「〜の比較図」「〜の概念図」のように具体的に書く)

# 可読性・緩急の要件 (読者を飽きさせない。すべて必須)
15. 1文は60字以内。1段落は3〜4行(150字前後)まで。結論→理由→具体例の順(PREP)
16. 重要フレーズの強調は **太字** を1セクション1〜2回まで(乱用禁止)。記事全体で最重要の結論2〜3箇所は <span class="em-marker">〜</span>(蛍光マーカー風の強調。サイト側でスタイル定義済み)で囲む
17. 3〜4段落ごとに視覚要素(表・箇条書き・画像マーカー・引用)を必ず挟み、文字だけの画面が続かないようにする
18. 数値・金額・期間は文中に埋めず、可能な限り表か箇条書きに出す(小さな文字・長い括弧書きの連続は禁止)
19. 見出しは体言止めと疑問形を交互に使うなど単調にしない。H2に読者の疑問をそのまま使うことを推奨(AI検索の引用対策を兼ねる)

# 出力形式
以下の frontmatter 付き Markdown「のみ」を出力する (前置き・後書き禁止):

---
title: "記事タイトル"
slug: "english-slug-here"
description: "120字前後のメタディスクリプション"
category: "${kw.category}"
tags: ["タグ1", "タグ2", "タグ3"]
date: "${now.toISOString().slice(0, 10)}"
author: "原口 優(セブンセンシズ株式会社 代表取締役)"
thumbnail: ""
---

(本文)

- slug は内容を表す英語ケバブケース (例: ai-hojokin-2026-guide)
- thumbnail は空文字のままにする (後工程で自動生成される)`;
}

// ---------------- メイン処理 ----------------
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

async function main() {
  requireEnv();
  const isNews = process.argv.includes("--news");
  const count = isNews ? NEWS_COUNT : MAIN_COUNT;

  const queue = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
  const priorityOrder = { S: 0, A: 1, B: 2 };
  const targets = queue.keywords
    .filter((k) => k.status === "pending")
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.id - b.id)
    .slice(0, count);

  if (targets.length === 0) {
    console.log("[generate-articles] pending のキーワードがありません。キューを補充してください。");
    return;
  }

  mkdirSync(DRAFTS_DIR, { recursive: true });
  const systemPrompt = buildSystemPrompt();

  for (const kw of targets) {
    console.log(`[generate-articles] 生成開始: #${kw.id} "${kw.keyword}" (${isNews ? "news" : "main"})`);
    try {
      // 第1段階: 構成案の生成 (不良構成なら構成なしで執筆にフォールバック)
      let outline = null;
      try {
        const o = (await callClaude(systemPrompt, buildOutlinePrompt(kw, isNews ? "news" : "main"), { maxTokens: 3000 })).trim();
        if (isValidOutline(o)) {
          outline = o;
          console.log(`[generate-articles] 構成案を確定 (${o.length}字) → 構成に沿って執筆`);
        } else {
          console.warn("[generate-articles] 構成案が要件を満たさない → 構成なしで執筆");
        }
      } catch (e) {
        console.warn(`[generate-articles] 構成案の生成に失敗 → 構成なしで執筆: ${e.message}`);
      }

      // 第2段階: 本文執筆
      let md = await callClaude(systemPrompt, buildArticlePrompt(kw, isNews ? "news" : "main", outline), { maxTokens: MAX_TOKENS });
      // モデルがコードフェンスで包んだ場合の除去
      md = md.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
      // 記事タイプをfrontmatterに記録 (safety-gateの文字数基準の判別に必要)
      if (isNews && !/^type:\s*"?news"?/m.test(md)) {
        md = md.replace(/^---\n/, '---\ntype: "news"\n');
      }

      // 提出前の推敲パス: 審査ルーブリックで自己点検して1回磨いてから品質ループへ
      // (初稿スコアの底上げ。出力が不正なら初稿のまま提出する)
      try {
        const polishUser = `以下はあなたが書いた記事の下書きです。審査ルーブリック (検索意図の網羅20点 / AI検索適性15点 / E-E-A-T15点 / 技術SEO15点 / 可読性15点 / 独自性10点 / 情報密度10点) の観点で自己点検し、弱点を修正した完成版のみを frontmatter付きMarkdown で出力してください。前置き・後書きは禁止。frontmatter の全キー (type がある場合は type も) を維持してください。\n\n${md}`;
        const polished = (await callClaude(systemPrompt, polishUser, { maxTokens: MAX_TOKENS }))
          .replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
        if (/^---\n[\s\S]*?\btitle:/.test(polished) && polished.length >= md.length * 0.6) {
          md = polished;
          console.log(`[generate-articles] 推敲パス適用 (${md.length}字)`);
        } else {
          console.warn("[generate-articles] 推敲出力が不正 → 初稿のまま提出");
        }
      } catch (e) {
        console.warn(`[generate-articles] 推敲パス失敗 → 初稿のまま提出: ${e.message}`);
      }

      const fm = parseFrontmatter(md);
      const slug = (fm.slug || `article-${kw.id}`).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      let outPath = join(DRAFTS_DIR, `${slug}.md`);
      if (existsSync(outPath)) outPath = join(DRAFTS_DIR, `${slug}-${Date.now()}.md`); // スラッグ衝突回避

      writeFileSync(outPath, md, "utf8");
      console.log(`[generate-articles] 保存: ${outPath} (${md.length}字)`);

      // キュー消し込み
      const entry = queue.keywords.find((k) => k.id === kw.id);
      entry.status = "generated";
      entry.generatedAt = new Date().toISOString();
      entry.slug = slug;
      if (isNews) entry.type = "news";
      writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf8");
    } catch (err) {
      // 1本の失敗で全体を止めない (残りのキーワードは翌日以降に持ち越し)
      console.error(`[generate-articles] #${kw.id} の生成に失敗: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("[generate-articles] 致命的エラー:", err);
  process.exit(1);
});
