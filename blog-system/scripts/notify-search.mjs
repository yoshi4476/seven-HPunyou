// =============================================================
// notify-search.mjs — sitemap 生成 + 検索エンジン通知
//
// 役割:
//   1. sitemap.xml を生成する。
//      ※重要: lastmod を変更するのは「新規・内容更新のあったページのみ」。
//        全ページの lastmod を毎回書き換えるのは禁止。
//        理由: 実際には更新していないページの lastmod を動かすと、
//        検索エンジンが「このサイトの lastmod は信用できない」と学習し、
//        本当に更新したページの再クロール優先度まで下がるため。
//        (Google は不正確な lastmod を無視すると公言している)
//   2. 画像sitemap (image-sitemap.xml) を生成する (embed-images の出力を利用)。
//   3. IndexNow へ新規URLを送信 (Bing/Yandex等。INDEXNOW_KEY 必要)。
//   4. Google へ sitemap ping を送信。
//      ※注: Google の sitemap ping エンドポイントは 2023年に廃止告知済み。
//        恒久対応は Search Console API (sitemaps.submit) への移行を推奨 (README 参照)。
//   5. 通知済みの記事を content/publish-queue/ → content/posted/ へ移動。
//
// 実行: node scripts/notify-search.mjs
// 環境変数: SITE_URL (未設定時は仮ドメイン) / INDEXNOW_KEY (任意)
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { CLIENT } from "./client-config.mjs";
import { createHash as cryptoHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_DIR = join(ROOT, "content", "publish-queue");
const POSTED_DIR = join(ROOT, "content", "posted");
const PUBLIC_DIR = join(ROOT, "public");
const SITEMAP_PATH = join(PUBLIC_DIR, "sitemap.xml");
const IMAGE_SITEMAP_PATH = join(PUBLIC_DIR, "image-sitemap.xml");
const IMAGE_DATA_PATH = join(ROOT, "logs", "image-sitemap-data.json");
const STATE_PATH = join(ROOT, "logs", "sitemap-state.json"); // slug → {hash, lastmod} 差分検出用
const SITE_URL = (process.env.SITE_URL || CLIENT.siteUrl).replace(/\/$/, "");
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

// ---------------- ヘルパー ----------------
function md5(s) {
  return cryptoHash("md5").update(s).digest("hex");
}
function getFm(md, key) {
  const m = md.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
  return m ? m[1] : "";
}
function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------- メイン処理 ----------------
async function main() {
  mkdirSync(POSTED_DIR, { recursive: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });
  mkdirSync(dirname(STATE_PATH), { recursive: true });

  // 状態ファイル: 各記事の本文ハッシュと lastmod を保持 (差分検出のため)
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { pages: {} };
  const today = new Date().toISOString().slice(0, 10);
  const newUrls = []; // IndexNow 送信対象 (今回 新規/更新のURLのみ)

  // --- publish-queue の新規記事を登録し posted へ移動 ---
  const queued = existsSync(QUEUE_DIR) ? readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".md")) : [];
  for (const file of queued) {
    const path = join(QUEUE_DIR, file);
    const md = readFileSync(path, "utf8");
    const slug = getFm(md, "slug") || file.replace(/\.md$/, "");
    const url = `${SITE_URL}/blog/${slug}/`;
    const hash = md5(md);

    // 新規 or 内容変更があった場合のみ lastmod を更新する (全件書き換え禁止)
    if (!state.pages[slug] || state.pages[slug].hash !== hash) {
      state.pages[slug] = { hash, lastmod: today, url };
      newUrls.push(url);
    }
    renameSync(path, join(POSTED_DIR, file));
    console.log(`[notify-search] 公開登録: ${url}`);
  }

  // --- posted 内の既存記事の内容変更 (リライト) も検出 ---
  for (const file of readdirSync(POSTED_DIR).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(join(POSTED_DIR, file), "utf8");
    const slug = getFm(md, "slug") || file.replace(/\.md$/, "");
    const url = `${SITE_URL}/blog/${slug}/`;
    const hash = md5(md);
    if (!state.pages[slug]) {
      state.pages[slug] = { hash, lastmod: today, url };
      newUrls.push(url);
    } else if (state.pages[slug].hash !== hash) {
      state.pages[slug] = { hash, lastmod: today, url }; // リライト検出時のみ lastmod 更新
      if (!newUrls.includes(url)) newUrls.push(url);
    }
    // 変更がなければ lastmod は据え置き (前回の値をそのまま出力)
  }

  // --- sitemap.xml 生成 ---
  const staticPages = [
    { url: `${SITE_URL}/`, lastmod: state.lpLastmod ?? today }, // LP本体。LP更新時に state.lpLastmod を手動更新
    { url: `${SITE_URL}/blog/`, lastmod: today },               // 記事一覧は記事追加のたびに実際に更新される
  ];
  const urlEntries = [
    ...staticPages,
    ...Object.values(state.pages).map((p) => ({ url: p.url, lastmod: p.lastmod })),
  ]
    .map(
      (p) => `  <url>\n    <loc>${xmlEscape(p.url)}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`
    )
    .join("\n");
  writeFileSync(
    SITEMAP_PATH,
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`,
    "utf8"
  );
  console.log(`[notify-search] sitemap.xml 生成 (${Object.keys(state.pages).length}記事)`);

  // --- 画像sitemap 生成 (embed-images.mjs の出力データを利用) ---
  if (existsSync(IMAGE_DATA_PATH)) {
    const imageData = JSON.parse(readFileSync(IMAGE_DATA_PATH, "utf8"));
    const imgEntries = (imageData.pages ?? [])
      .map((p) => {
        const imgs = p.images
          .map(
            (img) =>
              `    <image:image>\n      <image:loc>${xmlEscape(img.loc)}</image:loc>\n      <image:title>${xmlEscape(img.title ?? "")}</image:title>\n    </image:image>`
          )
          .join("\n");
        return `  <url>\n    <loc>${xmlEscape(p.loc)}</loc>\n${imgs}\n  </url>`;
      })
      .join("\n");
    writeFileSync(
      IMAGE_SITEMAP_PATH,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${imgEntries}\n</urlset>\n`,
      "utf8"
    );
    console.log("[notify-search] image-sitemap.xml 生成");
  }

  // --- IndexNow 送信 (新規・更新URLのみ) ---
  if (newUrls.length === 0) {
    console.log("[notify-search] 新規・更新URLなし。検索エンジン通知をスキップします。");
  } else if (!process.env.INDEXNOW_KEY) {
    console.warn("[notify-search] INDEXNOW_KEY が未設定のため IndexNow 送信をスキップします (README 参照)。");
  } else {
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host: new URL(SITE_URL).host,
          key: process.env.INDEXNOW_KEY,
          // keyLocation: サイト直下に {key}.txt を配置しておくこと (README 参照)
          keyLocation: `${SITE_URL}/${process.env.INDEXNOW_KEY}.txt`,
          urlList: newUrls,
        }),
      });
      console.log(`[notify-search] IndexNow 送信: ${newUrls.length}件 (HTTP ${res.status})`);
    } catch (err) {
      console.warn(`[notify-search] IndexNow 送信失敗 (処理は継続): ${err.message}`);
    }
  }

  // --- Google sitemap ping (廃止告知済み。恒久対応は Search Console API へ移行) ---
  if (newUrls.length > 0) {
    try {
      const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(`${SITE_URL}/sitemap.xml`)}`;
      const res = await fetch(pingUrl);
      console.log(`[notify-search] GSC ping 送信 (HTTP ${res.status}) ※廃止済みエンドポイントのためベストエフォート`);
    } catch (err) {
      console.warn(`[notify-search] GSC ping 失敗 (処理は継続): ${err.message}`);
    }
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  console.log("[notify-search] 完了。");
}

main().catch((err) => {
  console.error("[notify-search] 致命的エラー:", err);
  process.exit(1);
});
