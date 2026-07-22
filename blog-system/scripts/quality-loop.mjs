// =============================================================
// quality-loop.mjs — 品質採点・改稿ループ
//
// 役割:
//   1. content/drafts/ の各記事を「執筆AIとは別セッション」で採点する。
//      ※重要: 採点AIには記事本文のみを渡し、執筆時のプロンプトや事情は
//        一切見せない。自己弁護・自己採点の甘さを構造的に排除するため。
//   2. 100点ルーブリックで採点。MIN_SCORE (既定90) 未満なら減点理由を
//      執筆AIに差し戻して改稿 → 再採点。最大 MAX_REVISIONS (既定5) 回。
//   3. 上限に達しても未達なら content/human-review/ へ移動 (人間判断へ)。
//   4. 点数推移を logs/quality-log.json に記録する。
//
// 実行: node scripts/quality-loop.mjs
// 環境変数: CLAUDE_CODE_OAUTH_TOKEN (サブスク認証。CLAUDE_MODEL は任意)
//           または ANTHROPIC_API_KEY + CLAUDE_MODEL (従量課金)
//           どちらも未設定なら明確なメッセージを出してスキップ (exit 0)
//           MIN_SCORE (既定90) / MAX_REVISIONS (既定5)
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS_DIR = join(ROOT, "content", "drafts");
const REVIEW_DIR = join(ROOT, "content", "human-review");
const LOG_PATH = join(ROOT, "logs", "quality-log.json");
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 90);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS ?? 5);

// 100点ルーブリック (配点は safety-gate や README と揃えること)
const RUBRIC = [
  { key: "search_intent", label: "検索意図の網羅", max: 20 },
  { key: "aio_fit", label: "AIO適合 (断言文・FAQ・引用されやすさ)", max: 15 },
  { key: "eeat", label: "E-E-A-T・一次情報 (出典・実体験・専門性)", max: 15 },
  { key: "seo_tech", label: "SEO技術 (タイトル・見出し構造・内部リンク)", max: 15 },
  { key: "readability", label: "可読性と緩急 (1文60字以内・段落3〜4行・3〜4段落ごとの視覚要素(表/箇条書き/画像)・強調の適切な使用(太字1セクション1〜2回+em-marker2〜3箇所)・単調な見出しの回避。文字だけの画面が続く/極小文字・強調乱用は減点)", max: 15 },
  { key: "originality", label: "独自性 (自社知見・切り口)", max: 10 },
  { key: "density", label: "文字数と情報密度", max: 10 },
];

// ---------------- 共通ユーティリティ ----------------
// Claude 呼び出しの実体は claude-client.mjs (サブスク認証 / APIキーの両対応) に共通化した。
function requireEnv() {
  if (!hasClaudeAuth()) {
    console.error("[quality-loop] 認証なし (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY がどちらも未設定) のため品質ループをスキップします。");
    console.error("  サブスク認証: CLAUDE_CODE_OAUTH_TOKEN を設定 (CLAUDE_MODEL は任意)。APIキー認証: ANTHROPIC_API_KEY + CLAUDE_MODEL。README.md 参照。");
    process.exit(0);
  }
  // APIキーモード (サブスクトークン無し) の場合のみ CLAUDE_MODEL が必須
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_MODEL) {
    console.error("[quality-loop] APIキーモードでは CLAUDE_MODEL が必須のため品質ループをスキップします (README.md 参照)。");
    process.exit(0);
  }
}

// ---------------- 採点 (執筆AIと別セッション) ----------------
// 採点AIには「記事本文のみ」を渡す。誰が・どんな指示で書いたかは渡さない。
function buildScoringSystemPrompt() {
  return `あなたは外部の辛口SEO編集者です。提出された記事だけを材料に、以下のルーブリックで採点します。執筆者の意図や事情は考慮しません。

# ルーブリック (合計100点)
${RUBRIC.map((r) => `- ${r.key} (${r.label}): ${r.max}点満点`).join("\n")}

# 採点ルール (厳守)
- 各項目に「採点理由を1行」必ず書く。理由のない点数は無効
- 根拠なき加点は禁止。記事内に証拠 (該当箇所) を指摘できない場合は加点しない
- 出典URLのない統計数値、曖昧な断定、水増し文章は減点する
- 満点は「これ以上直すところがない」場合のみ。安易に高得点を付けない

# 出力形式 (JSONのみ。前置き・コードフェンス禁止)
{"total": <0-100>, "items": [{"key": "<ルーブリックkey>", "score": <点数>, "max": <満点>, "reason": "<採点理由1行>"}], "deductions": ["<減点理由と修正指示を具体的に (改稿AIへの差し戻し文)>"]}`;
}

function parseScore(text) {
  // モデルがコードフェンスを付けた場合に備えて剥がす
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("採点結果のJSONが見つかりません");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function scoreArticle(md) {
  const raw = await callClaude(
    buildScoringSystemPrompt(),
    `次の記事を採点してください。\n\n<article>\n${md}\n</article>`,
    { maxTokens: 4000 }
  );
  return parseScore(raw);
}

// ---------------- 改稿 (減点理由を執筆AIへ差し戻し) ----------------
async function reviseArticle(md, deductions) {
  const system = `あなたはセブンセンシズ株式会社のオウンドメディア専属ライターです。編集者からの減点指摘に基づき記事を改稿します。frontmatter の構造 (title, slug, description, category, tags, date, author, thumbnail) は必ず維持してください。`;
  const user = `以下の記事が品質審査で不合格になりました。減点理由をすべて解消するよう改稿し、改稿後の記事全文 (frontmatter付きMarkdown) のみを出力してください。前置きは不要です。

# 減点理由 (すべて解消すること)
${deductions.map((d, i) => `${i + 1}. ${d}`).join("\n")}

# 現在の記事
${md}`;
  let revised = await callClaude(system, user, { maxTokens: 16000 });
  return revised.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
}

// ---------------- メイン処理 ----------------
async function main() {
  requireEnv();
  mkdirSync(REVIEW_DIR, { recursive: true });
  mkdirSync(dirname(LOG_PATH), { recursive: true });

  const drafts = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".md"));
  if (drafts.length === 0) {
    console.log("[quality-loop] 対象の下書きがありません。スキップします。");
    return;
  }

  const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { entries: [] };

  for (const file of drafts) {
    const path = join(DRAFTS_DIR, file);
    let md = readFileSync(path, "utf8");
    const history = []; // 点数推移
    let result = null;

    console.log(`[quality-loop] 採点開始: ${file}`);
    for (let round = 0; round <= MAX_REVISIONS; round++) {
      try {
        result = await scoreArticle(md);
      } catch (err) {
        console.error(`[quality-loop] ${file} の採点に失敗: ${err.message}`);
        break;
      }
      history.push({ round, total: result.total, items: result.items });
      console.log(`[quality-loop] ${file} ラウンド${round}: ${result.total}点`);

      if (result.total >= MIN_SCORE) break;
      if (round === MAX_REVISIONS) break; // 改稿上限。この後 human-review へ

      console.log(`[quality-loop] ${file} を改稿します (${round + 1}/${MAX_REVISIONS})`);
      md = await reviseArticle(md, result.deductions ?? ["総合的に品質を高めてください"]);
      writeFileSync(path, md, "utf8"); // 改稿版で上書き (最終判定前でも最新版を保持)
    }

    const passed = result && result.total >= MIN_SCORE;
    if (!passed) {
      // 合格ラインに届かない記事は自動公開せず人間レビューへ隔離
      renameSync(path, join(REVIEW_DIR, file));
      console.warn(`[quality-loop] ${file} は${MAX_REVISIONS}回の改稿でも未達 → human-review/ へ移動`);
    }

    log.entries.push({
      file: basename(file),
      date: new Date().toISOString(),
      finalScore: result ? result.total : null,
      revisions: Math.max(0, history.length - 1),
      passed,
      history,
      stage: "quality-loop",
    });
  }

  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
  console.log(`[quality-loop] 完了。ログ: ${LOG_PATH}`);
}

main().catch((err) => {
  console.error("[quality-loop] 致命的エラー:", err);
  process.exit(1);
});
