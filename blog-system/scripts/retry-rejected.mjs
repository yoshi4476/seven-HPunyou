// =============================================================
// retry-rejected.mjs — 不合格記事の同日自動再挑戦
//
// 役割: 品質審査または安全ゲートで human-review/ に隔離された記事を、
//   同じラン内で自動修正して drafts/ へ戻す。この後ワークフローが
//   品質ループ→画像→安全ゲートの「2周目」を実行するため、修正が
//   通ればその日のうちに公開される。
//
// 修正の中身:
//   1. 機械修正 (決定的): 呼称正規化 / 実在しない内部リンクの解除
//   2. AI修正 (ゲート理由がある場合): 文字数不足の加筆・H2構造の再構成・
//      出典の追記 (許可された公式サイトのみ) を、ゲートの指摘文ごと渡して依頼
//   3. 出力検証 (frontmatter・H2数・文字数) を通った場合のみ採用
//
// 暴走防止: frontmatter の retry_count を加算し、2回失敗した記事は
//   以後触らない (人間レビューに残す)。
//
// 実行: node scripts/retry-rejected.mjs (安全ゲートの直後に配置)
// =============================================================
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";
import { CLIENT } from "./client-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW = join(ROOT, "content", "human-review");
const DRAFTS = join(ROOT, "content", "drafts");
const GATE_LOG = join(ROOT, "logs", "safety-gate-log.json");
const MAX_RETRY = 2;

function fm(md, key) {
  const m = md.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
  return m ? m[1].trim() : "";
}
function setFm(md, key, value) {
  if (new RegExp(`^${key}:`, "m").test(md)) {
    return md.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
  }
  return md.replace(/^---\n/, `---\n${key}: ${value}\n`);
}
function h2Count(md) {
  return (md.match(/^## /gm) || []).length;
}

// 実在しない /blog/xxx/ への内部リンクをアンカーテキストだけ残して解除
function dropDeadLinks(md) {
  let dropped = 0;
  const out = md.replace(/\[([^\]]+)\]\((\/blog\/([^/)]+)\/?)\)/g, (all, text, url, slug) => {
    if (slug === "category") return all;
    const exists = existsSync(join(ROOT, "..", "blog", slug, "index.html")) ||
      ["posted", "publish-queue", "drafts"].some((s) => existsSync(join(ROOT, "content", s, `${slug}.md`)));
    if (exists) return all;
    dropped++;
    return text;
  });
  return { out, dropped };
}

function normalizeNaming(md) {
  let seen = 0;
  const re = new RegExp(CLIENT.naming.official.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return md.replace(re, (m) => (++seen <= 1 ? m : CLIENT.naming.preferred));
}

function latestGateReasons(file) {
  try {
    const log = JSON.parse(readFileSync(GATE_LOG, "utf8"));
    const entries = (Array.isArray(log) ? log : log.entries || []).filter((e) => e.file === file && !e.passed);
    const last = entries[entries.length - 1];
    return last ? last.reasons || [] : [];
  } catch {
    return [];
  }
}

async function aiFix(md, reasons) {
  const system = `あなたは${CLIENT.companyName}のオウンドメディア専属ライターです。公開前検査で差し戻された記事を、指摘だけをピンポイントに解消して修正します。
# 厳守
- frontmatter の全キーを維持 (slug・date は変更禁止)
- 既存の内部リンク・画像タグ (<figure>〜</figure>) は削除しない
- 出典を追加する場合は次の公式サイトのみ使用可: ${CLIENT.factsBlock.filter((l) => l.includes("http")).join(" / ") || "公式一次情報のみ"}
- 実績・統計の数値を新たに創作しない (数値に出典を付けられない場合はその数値表現自体を定性的な表現に直す)
- ${CLIENT.namingRuleText}
- 修正後の記事全文 (frontmatter付きMarkdown) のみを出力。前置き禁止`;
  const user = `以下の記事が公開前検査で差し戻されました。指摘をすべて解消してください。

# 検査の指摘 (これだけを直す。他の書き換えは最小限に)
${reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}

# 記事
${md}`;
  const out = (await callClaude(system, user, { maxTokens: 16000 }))
    .replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
  const valid = /^---\n[\s\S]*?\btitle:/.test(out)
    && out.length >= md.length * 0.6
    && fm(out, "slug") === fm(md, "slug")
    && h2Count(out) >= Math.min(3, h2Count(md));
  return valid ? out : null;
}

async function main() {
  if (!existsSync(REVIEW)) return;
  const files = readdirSync(REVIEW).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("[retry] 不合格記事なし → スキップ");
    return;
  }
  for (const f of files) {
    const path = join(REVIEW, f);
    let md = readFileSync(path, "utf8");
    const retries = Number(fm(md, "retry_count") || 0);
    if (retries >= MAX_RETRY) {
      console.log(`[retry] ${f}: 再挑戦${MAX_RETRY}回超過 → 人間レビューに残置`);
      continue;
    }
    const reasons = latestGateReasons(f);
    console.log(`[retry] ${f}: 再挑戦 ${retries + 1}/${MAX_RETRY} (指摘${reasons.length}件)`);

    // 1. 機械修正
    md = normalizeNaming(md);
    const { out, dropped } = dropDeadLinks(md);
    md = out;
    if (dropped) console.log(`[retry]   実在しない内部リンク${dropped}本を解除`);

    // 2. AI修正 (機械修正で解決しない指摘が残っている場合のみ)
    const needsAi = reasons.some((r) => /文字数不足|H2不足|出典なし|タイトル長|メタディスクリプション/.test(String(r)));
    if (needsAi && hasClaudeAuth()) {
      try {
        const fixed = await aiFix(md, reasons);
        if (fixed) {
          md = fixed;
          console.log(`[retry]   AI修正を適用`);
        } else {
          console.warn(`[retry]   AI修正の出力が不正 → 機械修正のみで再投入`);
        }
      } catch (e) {
        console.warn(`[retry]   AI修正失敗 → 機械修正のみで再投入: ${e.message}`);
      }
    }

    md = setFm(md, "retry_count", String(retries + 1));
    writeFileSync(join(DRAFTS, f), md, "utf8");
    unlinkSync(path);
    console.log(`[retry]   drafts/ へ再投入 → 2周目の審査へ`);
  }
}

main().catch((e) => { console.error("[retry] 失敗 (記事はreviewに残置):", e.message); process.exit(0); });
