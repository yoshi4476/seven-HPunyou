// =============================================================
// replenish-keywords.mjs — キーワードキューの自動補充
//
// 役割: pending のキーワードが THRESHOLD 本を下回ったら、Claude に
//   新しい検索キーワードを提案させてキューに追加する (枯渇による
//   毎日ランの空振りを防ぐ)。
//
// 重複防止: 既存キューの全キーワード + 公開済み記事のタイトルを渡し、
//   「同じ検索意図」のキーワードを禁止する (SEOカニバリ対策)。
// 認証なし時: メッセージを出してスキップ (exit 0)。
//
// 実行: node scripts/replenish-keywords.mjs
// =============================================================
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_PATH = join(ROOT, "data", "keywords-queue.json");
const SITE_BLOG_DIR = join(ROOT, "..", "blog"); // 同一リポジトリのサイト本体
const THRESHOLD = 15;  // pending がこの本数を下回ったら補充
const BATCH = 30;      // 1回の補充本数

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

async function main() {
  const queue = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
  const pending = queue.keywords.filter((k) => k.status === "pending");
  if (pending.length >= THRESHOLD) {
    console.log(`[replenish] pending ${pending.length}本 (閾値${THRESHOLD}) → 補充不要`);
    return;
  }
  if (!hasClaudeAuth()) {
    console.log("[replenish] Claude未認証 → 補充をスキップ (キュー残量に注意)");
    return;
  }

  const existing = [
    ...queue.keywords.map((k) => k.keyword),
    ...publishedTitles(),
  ];
  const system = `あなたは日本の中小企業向けB2B SEOのキーワード戦略担当です。
セブンセンシズ株式会社 (IT導入補助金申請サポート / システム開発・AI導入 / AIO / MEO。大阪拠点・全国対応) の
オウンドメディア用に、検索流入と商談につながるロングテールキーワードを提案します。`;
  const user = `新しい記事キーワードを${BATCH}本、JSON配列のみで出力してください (前置き禁止)。

# 厳守
- 補助金の呼称は「AI導入補助金」を使う (「IT導入補助金」「IT補助金」はキーワードに使わない)
- 下の「既存リスト」と同じ・または検索意図が実質同じキーワードは禁止 (言い換えの重複も禁止)
- 各キーワードは2〜4語のロングテール (例: "IT導入補助金 飲食店 事例")
- category は hojo / aio / meo / dev のいずれか。補助金系を5割、残りを他カテゴリに配分
- priority は S (商談直結) / A (比較検討) / B (情報収集) で付ける

# 出力形式
[{"keyword": "...", "priority": "S", "category": "hojo"}, ...]

# 既存リスト (これらと検索意図が重複するものは出さない)
${existing.map((t) => `- ${t}`).join("\n")}`;

  const raw = await callClaude(system, user, { maxTokens: 4000 });
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("補充キーワードのJSONが見つかりません");
  const items = JSON.parse(m[0]).filter((k) => k.keyword && k.category);

  let nextId = Math.max(0, ...queue.keywords.map((k) => Number(k.id) || 0)) + 1;
  const seen = new Set(existing.map((t) => t.replace(/\s+/g, "")));
  let added = 0;
  for (const it of items) {
    const key = it.keyword.replace(/\s+/g, "");
    if (seen.has(key)) continue; // 機械的な最終重複チェック
    seen.add(key);
    queue.keywords.push({
      id: String(nextId++),
      keyword: it.keyword,
      priority: ["S", "A", "B"].includes(it.priority) ? it.priority : "B",
      category: ["hojo", "aio", "meo", "dev"].includes(it.category) ? it.category : "hojo",
      status: "pending",
      addedBy: "auto-replenish",
      addedAt: new Date().toISOString().slice(0, 10),
    });
    added++;
  }
  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(`[replenish] ${added}本を補充しました (pending: ${pending.length} → ${pending.length + added})`);
}

main().catch((e) => { console.error("[replenish] 失敗 (次回ランで再試行):", e.message); process.exit(0); });
