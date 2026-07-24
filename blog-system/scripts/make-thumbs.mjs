// =============================================================
// make-thumbs.mjs — 既存記事のサムネイル一括生成 (一覧・OGPの統一)
// embed-images.mjs と同じデザイン (ネイビーグラデ+ゴールドライン) で、
// まだ専用サムネが無い公開記事に thumbnail.png / .webp を生成する。
// 実行: node scripts/make-thumbs.mjs  (要: sharp / 日本語フォント環境)
// =============================================================
import { readFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const BLOG = join(REPO, "blog");
const OUT_ROOT = join(REPO, "images", "blog");
const W = 1200, H = 630;
const COLORS = { bg1: "#132445", bg2: "#24427c", text: "#ffffff", accent: "#d9b36a" };

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function wrap(text, max = 16) {
  const lines = [];
  for (let i = 0; i < text.length; i += max) lines.push(text.slice(i, i + max));
  return lines.slice(0, 4);
}
function buildSvg(title, subtitle) {
  const lines = wrap(title);
  const lh = 72;
  const startY = H / 2 - ((lines.length - 1) * lh) / 2;
  const tspans = lines.map((l, i) => `<tspan x="600" y="${startY + i * lh}">${esc(l)}</tspan>`).join("");
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${COLORS.bg1}"/><stop offset="1" stop-color="${COLORS.bg2}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="0" y="${H - 14}" width="100%" height="14" fill="${COLORS.accent}"/>
  <text text-anchor="middle" font-family="'Noto Sans CJK JP','Yu Gothic','Hiragino Sans',sans-serif"
        font-size="56" font-weight="bold" fill="${COLORS.text}">${tspans}</text>
  <text x="600" y="${H - 50}" text-anchor="middle"
        font-family="'Noto Sans CJK JP','Yu Gothic','Hiragino Sans',sans-serif"
        font-size="28" fill="${COLORS.accent}">${esc(subtitle)}</text>
</svg>`;
}

async function main() {
  let made = 0, skipped = 0;
  for (const d of readdirSync(BLOG)) {
    const page = join(BLOG, d, "index.html");
    if (d === "category" || !existsSync(page)) continue;
    const outDir = join(OUT_ROOT, d);
    if (existsSync(join(outDir, "thumbnail.webp"))) { skipped++; continue; }
    const m = readFileSync(page, "utf8").match(/<title>(.*?)[||]/);
    if (!m) continue;
    const title = m[1].trim();
    mkdirSync(outDir, { recursive: true });
    const png = await sharp(Buffer.from(buildSvg(title, "セブンセンシズ株式会社")), { density: 150 })
      .resize(W, H).png().toBuffer();
    await sharp(png).toFile(join(outDir, "thumbnail.png"));
    await sharp(png).webp({ quality: 82 }).toFile(join(outDir, "thumbnail.webp"));
    console.log(`生成: ${d}`);
    made++;
  }
  console.log(`完了: 生成${made}本 / 既存スキップ${skipped}本`);
}
main().catch((e) => { console.error(e); process.exit(1); });
