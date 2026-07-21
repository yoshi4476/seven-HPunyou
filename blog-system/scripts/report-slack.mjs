// =============================================================
// report-slack.mjs — Slack 日次レポート
//
// 役割: 当日のパイプライン実行結果を集計し Slack Webhook へ送信する。
//   - 公開本数 (safety-gate 合格数)
//   - 不合格本数とその理由
//   - 平均品質スコア / 平均改稿回数
//   - GSC 指標プレースホルダ (Search Console API 連携後に実装。README 参照)
//
// 前段のステップが失敗していても必ず送信されるよう、workflow 側は
// `if: always()` で呼び出し、本スクリプト自身もログ欠損時に落ちない。
// SLACK_WEBHOOK 未設定時はレポートを標準出力に表示してスキップ終了する。
//
// 実行: node scripts/report-slack.mjs
// =============================================================
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUALITY_LOG = join(ROOT, "logs", "quality-log.json");
const GATE_LOG = join(ROOT, "logs", "safety-gate-log.json");
const REPORT_TITLE = "セブンセンシズ ブログ自動更新 日次レポート";

// ---------------- 集計 ----------------
function loadJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback; // ログ破損時もレポート送信は止めない
  }
}

function isToday(iso) {
  return typeof iso === "string" && iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function buildReport() {
  const quality = loadJson(QUALITY_LOG, { entries: [] });
  const gate = loadJson(GATE_LOG, { entries: [] });

  const todayQuality = quality.entries.filter((e) => isToday(e.date));
  const todayGate = gate.entries.filter((e) => isToday(e.date));

  const published = todayGate.filter((e) => e.passed);
  const rejected = [
    ...todayGate.filter((e) => !e.passed).map((e) => ({ file: e.file, reasons: e.reasons })),
    ...todayQuality.filter((e) => !e.passed).map((e) => ({
      file: e.file,
      reasons: [`品質ループ未達 (最終 ${e.finalScore ?? "N/A"}点 / 改稿 ${e.revisions}回)`],
    })),
  ];

  const scores = todayQuality.map((e) => e.finalScore).filter((s) => typeof s === "number");
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "N/A";
  const revisions = todayQuality.map((e) => e.revisions).filter((n) => typeof n === "number");
  const avgRevisions = revisions.length
    ? (revisions.reduce((a, b) => a + b, 0) / revisions.length).toFixed(1)
    : "N/A";

  const lines = [
    `*${REPORT_TITLE}* (${new Date().toISOString().slice(0, 10)})`,
    "",
    `:white_check_mark: 公開本数: *${published.length}本*`,
    published.length ? published.map((e) => `  ・${e.title ?? e.file}`).join("\n") : "  (なし)",
    "",
    `:no_entry: 不合格本数: *${rejected.length}本*`,
    rejected.length
      ? rejected
          .map((e) => `  ・${e.file}\n${(e.reasons ?? []).map((r) => `      - ${r}`).join("\n")}`)
          .join("\n")
      : "  (なし)",
    "",
    `:bar_chart: 平均品質スコア: *${avgScore}点* / 平均改稿回数: *${avgRevisions}回*`,
    "",
    // ---- GSC 指標プレースホルダ ----
    // Search Console API 連携後に、表示回数/クリック/平均掲載順位/CTR を集計してここに差し込む。
    // 週次リライト運用 (11〜20位 or CTR低の記事抽出) も同APIを使う。README 参照。
    ":mag: GSC指標: _(Search Console API 連携後に表示: 表示回数 / クリック / 平均順位 / CTR)_",
  ];
  return lines.join("\n");
}

// ---------------- 送信 ----------------
async function main() {
  const text = buildReport();

  if (!process.env.SLACK_WEBHOOK) {
    console.warn("[report-slack] SLACK_WEBHOOK が未設定のため Slack 送信をスキップします。以下にレポートを表示します。");
    console.log("----------------------------------------");
    console.log(text);
    console.log("----------------------------------------");
    return;
  }

  try {
    const res = await fetch(process.env.SLACK_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    console.log("[report-slack] Slack へレポートを送信しました。");
  } catch (err) {
    // レポート送信の失敗でワークフロー全体を失敗扱いにしない (ログには残す)
    console.error(`[report-slack] Slack 送信失敗: ${err.message}`);
    console.log(text);
  }
}

main().catch((err) => {
  console.error("[report-slack] 致命的エラー:", err);
  process.exit(0); // レポートは常にベストエフォート
});
