// =============================================================
// embed-images.mjs — サムネイル生成・本文画像埋め込み (Sharp + 画像生成3段フォールバック)
//
// 役割:
//   1. content/drafts/ の各記事に対し、SVGテンプレートにタイトル文字を
//      差し込み → Sharp で 1200×630 の PNG / WebP に変換してサムネ生成。
//      ※SVGのままの出力は禁止 (OGP/SNSカードで正しく表示されないため)。
//   2. 本文への画像挿入。generate-articles が入れた
//      <!--IMG: (図解内容の説明)--> マーカーを解決する (マーカーが無い記事は
//      H2 2個ごとに自動挿入位置を決定 = 「H2の2〜3個ごとに1枚」の要件)。
//   3. 各挿入位置の画像は次の3段フォールバックで決定する:
//        ① AI生成SVG図解 …… Anthropic API (env CLAUDE_MODEL) にセクション内容を
//           渡し、概念図/手順図/比較図の完結なSVGを生成。構文検証
//           (script要素なし・外部参照なし・sharpでパース可能) を通過したものだけ
//           PNG→WebP 変換して採用。数値・比較・手順を含むセクションに適用。
//        ② 写真API (任意) …… env UNSPLASH_ACCESS_KEY があれば Unsplash
//           /search/photos で英語クエリ検索 → regular サイズをDL→WebP化。
//        ③ ローカル素材 …… LP同梱の assets/img/*.webp からカテゴリ別に選択。
//           それも無ければ SVGバナー (ローカル完結) で必ず画像を用意する。
//   4. WebP は 150KB 以下になるまで品質を下げて圧縮。width/height を記録。
//   5. <img> には width / height を明示 (CLS対策 + safety-gate ⑧ 対応)。
//      挿入形式は既存記事と同一の <figure> ラッパー。alt は日本語で自動生成。
//   6. 画像sitemap 用データを logs/image-sitemap-data.json に出力。
//
// ルール: 比較表・料金表は画像化せず HTML表 (Markdownの表) のままにする。
//         テキストとして残すことで AI検索・スクリーンリーダー・コピペ利用に
//         対応でき、画像化による情報ロスを防ぐため。
//
// 必要な環境変数 (すべて無くても CI は止めない。無い段はスキップして次へ):
//   ANTHROPIC_API_KEY / CLAUDE_MODEL … ①AI生成SVG に使用 (任意)
//   UNSPLASH_ACCESS_KEY              … ②写真API に使用 (任意)
//
// 実行: node scripts/embed-images.mjs
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS_DIR = join(ROOT, "content", "drafts");
const IMAGES_DIR = join(ROOT, "public", "images", "blog");
const LP_ASSETS_DIR = join(ROOT, "..", "assets", "img"); // LP本体の既存素材 (同一リポジトリ配置時)
const SITEMAP_DATA_PATH = join(ROOT, "logs", "image-sitemap-data.json");
const THUMB_W = 1200;
const THUMB_H = 630;
const MAX_WEBP_BYTES = 150 * 1024; // WebP は 150KB 以下
const H2_PER_IMAGE = 2;            // マーカー無し記事: H2 2個ごとに1枚 (2〜3個ごとの要件)
const MAX_SECTION_IMAGES = 5;      // 1記事あたりの本文画像上限 (API コスト暴走防止)
const SITE_URL = (process.env.SITE_URL || "https://lp.7senses.co.jp").replace(/\/$/, ""); // ※仮ドメイン・要確認

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const API_RETRIES = 2;
const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_MODEL);
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY || "";
const UNSPLASH_UTM = "utm_source=seven-senses-blog&utm_medium=referral"; // Unsplash API ガイドライン準拠の UTM

// サイト配色 (AI生成SVGにも同じパレットを指示する)
const BRAND = { bg: "#fdfcf9", navy: "#1d3461", gold: "#d9b36a" };
// サムネ用グラデーション配色 (従来デザイン維持)
const COLORS = { bg1: "#0f2540", bg2: "#1e4976", accent: "#f5a623", text: "#ffffff" };

// ③ローカル素材フォールバック: カテゴリ → assets/img/ の素材名 (.webp)
const LOCAL_ASSETS = {
  hojo: ["documents", "paperwork", "calculator", "handshake"],
  aio: ["analytics", "chip", "meeting-jp"],
  meo: ["osaka", "building", "meeting-jp"],
  dev: ["code", "chip", "analytics"],
};

// ②Unsplash 検索用: セクション内容 → 英語クエリの簡易辞書
// (API呼び出しを増やさず決定的にクエリを作るため、翻訳APIではなく辞書方式)
const EN_QUERY_HINTS = [
  [/補助金|助成金|申請|採択|公募/, "government subsidy application paperwork"],
  [/費用|料金|価格|コスト|予算/, "calculator business finance"],
  [/AI|人工知能|生成AI|ChatGPT/i, "artificial intelligence technology office"],
  [/システム|開発|プログラ|アプリ/, "software development programming"],
  [/MEO|Google\s*マップ|地図|店舗|来店/i, "local business storefront smartphone map"],
  [/検索|SEO|AIO|LLMO|上位表示/i, "search engine analytics laptop"],
  [/相談|面談|打ち合わせ|商談|ヒアリング/, "business meeting consultation japan"],
  [/大阪/, "osaka japan business district"],
];
const CATEGORY_QUERY = {
  hojo: "business documents japan office",
  aio: "search analytics computer",
  meo: "local shop map navigation",
  dev: "software engineer team working",
};

// ---------------- 共通ヘルパー ----------------
function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// タイトルを1行あたり max 文字で折り返す (日本語前提の単純分割で十分)
function wrapText(text, max = 16) {
  const lines = [];
  for (let i = 0; i < text.length; i += max) lines.push(text.slice(i, i + max));
  return lines.slice(0, 4); // 4行まで
}

function splitFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fmRaw: null, body: md };
  return { fmRaw: m[1], body: m[2] };
}

function getFmValue(fmRaw, key) {
  const m = fmRaw?.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
  return m ? m[1] : "";
}

function setFmValue(fmRaw, key, value) {
  const line = `${key}: "${value}"`;
  if (new RegExp(`^${key}:`, "m").test(fmRaw)) {
    return fmRaw.replace(new RegExp(`^${key}:.*$`, "m"), line);
  }
  return fmRaw + "\n" + line;
}

// ---------------- サムネイル用 SVG テンプレート (従来機能を維持) ----------------
function buildSvg(title, subtitle) {
  const lines = wrapText(title);
  const lineHeight = 72;
  const startY = THUMB_H / 2 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((l, i) => `<tspan x="600" y="${startY + i * lineHeight}">${escapeXml(l)}</tspan>`)
    .join("");
  return `<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${COLORS.bg1}"/>
      <stop offset="1" stop-color="${COLORS.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="0" y="${THUMB_H - 14}" width="100%" height="14" fill="${COLORS.accent}"/>
  <text text-anchor="middle" font-family="'Noto Sans CJK JP','Hiragino Sans',sans-serif"
        font-size="56" font-weight="bold" fill="${COLORS.text}">${tspans}</text>
  <text x="600" y="${THUMB_H - 50}" text-anchor="middle"
        font-family="'Noto Sans CJK JP','Hiragino Sans',sans-serif"
        font-size="28" fill="${COLORS.accent}">${escapeXml(subtitle)}</text>
</svg>`;
}

// ---------------- 画像変換ヘルパー ----------------
// 任意の入力 (SVG/PNG/JPEG/WebP バッファ) を WebP に変換。
// 150KB 以下になるまで品質を段階的に下げ、最終的な width/height を返す。
async function toWebp(input, outBase, { resizeWidth = 0, density = 0 } = {}) {
  const opts = density ? { density } : {};
  for (const quality of [80, 65, 50, 40, 30]) {
    let img = sharp(input, opts);
    if (resizeWidth) img = img.resize({ width: resizeWidth, withoutEnlargement: true });
    await img.webp({ quality }).toFile(`${outBase}.webp`);
    if (statSync(`${outBase}.webp`).size <= MAX_WEBP_BYTES) break;
  }
  const size = statSync(`${outBase}.webp`).size;
  if (size > MAX_WEBP_BYTES) {
    console.warn(`[embed-images] 警告: ${outBase}.webp が150KBを超過 (${Math.round(size / 1024)}KB)`);
  }
  const meta = await sharp(`${outBase}.webp`).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// サムネ専用: PNG (OGPフォールバック用) + WebP の両方を出力
async function renderThumbnail(svg, outBase) {
  const buf = Buffer.from(svg);
  await sharp(buf).png().toFile(`${outBase}.png`);
  return toWebp(buf, outBase);
}

// ---------------- ① AI生成SVG図解 ----------------
async function callClaude(systemPrompt, userPrompt) {
  let lastError;
  for (let attempt = 1; attempt <= API_RETRIES; attempt++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL, // モデルIDは env 経由。ハードコード禁止
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.stop_reason === "refusal") throw new Error("モデルが生成を拒否しました");
      return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    if ([429, 500, 529].includes(res.status) || res.status >= 500) {
      lastError = new Error(`Anthropic API エラー: ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  }
  throw lastError;
}

// 数値・比較・手順を含むセクションのみ図解化する (写真の方が適した内容を除外)
function isDiagramWorthy(text) {
  return /\d|手順|ステップ|フロー|流れ|比較|違い|メリット|デメリット|vs|万円|%|％|要件|条件/.test(text);
}

// 生成SVGの構文・安全性検証。問題があれば理由文字列を返す (null = 合格)。
// XSS/外部通信の芽 (script・外部URL・埋め込み要素) を機械的に排除し、
// 最終的なパース可能性は sharp (librsvg) の変換成否で担保する。
function validateSvg(svg) {
  if (!/^<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg)) return "svgタグで開始・終了していない";
  if (/<script/i.test(svg)) return "script要素を含む";
  if (/\bon\w+\s*=/i.test(svg)) return "イベントハンドラ属性を含む";
  if (/(xlink:href|\shref)\s*=\s*["'](?!#)/i.test(svg)) return "外部参照 (href) を含む";
  if (/url\(\s*["']?\s*https?:/i.test(svg)) return "外部URL参照を含む";
  if (/<(image|foreignObject|iframe|embed|object|use)\b/i.test(svg)) return "許可されていない要素を含む";
  return null;
}

const SVG_SYSTEM_PROMPT = `あなたはWebメディア用のSVG図解デザイナーです。記事セクションの内容を1枚で理解できる「概念図」「手順図(ステップフロー)」「比較図」のいずれか最適な形式のSVGを設計します。

# デザイン規則 (厳守)
- 背景: ${BRAND.bg} (白系) / メイン: ネイビー ${BRAND.navy} / アクセント: ゴールド ${BRAND.gold} のみ使用 (濃淡は可)
- 幅 1200 推奨 (width="1200" height="630" 前後、viewBox 併記)
- ラベル・見出しは日本語。font-family="'Noto Sans CJK JP','Hiragino Sans',sans-serif"
- 文字サイズは最小 24px 以上 (スマホ縮小表示でも読めること)
- 情報は詰め込みすぎない (要素 3〜6個)。角丸矩形・矢印・番号を活用
- 自己完結SVGのみ: script / 外部URL / image / use / foreignObject は禁止

# 出力形式
SVGコード「のみ」を出力する (前置き・コードフェンス・説明文は禁止)`;

async function tryAiSvg({ h2Text, sectionText, markerDesc, outBase }) {
  if (!AI_ENABLED) return null;
  if (!isDiagramWorthy(`${markerDesc} ${h2Text} ${sectionText}`)) return null;
  try {
    let svg = await callClaude(
      SVG_SYSTEM_PROMPT,
      `以下の記事セクションの内容を図解するSVGを作成してください。

# セクション見出し
${h2Text}

# 図解してほしい内容
${markerDesc || "(見出しとセクション本文から最適な図解を選ぶ)"}

# セクション本文 (抜粋)
${sectionText.slice(0, 1500)}`
    );
    // コードフェンスや前置きが混入した場合の除去
    const m = svg.match(/<svg[\s\S]*<\/svg>/);
    if (!m) throw new Error("SVGが出力に含まれない");
    svg = m[0].trim();
    const invalid = validateSvg(svg);
    if (invalid) throw new Error(`SVG検証NG: ${invalid}`);
    // PNG化を経由して WebP へ (パース不能なSVGはここで例外 → フォールバック)
    const png = await sharp(Buffer.from(svg), { density: 150 }).png().toBuffer();
    const { width, height } = await toWebp(png, outBase, { resizeWidth: 1200 });
    return { width, height, kind: "ai-svg" };
  } catch (err) {
    console.warn(`[embed-images] ①AI生成SVG失敗 (${h2Text}): ${err.message} → ②へフォールバック`);
    return null;
  }
}

// ---------------- ② 写真API (Unsplash・任意) ----------------
// Unsplash License 上クレジット表記は任意だが、API 利用ガイドラインでは
// 撮影者・Unsplash への UTM 付きリンク (attribution) と download エンドポイントの
// トリガーが求められるため、figcaption にクレジットを入れ download も叩く。
function buildUnsplashQuery(h2Text, sectionText, category) {
  const text = `${h2Text} ${sectionText}`;
  for (const [pattern, query] of EN_QUERY_HINTS) {
    if (pattern.test(text)) return query;
  }
  return CATEGORY_QUERY[category] || "business office japan";
}

async function tryUnsplash({ h2Text, sectionText, category, index, outBase }) {
  if (!UNSPLASH_KEY) return null;
  try {
    const query = buildUnsplashQuery(h2Text, sectionText, category);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
    );
    if (!res.ok) throw new Error(`Unsplash API エラー: ${res.status}`);
    const data = await res.json();
    if (!data.results?.length) throw new Error(`検索結果0件 (query: ${query})`);
    const photo = data.results[index % data.results.length]; // 同一記事内の重複を回避

    // ダウンロードイベント通知 (Unsplash API ガイドライン要件。失敗しても続行)
    if (photo.links?.download_location) {
      fetch(photo.links.download_location, {
        headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
      }).catch(() => {});
    }

    const imgRes = await fetch(photo.urls.regular);
    if (!imgRes.ok) throw new Error(`画像DL失敗: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const { width, height } = await toWebp(buf, outBase, { resizeWidth: 1200 });

    // クレジット (UTM 付きリンク) を figcaption として返す
    const credit =
      `Photo by <a href="${photo.user.links.html}?${UNSPLASH_UTM}" rel="nofollow noopener" target="_blank">${escapeXml(photo.user.name)}</a>` +
      ` on <a href="https://unsplash.com/?${UNSPLASH_UTM}" rel="nofollow noopener" target="_blank">Unsplash</a>`;
    return { width, height, kind: "unsplash", credit };
  } catch (err) {
    console.warn(`[embed-images] ②Unsplash失敗 (${h2Text}): ${err.message} → ③へフォールバック`);
    return null;
  }
}

// ---------------- ③ ローカル素材フォールバック ----------------
async function tryLocalAsset({ category, index, outBase }) {
  const names = LOCAL_ASSETS[category] || LOCAL_ASSETS.hojo;
  const name = names[index % names.length];
  const srcPath = join(LP_ASSETS_DIR, `${name}.webp`);
  if (!existsSync(srcPath)) {
    console.warn(`[embed-images] ③ローカル素材が見つかりません: ${srcPath} → SVGバナーへフォールバック`);
    return null;
  }
  const { width, height } = await toWebp(readFileSync(srcPath), outBase, { resizeWidth: 1200 });
  return { width, height, kind: "local-asset" };
}

// ---------------- 挿入画像の解決 (①→②→③→最終SVGバナー) ----------------
async function resolveSectionImage(ctx) {
  const { h2Text, title, outBase } = ctx;
  const result =
    (await tryAiSvg(ctx)) ??
    (await tryUnsplash(ctx)) ??
    (await tryLocalAsset(ctx)) ??
    // 最終手段: ローカル完結のSVGバナー (必ず成功するため CI は止まらない)
    { ...(await renderThumbnail(buildSvg(h2Text, title), outBase)), kind: "svg-banner" };
  console.log(`[embed-images]   画像決定 (${result.kind}): ${h2Text}`);
  return result;
}

// figure タグ生成 (既存記事と同一の挿入形式。alt は日本語で自動生成)
function buildFigure({ url, alt, width, height, credit }) {
  const img = `<img src="${url}" alt="${escapeXml(alt)}" width="${width}" height="${height}" loading="lazy" style="width:100%;height:auto;display:block">`;
  const caption = credit
    ? `<figcaption style="font-size:12px;color:#8a8f98;text-align:right;padding:6px 12px;background:${BRAND.bg}">${credit}</figcaption>`
    : "";
  return `<figure style="margin:28px 0;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(29,52,97,.1)">${img}${caption}</figure>`;
}

// ---------------- 本文解析 (H2・IMGマーカー・挿入位置の決定) ----------------
function analyzeBody(lines) {
  const h2s = [];       // { idx, text }
  const markers = [];   // { idx, desc }
  let inCode = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;
    const h2m = line.match(/^##\s+([^#].*)$/);
    if (h2m) h2s.push({ idx: i, text: h2m[1].trim() });
    const mm = line.match(/^\s*<!--\s*IMG:?\s*\(?([\s\S]*?)\)?\s*-->\s*$/);
    if (mm) markers.push({ idx: i, desc: mm[1].trim() });
  });

  // 挿入位置: マーカーがあればマーカー行を置換。無ければ H2 2個ごとに自動挿入 (従来互換)
  let points;
  if (markers.length > 0) {
    points = markers.map((m) => ({ line: m.idx, replace: true, desc: m.desc }));
  } else {
    points = h2s
      .filter((_, i) => i >= H2_PER_IMAGE && i % H2_PER_IMAGE === 0)
      .map((h2) => ({ line: h2.idx, replace: false, desc: "" }));
  }
  return { h2s, points: points.slice(0, MAX_SECTION_IMAGES) };
}

// 挿入位置が属するセクション (H2見出しと本文抜粋) を取得
function sectionContext(lines, h2s, point) {
  // マーカー: 直前のH2のセクション / 自動挿入: その行のH2 (直後に始まるセクション)
  let h2 = point.replace
    ? [...h2s].reverse().find((h) => h.idx < point.line)
    : h2s.find((h) => h.idx === point.line);
  h2 ??= h2s[0] ?? { idx: -1, text: "" };
  const next = h2s.find((h) => h.idx > h2.idx);
  const sectionText = lines
    .slice(h2.idx + 1, next ? next.idx : lines.length)
    .filter((l) => !/^\s*<!--/.test(l))
    .join("\n")
    .trim();
  return { h2Text: h2.text, sectionText };
}

// ---------------- メイン処理 ----------------
async function main() {
  mkdirSync(IMAGES_DIR, { recursive: true });
  mkdirSync(dirname(SITEMAP_DATA_PATH), { recursive: true });

  if (!AI_ENABLED) {
    console.log("[embed-images] ANTHROPIC_API_KEY / CLAUDE_MODEL が未設定のため ①AI生成SVG はスキップします (②③のフォールバックで続行)。");
  }
  if (!UNSPLASH_KEY) {
    console.log("[embed-images] UNSPLASH_ACCESS_KEY が未設定のため ②写真API はスキップします (③ローカル素材で続行)。");
  }

  const drafts = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".md"));
  if (drafts.length === 0) {
    console.log("[embed-images] 対象の下書きがありません。スキップします。");
    return;
  }

  const sitemapData = existsSync(SITEMAP_DATA_PATH)
    ? JSON.parse(readFileSync(SITEMAP_DATA_PATH, "utf8"))
    : { pages: [] };

  for (const file of drafts) {
    const path = join(DRAFTS_DIR, file);
    const md = readFileSync(path, "utf8");
    const { fmRaw, body } = splitFrontmatter(md);
    if (!fmRaw) {
      console.warn(`[embed-images] ${file}: frontmatter が無いためスキップ`);
      continue;
    }
    const title = getFmValue(fmRaw, "title");
    const slug = getFmValue(fmRaw, "slug") || file.replace(/\.md$/, "");
    const category = getFmValue(fmRaw, "category") || "hojo";
    const articleDir = join(IMAGES_DIR, slug);
    mkdirSync(articleDir, { recursive: true });

    // --- 1. サムネイル生成 (1200×630, SVGテンプレ→PNG/WebP。従来機能を維持) ---
    const thumbBase = join(articleDir, "thumbnail");
    await renderThumbnail(buildSvg(title, "セブンセンシズ株式会社"), thumbBase);
    const thumbUrl = `/images/blog/${slug}/thumbnail.webp`;
    console.log(`[embed-images] ${file}: サムネ生成 → ${thumbUrl}`);

    // --- 2. 本文への画像挿入 (IMGマーカー解決 / 無ければ H2 2個ごと) ---
    const pageImages = [{ loc: `${SITE_URL}${thumbUrl}`, title, alt: `${title}のアイキャッチ画像` }];
    const lines = body.split("\n");
    const { h2s, points } = analyzeBody(lines);
    const pointByLine = new Map(points.map((p) => [p.line, p]));

    const out = [];
    let imgIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const pt = pointByLine.get(i);
      if (!pt) {
        out.push(lines[i]);
        continue;
      }
      const { h2Text, sectionText } = sectionContext(lines, h2s, pt);
      const imgName = `${slug}-section-${imgIndex + 1}`; // 内容を表す英語スラッグ + 連番
      const outBase = join(articleDir, imgName);
      const resolved = await resolveSectionImage({
        h2Text, sectionText, markerDesc: pt.desc, category, title,
        index: imgIndex, outBase,
      });
      const imgUrl = `/images/blog/${slug}/${imgName}.webp`;
      // alt はマーカーの説明 or セクション見出しから日本語で自動生成
      // (説明が「〜図」「〜図解」「〜イメージ」で終わる場合は語尾を重ねない)
      const desc = pt.desc.replace(/[。.]$/, "");
      const alt = desc
        ? (/(図|図解|イメージ)$/.test(desc) ? desc : `${desc}の図解`)
        : `${h2Text}の解説イメージ`;
      const figure = buildFigure({ url: imgUrl, alt, width: resolved.width, height: resolved.height, credit: resolved.credit });

      if (pt.replace) {
        out.push(figure, "");           // マーカー行を figure に置換
      } else {
        out.push(figure, "", lines[i]); // H2 の直前に挿入
      }
      pageImages.push({ loc: `${SITE_URL}${imgUrl}`, title: h2Text, alt });
      imgIndex++;
    }

    // --- 3. frontmatter の thumbnail 更新 + 保存 ---
    const newFm = setFmValue(fmRaw, "thumbnail", thumbUrl);
    writeFileSync(path, `---\n${newFm}\n---\n${out.join("\n")}`, "utf8");
    console.log(`[embed-images] ${file}: 本文画像 ${imgIndex}枚を挿入`);

    // --- 4. 画像sitemap 用データを蓄積 ---
    sitemapData.pages = sitemapData.pages.filter((p) => p.slug !== slug);
    sitemapData.pages.push({ slug, loc: `${SITE_URL}/blog/${slug}/`, images: pageImages });
  }

  writeFileSync(SITEMAP_DATA_PATH, JSON.stringify(sitemapData, null, 2) + "\n", "utf8");
  console.log(`[embed-images] 完了。画像sitemapデータ: ${SITEMAP_DATA_PATH}`);
}

main().catch((err) => {
  console.error("[embed-images] 致命的エラー:", err);
  process.exit(1);
});
