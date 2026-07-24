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
    // GA4 と Search Console の両方を1つのトークンで読む
    scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly",
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

async function collectGa4(range, prevRange, sixMonthRange) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const credsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!propertyId || !credsJson) return { connected: false, note: "GA4未接続 (GA4_PROPERTY_ID / GA4_CREDENTIALS_JSON 未設定)" };
  try {
    const creds = JSON.parse(credsJson);
    const token = await ga4Token(creds);
    // 6ヶ月トレンド (トラフィック / リードイベント)
    const [trendTraffic, trendLeads] = await Promise.all([
      ga4Report(token, propertyId, { dateRanges: [sixMonthRange], dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }], orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }),
      ga4Report(token, propertyId, { dateRanges: [sixMonthRange], dimensions: [{ name: "yearMonth" }], metrics: [{ name: "eventCount" }], dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "BEGINS_WITH", value: "lead_" } } }, orderBys: [{ dimension: { dimensionName: "yearMonth" } }] }),
    ]);
    const [devices, newVsRet, landings, weekdays] = await Promise.all([
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "deviceCategory" }], metrics: [{ name: "sessions" }, { name: "conversions" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "newVsReturning" }], metrics: [{ name: "sessions" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }, { name: "conversions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 15 }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "dayOfWeekName" }], metrics: [{ name: "sessions" }] }),
    ]);
    const [summary, prevSummary, pages, sources, events, refs] = await Promise.all([
      ga4Report(token, propertyId, { dateRanges: [range], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }, { name: "averageSessionDuration" }] }),
      ga4Report(token, propertyId, { dateRanges: [prevRange], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "screenPageViews" }, { name: "averageSessionDuration" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }, { name: "sessions" }], orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 25 }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }] }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 250 }),
      ga4Report(token, propertyId, { dateRanges: [range], dimensions: [{ name: "sessionSource" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 50 }),
    ]);
    const allEvents = rowsToObjects(events);
    // AI検索経由の流入 (AIO成果の直接指標)
    const AI_SOURCES = /chatgpt|openai|perplexity|copilot|gemini|bard|claude|you\.com|phind|poe\.com|felo|genspark/i;
    const refRows = rowsToObjects(refs);
    return {
      connected: true,
      summary: rowsToObjects(summary)[0] || {},
      prevSummary: rowsToObjects(prevSummary)[0] || {},
      topPages: rowsToObjects(pages),
      channels: rowsToObjects(sources),
      // リード・CV系イベント
      cvEvents: allEvents.filter((e) => /^(cta_|lead_|form_submit|diagnosis|site_audit|download)/.test(e.eventName)),
      // セクション到達イベント (LPヒートマップ分析用)
      sectionViews: allEvents.filter((e) => e.eventName.startsWith("section_view_")),
      aiReferrals: refRows.filter((r) => AI_SOURCES.test(r.sessionSource)),
      topSources: refRows.slice(0, 15),
      trend6m: { traffic: rowsToObjects(trendTraffic), leads: rowsToObjects(trendLeads) },
      devices: rowsToObjects(devices),
      newVsReturning: rowsToObjects(newVsRet),
      landingPages: rowsToObjects(landings),
      weekdays: rowsToObjects(weekdays),
    };
  } catch (e) {
    return { connected: false, note: `GA4接続エラー: ${e.message}` };
  }
}

// ---------------- Search Console (検索クエリ・CTR・掲載順位) ----------------
// 同じサービスアカウントを GSC プロパティに「閲覧者」で追加すれば自動で有効化。
// プロパティは env GSC_SITE_URL (未設定時は SITE_URL/) を使用。
async function collectGsc(range, prevRange) {
  const credsJson = process.env.GA4_CREDENTIALS_JSON;
  if (!credsJson) return { connected: false, note: "GSC未接続 (GA4_CREDENTIALS_JSON 未設定)" };
  const siteUrl = process.env.GSC_SITE_URL || `${SITE_URL}/`;
  try {
    const token = await ga4Token(JSON.parse(credsJson));
    const q = async (body) => {
      const res = await fetch(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (j.error) throw new Error(`GSC API: ${j.error.message}`);
      return j.rows || [];
    };
    const base = { startDate: range.startDate, endDate: range.endDate };
    const [totals, prevTotals, topQueries, topPages] = await Promise.all([
      q({ ...base }),
      q({ startDate: prevRange.startDate, endDate: prevRange.endDate }),
      q({ ...base, dimensions: ["query"], rowLimit: 20 }),
      q({ ...base, dimensions: ["page"], rowLimit: 20 }),
    ]);
    return {
      connected: true,
      siteUrl,
      totals: totals[0] || {},
      prevTotals: prevTotals[0] || {},
      topQueries: topQueries.map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: +(r.ctr * 100).toFixed(1), position: +r.position.toFixed(1) })),
      topPages: topPages.map((r) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: +(r.ctr * 100).toFixed(1), position: +r.position.toFixed(1) })),
    };
  } catch (e) {
    return { connected: false, note: `GSC接続エラー: ${e.message}` };
  }
}

// ---------------- LPセクション文言インベントリ ----------------
// 到達率データと突き合わせて「どのエリアのどの文言を変えるか」を提案させるため、
// LPの各セクションの見出しを順番つきで収集する
function collectSectionCopy() {
  try {
    const html = readFileSync(join(REPO, "index.html"), "utf8");
    const out = [];
    const re = /<section[^>]*id="([^"]+)"[\s\S]*?(?=<section[^>]*id="|<footer)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const block = m[0];
      const h = (block.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/) || [])[1] || "";
      const cta = (block.match(/data-cta="([^"]+)"/) || [])[1] || "";
      out.push({
        order: out.length + 1,
        sectionId: m[1],
        headline: h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60),
        primaryCta: cta,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------- AIO自動監査 (自サイトの実装状態を機械チェック) ----------------
async function aioAudit() {
  const audit = {};
  const get = async (path) => {
    try {
      const res = await fetch(`${SITE_URL}${path}`, { redirect: "follow" });
      return { status: res.status, text: res.ok ? await res.text() : "" };
    } catch (e) {
      return { status: 0, text: "", error: e.message };
    }
  };
  const [llms, robots, home, sitemap] = await Promise.all([get("/llms.txt"), get("/robots.txt"), get("/"), get("/sitemap.xml")]);
  audit.llmsTxt = llms.status === 200 ? "実装済み" : `未検出 (${llms.status})`;
  audit.robotsAiBots = robots.status === 200
    ? (/GPTBot|CCBot|anthropic|PerplexityBot/i.test(robots.text) && /disallow\s*:\s*\//i.test(robots.text) ? "AIボットの一部をブロックしている可能性 (要確認)" : "AIボットのクロールを許可")
    : "robots.txt未検出";
  audit.jsonLdBlocks = (home.text.match(/application\/ld\+json/g) || []).length;
  audit.jsonLdTypes = [...new Set([...home.text.matchAll(/"@type":\s*"([A-Za-z]+)"/g)].map((x) => x[1]))].slice(0, 12);
  const lastmods = [...sitemap.text.matchAll(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].map((x) => x[1]).sort();
  audit.sitemapUrls = (sitemap.text.match(/<loc>/g) || []).length;
  audit.sitemapNewest = lastmods[lastmods.length - 1] || "不明";
  return audit;
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
    const pending = q.keywords.filter((k) => k.status === "pending");
    data.queue = {
      pending: pending.length,
      total: q.keywords.length,
      // キーワード戦略章の材料 (優先度順の待機リスト上位20)
      upcoming: pending
        .sort((a, b) => ({ S: 0, A: 1, B: 2 }[a.priority] ?? 3) - ({ S: 0, A: 1, B: 2 }[b.priority] ?? 3))
        .slice(0, 20)
        .map((k) => ({ keyword: k.keyword, priority: k.priority, category: k.category })),
    };
  } catch { /* なし */ }
  const reviewDir = join(ROOT, "content", "human-review");
  if (existsSync(reviewDir)) data.review = readdirSync(reviewDir).filter((f) => f.endsWith(".md"));
  return data;
}

// ---------------- レポート生成 ----------------
const CONSULT_SYSTEM = `あなたは世界トップクラスのグロースコンサルタントとして、セブンセンシズ株式会社のWebサイト (${SITE_URL} — AI導入補助金申請サポート/システム開発/AIO/MEOのリード獲得サイト) の月次報告書を書きます。
読者は経営者。数字の羅列ではなく「どこで何が起き、どこを・どの文言を・なぜ直すか」まで断定的に書きます。

# 報告書の構成 (Markdown。この順・この見出しで。全14章を必ず書く)
1. エグゼクティブサマリー — 3行総括+今月の最重要判断1つ
2. KPIダッシュボード総括 — 主要KPI (セッション/ユーザー/PV/滞在時間/リード総数と内訳[問い合わせ・診断・DL・電話]/転換率) を表に。**列は必ず「指標|当月|前月|前月比|6ヶ月前|6ヶ月前比」の6列**にする
3. 6ヶ月トレンド — 月×セッション・リードの推移表。数値の横に █ を比例本数で並べたバーを付けて可視化 (例: 320 ████████)。最下行に月平均成長率を書く
4. 流入分析 — (a)チャネル別 (b)参照元Top (c)デバイス別 (d)新規/リピーター (e)曜日別、の5つの表。それぞれ構成比バーつき。増減の要因を各表の直後に1〜2文で断定する
5. 検索パフォーマンス (GSC) — クエリ別Top20の表 (表示回数/クリック/CTR/掲載順位)。続けて**伸びしろリスト2種**: ①表示回数が多いのにCTRが低いクエリ (タイトル改善候補) ②掲載順位11〜20位のクエリ (あと一歩で1ページ目)
6. ランディングページ・記事別パフォーマンス — 入口ページ別のセッション→CVの表+伸びた記事/落ちた記事の特定
7. LPエリア分析 (ヒートマップ) — section_view_* とセクション順序から「到達率ファネル表」(上から順に何%が到達+バー+直前からの落差)。最大の離脱点を断定する。CTA別クリック数の表も添える
8. 文言・クリエイティブ改善提案 — 「対象エリア/現行の文言/改善案の文言/根拠/期待効果」の対比表で最低3件 (sectionCopyの実際の見出しを引用)。GSCで「表示多い×CTR低い」の記事タイトル書き換え案も含める
9. AIO分析 — AI検索経由の流入 (参照元別)、実装監査 (llms.txt/構造化データ/robots/sitemap鮮度)、被引用を増やす次の一手 (具体タイトル案まで)
10. キーワード戦略 — GSCの伸びしろ・未カバーの検索意図・キュー残 (internal.queue.upcoming) を突き合わせ、**来月狙うべき推奨キーワード10本**を「キーワード/狙う理由/記事タイプ/優先度」の表で提案する。キューの優先順に反映すべき変更も指示する
11. コンテンツ運用実績 — 公開本数・平均品質スコア (総合/SEO/AIOの三軸)・不合格と理由・カテゴリバランス・リライト実施状況
12. 運営者向け改善KPI指標 — 「毎週見るべき指標/現在値/目標値/どこで見るか/悪化時のアクション」の5列表。運営者がこの表だけで自走できる粒度にする
13. 優先施策マトリクス — 全提案施策を「インパクト×工数」で高効果×低工数から順に番号付け
14. 来月の数値目標とアクションプラン — 目標KPI (根拠つき) と実行順タスクリスト (担当・所要目安つき)

# 可視化ルール
- すべての主要数値に前月比を付ける。改善=▲、悪化=▼、横ばい=→
- 推移・比率は必ず表+バー (█ の繰り返し) で表現し、文章だけで説明しない
- 表は5列以内。1つの表に詰め込みすぎない

# 心得
- データに無いことを推測で断定しない。データ不足 (未計測・接続前) はそれ自体を最優先課題として指摘する
- 呼称は「AI導入補助金」で統一
- 割引・採択保証などコンプライアンスに反する施策は提案しない
- 業界平均等に言及する場合は「一般的な目安」と明示する`;

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

  // 6ヶ月トレンドの起点 (対象月を含む過去6ヶ月)
  const six = new Date(target.getFullYear(), target.getMonth() - 5, 1);
  const sixMonthRange = { startDate: `${six.getFullYear()}-${String(six.getMonth() + 1).padStart(2, "0")}-01`, endDate: range.endDate };

  console.log(`[monthly-report] 対象月: ${ym}`);
  const [ga4, gsc, aio] = await Promise.all([
    collectGa4(range, prevRange, sixMonthRange),
    collectGsc(range, prevRange),
    aioAudit(),
  ]);
  const internal = collectInternal(ym);
  const sectionCopy = collectSectionCopy();
  const payload = { targetMonth: ym, ga4, gsc, aio, internal, sectionCopy, site: SITE_URL };

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
