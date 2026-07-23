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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
`.trim();

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

function buildArticlePrompt(kw, mode) {
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
      let md = await callClaude(systemPrompt, buildArticlePrompt(kw, isNews ? "news" : "main"), { maxTokens: MAX_TOKENS });
      // モデルがコードフェンスで包んだ場合の除去
      md = md.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
      // 記事タイプをfrontmatterに記録 (safety-gateの文字数基準の判別に必要)
      if (isNews && !/^type:\s*"?news"?/m.test(md)) {
        md = md.replace(/^---\n/, '---\ntype: "news"\n');
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
