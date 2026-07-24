// =============================================================
// refresh-article.mjs — 既存記事の自動リライト (コンテンツ・ディケイ対策)
//
// 役割: 検索順位は「古くなった記事」から静かに下がる。毎週1本、
//   公開済み記事のうち最も更新が古いものを選び、最新化リライトして
//   drafts/ へ戻す (その後は通常パイプライン = 品質二軸85点審査 →
//   画像 → 安全ゲート → 再公開 → lastmod更新 → 検索エンジン再通知)。
//
// 選定基準: content/posted/ の frontmatter date が最も古い記事。
//   ただし公開から REFRESH_MIN_DAYS 日未満ならスキップ (若い記事は触らない)。
// 安全策: リライト出力が不正 (frontmatter欠落・6割未満に短縮) なら中止。
//   slug・date は維持 (URLを変えない。鮮度は sitemap の lastmod で伝える)。
//
// 実行: node scripts/refresh-article.mjs
// =============================================================
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSTED = join(ROOT, "content", "posted");
const DRAFTS = join(ROOT, "content", "drafts");
const REFRESH_MIN_DAYS = Number(process.env.REFRESH_MIN_DAYS ?? 45);

function fm(md, key) {
  const m = md.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
  return m ? m[1].trim() : "";
}

async function main() {
  if (!hasClaudeAuth()) {
    console.log("[refresh] Claude未認証 → リライトをスキップ");
    return;
  }
  if (!existsSync(POSTED)) {
    console.log("[refresh] posted/ なし → スキップ");
    return;
  }
  const candidates = readdirSync(POSTED)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const md = readFileSync(join(POSTED, f), "utf8");
      return { f, md, date: fm(md, "date") || "9999-99-99" };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const target = candidates[0];
  if (!target) {
    console.log("[refresh] リライト対象なし (postedが空)");
    return;
  }
  const ageDays = (Date.now() - new Date(target.date).getTime()) / 86400000;
  if (!(ageDays >= REFRESH_MIN_DAYS)) {
    console.log(`[refresh] 最古記事 (${target.f}) は公開${Math.floor(ageDays)}日で基準(${REFRESH_MIN_DAYS}日)未満 → 今回はスキップ`);
    return;
  }

  console.log(`[refresh] リライト対象: ${target.f} (公開日 ${target.date})`);
  const system = `あなたはセブンセンシズ株式会社のオウンドメディア専属ライター兼SEO編集者です。既存記事を「最新化リライト」します。
# 厳守
- frontmatter の全キー (title, slug, description, category, tags, date, author, thumbnail, type) をそのまま維持する (slugとdateは絶対に変えない)
- 既存の内部リンク・出典URL・画像タグ (<figure>〜</figure>) は削除しない
- 制度の呼称は「AI導入補助金」で統一。「必ず」「100%」等の断定や割引系表現は禁止
- 実績数値は「支援50社+・採択通過率90%以上 (※当社支援実績)」のみ使用可。事例・数値の創作は禁止`;
  const user = `以下の公開済み記事を、検索・AI検索の評価が上がるように最新化リライトしてください。改善後の記事全文 (frontmatter付きMarkdown) のみを出力。前置き禁止。

# リライトの観点
1. 情報の鮮度: 古く感じる表現を現在形に整え、時点表記 (2026年◯月時点) を最新化する
2. 冒頭に「この記事の要点」3行 (各60字以内の断言文) が無ければ追加する
3. 各H2の直下を「40〜60字の直接回答」で始める形に整える (強調スニペット対策)
4. FAQの回答を40〜60字の断言形に統一。可能なら周辺トピックのFAQを1問追加する
5. 薄いセクションに具体性 (表・手順・数字) を1つ追加する。水増しはしない
6. 1文60字以内・em-marker 2〜3箇所を維持する

# 現在の記事
${target.md}`;

  const out = (await callClaude(system, user, { maxTokens: 16000 }))
    .replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();

  const valid = /^---\n[\s\S]*?\btitle:/.test(out)
    && out.length >= target.md.length * 0.6
    && fm(out, "slug") === fm(target.md, "slug");
  if (!valid) {
    console.warn("[refresh] リライト出力が不正 (frontmatter/長さ/slug) → 中止して原本を維持");
    return;
  }

  writeFileSync(join(DRAFTS, target.f), out, "utf8");
  unlinkSync(join(POSTED, target.f));
  console.log(`[refresh] drafts/ へ投入完了 → この後の品質審査・安全ゲートを通過すれば再公開されます`);
}

main().catch((e) => { console.error("[refresh] 失敗 (原本は無変更):", e.message); process.exit(0); });
