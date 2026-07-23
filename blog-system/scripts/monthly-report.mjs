// =============================================================
// monthly-report.mjs — 月次コンサルティングレポートの自動生成
//
// 役割: 毎月1日に、サイトの実データを収集し、Claude がシニアWebコンサル
//   としての月次報告書 (Markdown) を作成して reports/ に保存する。
//   - 伸びたポイント / 直すべきポイント (優先度つき) / 翌月のプラン
//   - コンテンツ運用実績 (公開本数・品質スコア・不合格率)
//   - GA4 が接続されていればアクセス実データも統合 (未接続なら内部データのみで作成し、その旨を明記)
//
// GA4接続 (任意): 以下の2つを GitHub Secrets に設定すると自動で有効化
//   GA4_PROPERTY_ID        … GA4のプロパティID (数字)
//   GA4_CREDENTIALS_JSON   … サービスアカウントの鍵JSON全文
//     (GA4プロパティに「閲覧者」権限でサービスアカウントを追加しておくこと)
//
// 実行: node scripts/monthly-report.mjs
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const SITE_URL = (process.env.SITE_URL || "https://lp.7senses.co.jp").replace(/\/$/, "");
const REPORTS_DIR = join(REPO, "reports");

// ---------------- GA4 (Data API) ----------------
async function ga4Token(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(creds.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${claim}.${sig}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`GA4トークン取得失敗: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

async function ga4Report(token, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) throw new Error(`GA4 API: ${j.error.message}`);
  return j;
}

function rowsToObjects(report) {
  const dims = (report.dimensionHeaders || []).map((d) => d.name);
  const mets = (report.metricHeaders || []).map((m) => m.name);
  return (report.rows || []).map((r) => {
    const o = {};
    dims.forEach((d, i) => (o[d] = r.dimensionValues[i].value));
    mets.forEach((m, i) => (o[m] = Number(r.metricValues[i].value)));
    return o;
  });
}

async function collectGa4(range, prevRange) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const credsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!propertyId || !credsJson) return { connected: false, note: "GA4未接続 (GA4_PROPERTY_ID / GA4_CREDENTIALS_JSON 未設定)" };
  try {
    const creds = JSON.parse(credsJson);
    const token = await ga4Token(creds);
    const [summary, prevSummary, pages, sources, events] = await Promise.all([
      ga4Report(token, propertyId, { dateRanges: [range], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }, { name: "averageSessionDuration" }] }),
      ga4Report(token, propertyId, { dateRanges: [prevRange], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }, { name: "averageSessionDuration" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }, { name: "sessions" }], orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 20 }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 30 }),
    ]);
    return {
      connected: true,
      summary: rowsToObjects(summary)[0] || {},
      prevSummary: rowsToObjects(prevSummary)[0] || {},
      topPages: rowsToObjects(pages),
      channels: rowsToObjects(sources),
      events: rowsToObjects(events).filter((e) => /cta|form|lead|diagnosis|tel|download|audit/i.test(e.eventName)),
    };
  } catch (e) {
    return { connected: false, note: `GA4接続エラー: ${e.message}` };
  }
}

// ---------------- 内部データ収集 ----------------
function collectInternal(ym) {
  const data = { articles: { total: 0, byCategory: {}, publishedThisMonth: [] }, quality: null, queue: null, review: [] };
  const blogDir = join(REPO, "blog");
  if (existsSync(blogDir)) {
    for (const d of readdirSync(blogDir)) {
      const f = join(blogDir, d, "index.html");
      if (d === "category" || !existsSync(f)) continue;
      const html = readFileSync(f, "utf8");
      const cat = (html.match(/<span class="cat">(.*?)<\/span>/) || [])[1] || "不明";
      const date = (html.match(/"datePublished":\s*"(\d{4}-\d{2})-\d{2}"/) || [])[1] || "";
      const title = (html.match(/<title>(.*?)[||]/) || [])[1] || d;
      data.articles.total++;
      data.articles.byCategory[cat] = (data.articles.byCategory[cat] || 0) + 1;
      if (date === ym) data.articles.publishedThisMonth.push({ slug: d, title: title.trim() });
    }
  }
  try {
    const log = JSON.parse(readFileSync(join(ROOT, "logs", "quality-log.json"), "utf8"));
    const monthEntries = log.entries.filter((e) => (e.date || "").startsWith(ym));
    const scores = monthEntries.map((e) => e.finalScore).filter((s) => s != null);
    data.quality = {
      processed: monthEntries.length,
      passed: monthEntries.filter((e) => e.passed).length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      avgRevisions: monthEntries.length ? (monthEntries.reduce((a, e) => a + (e.revisions || 0), 0) / monthEntries.length).toFixed(1) : null,
    };
  } catch { /* ログ未生成月はスキップ */ }
  try {
    const q = JSON.parse(readFileSync(join(ROOT, "data", "keywords-queue.json"), "utf8"));
    data.queue = { pending: q.keywords.filter((k) => k.status === "pending").length, total: q.keywords.length };
  } catch { /* なし */ }
  const reviewDir = join(ROOT, "content", "human-review");
  if (existsSync(reviewDir)) data.review = readdirSync(reviewDir).filter((f) => f.endsWith(".md"));
  return data;
}

// ---------------- レポート生成 ----------------
const CONSULT_SYSTEM = `あなたはセブンセンシズ株式会社のWebサイト (${SITE_URL} — AI導入補助金申請サポート/システム開発/AIO/MEOのリード獲得サイト) を担当するシニアWebコンサルタントです。
月次報告書を、経営者が読んで「何をすべきか」まで分かる濃さで書きます。

# 報告書の構成 (Markdown。この順で)
1. エグゼクティブサマリー (3行で今月の総括)
2. 伸びたポイント (データの根拠つきで具体的に)
3. 直すべきポイント (優先度 高/中/低 を付け、「なぜ・どう直すか」まで)
4. コンテンツ運用実績 (公開本数・品質スコア・改善余地)
5. リード獲得の評価 (計測が無い場合は「計測整備が最優先」と明確に指摘)
6. 来月のアクションプラン (実行順の番号つき。担当が動ける粒度で)

# 心得
- データに無いことを推測で断定しない。データ不足はそれ自体を課題として指摘する
- 呼称は「AI導入補助金」で統一
- 割引・採択保証などコンプライアンスに反する施策は提案しない`;

async function main() {
  // 対象月 = 前月 (毎月1日実行のため)
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const range = { startDate: `${ym}-01`, endDate: `${ym}-${lastDay}` };
  const prev = new Date(target.getFullYear(), target.getMonth() - 1, 1);
  const prevYm = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const prevLast = new Date(prev.getFullYear(), prev.getMonth() + 1, 0).getDate();
  const prevRange = { startDate: `${prevYm}-01`, endDate: `${prevYm}-${prevLast}` };

  console.log(`[monthly-report] 対象月: ${ym}`);
  const ga4 = await collectGa4(range, prevRange);
  const internal = collectInternal(ym);
  const payload = { targetMonth: ym, ga4, internal, site: SITE_URL };

  let report;
  if (hasClaudeAuth()) {
    report = await callClaude(CONSULT_SYSTEM,
      `以下のデータから ${ym} の月次報告書を作成してください。Markdownのみを出力(コードフェンス禁止)。\n\n${JSON.stringify(payload, null, 2)}`,
      { maxTokens: 8000 });
    report = report.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
  } else {
    report = `# ${ym} 月次レポート (自動集計のみ)\n\nClaude未認証のためコンサル所見は省略。\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `${ym}.md`);
  writeFileSync(outPath, `<!-- 自動生成: monthly-report.mjs (${new Date().toISOString().slice(0, 10)}) -->\n\n${report}\n`, "utf8");
  console.log(`[monthly-report] 保存: reports/${ym}.md`);

  // Slack 通知 (サマリー)
  const hook = process.env.SLACK_WEBHOOK;
  if (hook) {
    const head = report.split("\n").slice(0, 15).join("\n");
    await fetch(hook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `📊 *${ym} 月次コンサルレポート* を生成しました\n\n${head}\n\n(全文: リポジトリ reports/${ym}.md)` }),
    }).catch((e) => console.warn("[monthly-report] Slack送信失敗:", e.message));
  }
}

main().catch((e) => { console.error("[monthly-report] 失敗:", e); process.exit(1); });
