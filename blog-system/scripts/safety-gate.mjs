// =============================================================
// safety-gate.mjs — 公開前 安全ゲート (機械チェック)
//
// 役割: 執筆AIとは完全に独立した「機械的」最終チェック。
//   AIの自己申告を信用せず、正規表現・ファイル突合・HTTP検証のみで判定する。
//
// 不合格条件 (1つでも該当 → content/human-review/ へ移動):
//   ① 出典URLの無い固有名詞・統計数字 (段落単位のヒューリスティック)
//   ② 既存記事とタイトル部分一致 80% 以上 (重複コンテンツ防止)
//   ③ 規定文字数未満 / H2 が 3個未満
//   ④ 内部リンク 2本未満 / リンク切れ (外部リンク HEAD 検証)
//   ⑤ NGワード (景表法: 「必ず採択」「絶対に儲かる」「根拠なきNo.1・日本一」等)
//   ⑥ 未来日付・事実性エラー (frontmatter 日付が未来 / 本文の年が異常)
//   ⑦ 品質スコア 90 未満 (logs/quality-log.json と突合)
//   ⑧ 画像不備 (サムネ欠落 / alt属性欠落 / WebP 150KB 超過)
//
// 合格 → content/publish-queue/ へ移動。
// 判定理由は logs/safety-gate-log.json に JSON で記録する。
//
// 実行: node scripts/safety-gate.mjs  (Anthropic API 不要)
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT } from "./client-config.mjs";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS_DIR = join(ROOT, "content", "drafts");
const QUEUE_DIR = join(ROOT, "content", "publish-queue");
const REVIEW_DIR = join(ROOT, "content", "human-review");
const POSTED_DIR = join(ROOT, "content", "posted");
const IMAGES_DIR = join(ROOT, "public", "images", "blog");
const QUALITY_LOG = join(ROOT, "logs", "quality-log.json");
const GATE_LOG = join(ROOT, "logs", "safety-gate-log.json");

const MIN_SCORE = Number(process.env.MIN_SCORE ?? 90);
const MIN_CHARS = { main: 5000, guide: 8000, news: 1600 }; // news は 2000字前後 → 下限 1600
const MIN_H2 = 3;
const MIN_INTERNAL_LINKS = 2;
const TITLE_SIMILARITY_LIMIT = 0.8; // 既存タイトルとの類似度上限
const MAX_WEBP_BYTES = 150 * 1024;
const LINK_CHECK_TIMEOUT_MS = 8000;

// 景表法などに配慮した NG ワード (単体で不合格)
const NG_WORDS = [
  "必ず採択", "必ず儲かる", "絶対に儲かる", "絶対に成功", "100%採択", "100%成功",
  "確実に稼げる", "誰でも簡単に儲かる", "リスクゼロ", "損しない", "最安値保証",
];
// 「No.1」「日本一」「業界一」は根拠 (出典・調査名) が同一段落に無ければ不合格
const CLAIM_WORDS = /No\.?1|日本一|業界一|世界一/;

// 統計・実績とみなす数値パターン (①の判定に使用)
const STAT_PATTERN = /\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(%|％|万円|億円|社|件|倍|名)/g;
// 会社の一次情報として許可する数値 (client-config.json の allowedFacts から取得)
const ALLOWED_FACTS = CLIENT.allowedFacts;

// ---------------- ヘルパー ----------------
function splitFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fmRaw: m[1], body: m[2] } : { fmRaw: "", body: md };
}
function getFm(fmRaw, key) {
  const m = fmRaw.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
  return m ? m[1] : "";
}
// 文字 bigram の Dice 係数によるタイトル類似度 (0〜1)
function similarity(a, b) {
  const bigrams = (s) => {
    const set = new Map();
    const t = s.replace(/\s/g, "");
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      set.set(g, (set.get(g) ?? 0) + 1);
    }
    return set;
  };
  const A = bigrams(a), B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  const sizeA = [...A.values()].reduce((s, n) => s + n, 0);
  const sizeB = [...B.values()].reduce((s, n) => s + n, 0);
  return (2 * overlap) / (sizeA + sizeB);
}

async function headOk(url) {
  // 政府系サイトはbot由来のHEAD/GETを403で弾くことがあるため、
  // ブラウザ相当のUAを付け、「サーバが応答した」なら生存とみなす。
  // リンク切れ扱いは 404/410 とネットワーク到達不能のみ。
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LINK_CHECK_TIMEOUT_MS);
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal, headers });
    if (!res.ok) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers });
    }
    clearTimeout(timer);
    return ![404, 410].includes(res.status);
  } catch {
    return false; // タイムアウト・DNS失敗などはリンク切れ扱い
  }
}

// ---------------- 各チェック ----------------
async function checkArticle(file, md, existingTitles, qualityLog) {
  const reasons = [];
  const { fmRaw, body } = splitFrontmatter(md);
  const title = getFm(fmRaw, "title");
  const slug = getFm(fmRaw, "slug") || file.replace(/\.md$/, "");
  const dateStr = getFm(fmRaw, "date");
  const thumbnail = getFm(fmRaw, "thumbnail");

  // 記事タイプ判定 (文字数下限の切り替え)
  const isGuide = title.includes("完全ガイド");
  const isNews = /ニュース|速報/.test(title) || getFm(fmRaw, "type") === "news";
  const minChars = isGuide ? MIN_CHARS.guide : isNews ? MIN_CHARS.news : MIN_CHARS.main;

  // ① 出典URL無しの統計数字 (段落単位)
  const paragraphs = body.split(/\n{2,}/);
  for (const p of paragraphs) {
    // HTMLタグ内の数値 (style="width:100%" 等) を統計と誤検知しないようタグを除去してから判定
    const pText = p.replace(/<[^>]+>/g, "");
    const stats = (pText.match(STAT_PATTERN) ?? []).filter(
      (s) => !ALLOWED_FACTS.some((a) => s.includes(a.replace(/[〜~]/g, "")) || pText.includes(a))
    );
    // 出典URLのほか、「※当社支援実績/支援事例」の帰属表記も一次情報の根拠として認める
    const hasUrl = /https?:\/\//.test(p) || /出典|参考|引用元|当社支援(実績|事例)|当社調べ/.test(p);
    if (stats.length > 0 && !hasUrl && !ALLOWED_FACTS.some((a) => p.includes(a))) {
      reasons.push(`①出典なしの統計数値: 「${stats.slice(0, 3).join(", ")}」を含む段落に出典URLがありません`);
      break; // 1件検出で十分 (理由の氾濫防止)
    }
  }

  // ② 既存記事タイトルとの部分一致 80% 以上
  for (const existing of existingTitles) {
    const sim = similarity(title, existing);
    if (sim >= TITLE_SIMILARITY_LIMIT) {
      reasons.push(`②タイトル重複: 既存「${existing}」と類似度 ${(sim * 100).toFixed(0)}%`);
      break;
    }
  }

  // ③ 文字数 / H2 数
  const bodyChars = body.replace(/\s/g, "").length;
  if (bodyChars < minChars) reasons.push(`③文字数不足: ${bodyChars}字 (規定 ${minChars}字以上)`);
  const h2Count = (body.match(/^##\s+[^#]/gm) ?? []).length;
  if (h2Count < MIN_H2) reasons.push(`③H2不足: ${h2Count}個 (規定 ${MIN_H2}個以上)`);

  // ④ 内部リンク数 / リンク切れ
  const internalLinks = body.match(/\]\((\/[^)]+)\)/g) ?? [];
  if (internalLinks.length < MIN_INTERNAL_LINKS) {
    reasons.push(`④内部リンク不足: ${internalLinks.length}本 (規定 ${MIN_INTERNAL_LINKS}本以上)`);
  }
  // ④-2 内部リンクの実在検証 (仮スラッグによる404リンクを公開前に排除)
  const SITE_DIR = join(ROOT, "..");
  const VALID_PREFIX = /^\/(service\/(hojokin|dev|aio|meo)\/|youkou\/|about\/|blog\/|downloads\/|privacy\/|unsubscribe\/|#|\?)/;
  for (const l of internalLinks) {
    const path = l.slice(2, -1).split("#")[0].split("?")[0];
    if (path === "/" || !path.startsWith("/")) continue;
    if (!VALID_PREFIX.test(path)) {
      reasons.push(`④内部リンク先が不正: ${path}`);
      continue;
    }
    const bm = path.match(/^\/blog\/([^/]+)\/?$/);
    if (bm && bm[1] !== "category") {
      const exists = existsSync(join(SITE_DIR, "blog", bm[1], "index.html")) ||
        ["posted", "publish-queue", "drafts"].some((sub) => existsSync(join(ROOT, "content", sub, `${bm[1]}.md`)));
      if (!exists) reasons.push(`④内部リンク先の記事が存在しない (404になる): ${path}`);
    }
  }
  const externalUrls = [...new Set(body.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [])].slice(0, 10); // 検証は10件まで
  for (const url of externalUrls) {
    if (!(await headOk(url))) {
      reasons.push(`④リンク切れ: ${url}`);
    }
  }

  // ⑪ SEOメタ検査 (タイトル長・メタディスクリプション)
  const seoTitle = getFm(fmRaw, "title");
  const seoDesc = getFm(fmRaw, "description");
  if (seoTitle.length < 15 || seoTitle.length > 45) {
    reasons.push(`⑪タイトル長が不適切: ${seoTitle.length}字 (15〜45字。検索結果での欠けを防ぐ)`);
  }
  if (seoDesc.length < 60 || seoDesc.length > 160) {
    reasons.push(`⑪メタディスクリプション長が不適切: ${seoDesc.length}字 (60〜160字)`);
  }

  // ⑤ NGワード (景表法)
  for (const w of NG_WORDS) {
    if (md.includes(w)) reasons.push(`⑤NGワード検出: 「${w}」`);
  }
  // 根拠なき No.1 系: 同一段落に出典が無ければ不合格
  for (const p of paragraphs) {
    if (CLAIM_WORDS.test(p) && !/https?:\/\/|調査|出典/.test(p)) {
      reasons.push(`⑤根拠なきNo.1系表現: 「${p.match(CLAIM_WORDS)[0]}」に出典・調査名がありません`);
      break;
    }
  }

  // ⑥ 未来日付・事実性エラー
  const today = new Date();
  if (dateStr) {
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime()) && d.getTime() > today.getTime() + 24 * 3600 * 1000) {
      reasons.push(`⑥未来日付: frontmatter date が ${dateStr}`);
    }
  }
  const years = body.match(/20\d{2}年/g) ?? [];
  for (const y of years) {
    if (parseInt(y) > today.getFullYear() + 1) {
      reasons.push(`⑥事実性エラーの疑い: 本文に ${y} (現在より2年以上未来) が出現`);
      break;
    }
  }

  // ⑦ 品質スコア突合 (quality-log.json の最新エントリ)
  const entry = [...(qualityLog.entries ?? [])].reverse().find((e) => e.file === basename(file));
  if (!entry) {
    reasons.push("⑦品質スコア記録なし: quality-loop を先に実行してください");
  } else if ((entry.finalScore ?? 0) < MIN_SCORE) {
    reasons.push(`⑦品質スコア不足: ${entry.finalScore}点 (規定 ${MIN_SCORE}点以上)`);
  }

  // ⑩ 呼称ルール (client-config.json の naming に従う)
  for (const f of CLIENT.naming.forbidden || []) {
    const re = new RegExp(`(?<!導入)${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (re.test(md)) {
      reasons.push(`⑩呼称違反: 「${f}」という略称が使われています (「${CLIENT.naming.preferred}」に統一)`);
    }
  }
  const officialCount = (md.match(new RegExp(CLIENT.naming.official.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  if (officialCount > 2) {
    reasons.push(`⑩呼称違反: 「${CLIENT.naming.official}」が${officialCount}回使われています (正式名称の初出注記1回のみ。以降は「${CLIENT.naming.preferred}」)`);
  }

  // ⑨ 文字化け検査 (Unicode置換文字 / CP932誤変換の典型連続パターン / 先頭BOM)
  if (/�/.test(md) || /[縺繧繝蟄蜿]{2}/.test(md) || md.charCodeAt(0) === 0xFEFF) {
    reasons.push("⑨文字化けの疑い: 置換文字・誤変換パターン・BOMのいずれかを検出しました");
  }

  // ⑧ 画像不備
  const thumbFsPath = thumbnail ? join(ROOT, "public", thumbnail.replace(/^\//, "")) : "";
  if (!thumbnail || !existsSync(thumbFsPath)) {
    reasons.push("⑧サムネイル欠落: frontmatter thumbnail が空、またはファイルが存在しません");
  } else if (statSync(thumbFsPath).size > MAX_WEBP_BYTES) {
    reasons.push(`⑧サムネイル容量超過: ${Math.round(statSync(thumbFsPath).size / 1024)}KB (150KB以下)`);
  }
  const imgTags = body.match(/<img\b[^>]*>/g) ?? [];
  for (const tag of imgTags) {
    if (!/\balt=/.test(tag)) reasons.push(`⑧alt欠落: ${tag.slice(0, 60)}...`);
    if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) reasons.push(`⑧width/height欠落: ${tag.slice(0, 60)}...`);
    const srcM = tag.match(/src="([^"]+)"/);
    if (srcM) {
      const fsPath = join(ROOT, "public", srcM[1].replace(/^\//, ""));
      if (existsSync(fsPath) && statSync(fsPath).size > MAX_WEBP_BYTES) {
        reasons.push(`⑧本文画像の容量超過: ${srcM[1]}`);
      }
    }
  }

  return { slug, title, reasons };
}

// ---------------- メイン処理 ----------------
async function main() {
  mkdirSync(QUEUE_DIR, { recursive: true });
  mkdirSync(REVIEW_DIR, { recursive: true });
  mkdirSync(dirname(GATE_LOG), { recursive: true });

  const drafts = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".md"));
  if (drafts.length === 0) {
    console.log("[safety-gate] 対象の下書きがありません。スキップします。");
    return;
  }

  // 既存記事タイトル (posted + publish-queue) を重複チェック対象にする
  const existingTitles = [];
  for (const dir of [POSTED_DIR, QUEUE_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const { fmRaw } = splitFrontmatter(readFileSync(join(dir, f), "utf8"));
      const t = getFm(fmRaw, "title");
      if (t) existingTitles.push(t);
    }
  }

  const qualityLog = existsSync(QUALITY_LOG) ? JSON.parse(readFileSync(QUALITY_LOG, "utf8")) : { entries: [] };
  const gateLog = existsSync(GATE_LOG) ? JSON.parse(readFileSync(GATE_LOG, "utf8")) : { entries: [] };

  for (const file of drafts) {
    const path = join(DRAFTS_DIR, file);
    const md = readFileSync(path, "utf8");
    console.log(`[safety-gate] 検査開始: ${file}`);
    const { slug, title, reasons } = await checkArticle(file, md, existingTitles, qualityLog);

    const passed = reasons.length === 0;
    if (passed) {
      renameSync(path, join(QUEUE_DIR, file));
      existingTitles.push(title); // 同バッチ内の重複も検出できるよう追加
      console.log(`[safety-gate] 合格: ${file} → publish-queue/`);
    } else {
      renameSync(path, join(REVIEW_DIR, file));
      console.warn(`[safety-gate] 不合格: ${file} → human-review/`);
      for (const r of reasons) console.warn(`  - ${r}`);
    }

    gateLog.entries.push({
      file, slug, title,
      date: new Date().toISOString(),
      passed,
      reasons,
    });
  }

  writeFileSync(GATE_LOG, JSON.stringify(gateLog, null, 2) + "\n", "utf8");
  console.log(`[safety-gate] 完了。判定ログ: ${GATE_LOG}`);
}

main().catch((err) => {
  console.error("[safety-gate] 致命的エラー:", err);
  process.exit(1);
});
