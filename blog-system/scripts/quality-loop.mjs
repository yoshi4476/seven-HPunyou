// =============================================================
// quality-loop.mjs — 品質採点・改稿ループ
//
// 役割:
//   1. content/drafts/ の各記事を「執筆AIとは別セッション」で採点する。
//      ※重要: 採点AIには記事本文のみを渡し、執筆時のプロンプトや事情は
//        一切見せない。自己弁護・自己採点の甘さを構造的に排除するため。
//   2. 100点ルーブリックで採点。MIN_SCORE (既定90) 未満なら減点理由を
//      執筆AIに差し戻して改稿 → 再採点。最大 MAX_REVISIONS (既定5) 回。
//   3. 上限に達しても未達なら content/human-review/ へ移動 (人間判断へ)。
//   4. 点数推移を logs/quality-log.json に記録する。
//
// 実行: node scripts/quality-loop.mjs
// 環境変数: CLAUDE_CODE_OAUTH_TOKEN (サブスク認証。CLAUDE_MODEL は任意)
//           または ANTHROPIC_API_KEY + CLAUDE_MODEL (従量課金)
//           どちらも未設定なら明確なメッセージを出してスキップ (exit 0)
//           MIN_SCORE (既定90) / MAX_REVISIONS (既定5)
// =============================================================
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hasClaudeAuth, callClaude } from "./claude-client.mjs";

// ---------------- 設定定数 ----------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFTS_DIR = join(ROOT, "content", "drafts");
const REVIEW_DIR = join(ROOT, "content", "human-review");
const LOG_PATH = join(ROOT, "logs", "quality-log.json");
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 90);
const MAX_REVISIONS = Number(process.env.MAX_REVISIONS ?? 5);

// 100点ルーブリック (配点は safety-gate や README と揃えること)
const RUBRIC = [
  { key: "search_intent", label: "検索意図の網羅", max: 20 },
  { key: "aio_fit", label: "AIO適合 (断言文・FAQ・引用されやすさ)", max: 15 },
  { key: "eeat", label: "E-E-A-T・一次情報 (出典・実体験・専門性)", max: 15 },
  { key: "seo_tech", label: "SEO技術 (タイトル・見出し構造・内部リンク)", max: 15 },
  { key: "readability", label: "可読性と緩急 (1文60字以内・段落3〜4行・3〜4段落ごとの視覚要素(表/箇条書き/画像)・強調の適切な使用(太字1セクション1〜2回+em-marker2〜3箇所)・単調な見出しの回避。文字だけの画面が続く/極小文字・強調乱用は減点)", max: 15 },
  { key: "originality", label: "独自性 (自社知見・切り口)", max: 10 },
  { key: "density", label: "文字数と情報密度", max: 10 },
];

// ---------------- 共通ユーティリティ ----------------
// Claude 呼び出しの実体は claude-client.mjs (サブスク認証 / APIキーの両対応) に共通化した。
function requireEnv() {
  if (!hasClaudeAuth()) {
    console.error("[quality-loop] 認証なし (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY がどちらも未設定) のため品質ループをスキップします。");
    console.error("  サブスク認証: CLAUDE_CODE_OAUTH_TOKEN を設定 (CLAUDE_MODEL は任意)。APIキー認証: ANTHROPIC_API_KEY + CLAUDE_MODEL。README.md 参照。");
    process.exit(0);
  }
  // APIキーモード (サブスクトークン無し) の場合のみ CLAUDE_MODEL が必須
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_MODEL) {
    console.error("[quality-loop] APIキーモードでは CLAUDE_MODEL が必須のため品質ループをスキップします (README.md 参照)。");
    process.exit(0);
  }
}

// ---------------- 採点 (執筆AIと別セッション) ----------------
// 採点AIには「記事本文のみ」を渡す。誰が・どんな指示で書いたかは渡さない。
function buildScoringSystemPrompt() {
  return `あなたは外部の辛口SEO編集者です。提出された記事だけを材料に、以下のルーブリックで採点します。執筆者の意図や事情は考慮しません。

# ルーブリック (合計100点)
${RUBRIC.map((r) => `- ${r.key} (${r.label}): ${r.max}点満点`).join("\n")}

# 採点ルール (厳守)
- 各項目に「採点理由を1行」必ず書く。理由のない点数は無効
- 根拠なき加点は禁止。記事内に証拠 (該当箇所) を指摘できない場合は加点しない
- 出典URLのない統計数値、曖昧な断定、水増し文章は減点する
- 減点は「読者や検索評価に実害がある欠点」に限る。好みの範囲・網羅性の際限ない拡大 (周辺トピックが無い等) は減点しない
- 次はコンプライアンス上の「正しい対応」であり減点対象にしない:
  ① 顧客事例の守秘 (社名・金額・時期の非開示や匿名化)
  ② 税務・法務・社労務の断定を避け、税理士等の専門家へ誘導すること
  ③ 年度で変わる制度数値を「目安+最新の公募要領で要確認」と表現すること
  ④ 出典リンクが政府・事務局の公式サイトであること (トップページでも可。深部URLの創作の方が有害)

# スコアの較正 (この基準で点を付ける)
- 90〜100: このまま中小企業向けオウンドメディアに公開して問題ない水準 (完璧である必要はない)
- 80〜89: 概ね良いが、読者に実害のある明確な弱点が1〜2残る
- 60〜79: 公開前に修正が必要
- 60未満: 大幅な作り直しが必要

# 二軸評価 (総合点に加えて必ず出力する)
- seoScore (0-100): 検索エンジン最適化の観点での総合評価。検索意図の網羅・タイトルとキーワードの整合・見出し構造・内部リンク・E-E-A-T・情報密度を重視
- aioScore (0-100): AI検索 (ChatGPT・AI Overview等) に引用される観点での総合評価。冒頭の要点3行・定義断言文・FAQの断言形・引用しやすい単文・構造の明確さを重視
- どちらの軸もスコア較正 (90〜100=公開して問題ない水準) は総合点と同じ基準で付ける

# 出力形式 (JSONのみ。前置き・コードフェンス禁止)
{"total": <0-100>, "seoScore": <0-100>, "aioScore": <0-100>, "items": [{"key": "<ルーブリックkey>", "score": <点数>, "max": <満点>, "reason": "<採点理由1行>"}], "deductions": ["<減点理由と修正指示。SEO軸・AIO軸それぞれの弱点を必ず含める>"]}`;
}

function parseScore(text) {
  // モデルがコードフェンスを付けた場合に備えて剥がす
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("採点結果のJSONが見つかりません");
  const r = JSON.parse(cleaned.slice(start, end + 1));
  // 二軸スコアが欠けた場合は総合点で代用 (旧形式への後方互換)
  if (typeof r.seoScore !== "number") r.seoScore = r.total;
  if (typeof r.aioScore !== "number") r.aioScore = r.total;
  // 合否判定は「総合・SEO・AIOの全てが合格ライン以上」= 最も低い軸で代表させる
  r.gateScore = Math.min(r.total, r.seoScore, r.aioScore);
  return r;
}

async function scoreArticle(md) {
  // JSON崩れ・一時的な応答不良に備えて最大3回まで採点を試行する
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await callClaude(
        buildScoringSystemPrompt(),
        `次の記事を採点してください。ツールは使用せず、JSONのみを出力してください。\n\n<article>\n${md}\n</article>`,
        { maxTokens: 4000 }
      );
      return parseScore(raw);
    } catch (err) {
      lastErr = err;
      console.warn(`[quality-loop] 採点失敗 → リトライ (${attempt}/3): ${err.message}`);
    }
  }
  throw lastErr;
}

// ---------------- 改稿 (減点理由を執筆AIへ差し戻し) ----------------
// 採点ルーブリックで減点されやすい項目を、改稿AIが自力で埋められるように
// 「使ってよい一次情報」と「頻出減点の解消チェックリスト」を明示的に渡す。
const COMPANY_FACTS = `# 使用してよい当社の一次情報 (これ以外の実績数値の創作は禁止)
- 補助金申請の支援実績50社+/採択通過率90%以上(※当社支援実績・2026年7月時点)
- IT導入補助金: 補助上限350万円(通常枠の例)/申請から着金まで約2〜3ヶ月/お客様の事前準備は合計1.5〜3時間
- 当社は大阪・東成区拠点。MEO事業「G-ran」を運営。申請サポート・システム開発・AIO・MEOを一気通貫で提供
- 出典に使ってよい公式サイト: IT導入補助金事務局 https://it-shien.smrj.go.jp/ / 中小企業庁 https://www.chusho.meti.go.jp/
- 禁止表現: 割引・キャッシュバック・実質無料・実質負担・採択の保証・「必ず」「100%」等の断定
- 呼称ルール: 制度は「AI導入補助金」で統一。「IT導入補助金」は初出の「AI導入補助金 (正式名称: IT導入補助金)」1回のみ。「IT補助金」は絶対に使わない
${(() => { try { const d = JSON.parse(readFileSync(join(ROOT, "data", "case-studies.json"), "utf8")); return "- 使用してよい支援事例 (事実。社名非公開・誇張禁止。E-E-A-T強化に1〜2件を「※当社支援事例」付きで織り込んでよい):\n" + d.cases.map((c) => `  - ${c.industry} (${c.size}): ${c.summary}`).join("\n"); } catch { return ""; } })()}`;

const REVISION_CHECKLIST = `# 改稿時の必須チェックリスト (採点で減点されやすい項目)
- 公式サイトへの出典リンクを2本以上、本文の統計・制度数値の近くに置く
- 当社の一次情報 (上記の許可された実績・運用知見) を1〜2箇所、自然な文脈で加える
- <span class="em-marker">〜</span> の蛍光強調を記事全体で2〜3箇所に使う
- 1文は60字以内に分割する。冒頭の導入は3〜4行(150字前後)の段落に区切る
- 同一文言・同一CTAの繰り返しは統合する。「公式サイトで確認」で終わる節には自社の解説を一言足す
- 年度固有の金額・締切は「目安+最新の公募要領で要確認」の形にし、出典を添える
- FAQに周辺トピック (不採択時の再申請/入金時の会計処理は税理士へ相談 等) を1〜2問加え、検索意図の取りこぼしを埋める
- タイトルは32字前後で、主要キーワードと年号を前半に置く
- 「〜の傾向があります」等の弱い表現は、事実の範囲で言い切りに直す (引用されやすい断定文)
- 冒頭に「この記事の要点」3行 (各60字以内の断言文) があるか確認し、無ければ追加する (AI検索の抜粋対策)
- 各H2に結論を表す単文 (主語+数値または定義+断言) が1つ以上あるか確認する`;

async function reviseArticle(md, deductions, items) {
  // 採点内訳から「得点率が最も低い2項目」を特定し、そこへ集中改稿させる
  // (全減点を同時に直そうとして力が分散し、点が伸びない問題への対策)
  let focus = "";
  if (Array.isArray(items) && items.length > 0) {
    const worst = [...items].sort((a, b) => a.score / a.max - b.score / b.max).slice(0, 2);
    focus = `\n# 最優先で解消する2項目 (今回の改稿はここに集中する)\n${worst
      .map((w) => `- ${w.key} (${w.score}/${w.max}点): ${w.reason}`)
      .join("\n")}\n`;
  }
  const system = `あなたはセブンセンシズ株式会社のオウンドメディア専属ライターです。編集者からの減点指摘に基づき記事を改稿します。frontmatter の構造 (title, slug, description, category, tags, date, author, thumbnail, type がある場合は type も) は必ず維持してください。ツールは一切使用せず、改稿後のMarkdown全文のみを出力してください。

${COMPANY_FACTS}

${REVISION_CHECKLIST}`;
  const user = `以下の記事が品質審査で不合格になりました。改稿後の記事全文 (frontmatter付きMarkdown) のみを出力してください。前置き・後書き・質問は禁止です。
${focus}
# その他の減点理由 (上の2項目を優先しつつ、悪化させないこと)
${deductions.map((d, i) => `${i + 1}. ${d}`).join("\n")}

# 現在の記事
${md}`;
  let revised = await callClaude(system, user, { maxTokens: 16000 });
  return revised.replace(/^```(?:markdown|md)?\n/, "").replace(/\n```\s*$/, "").trim();
}

// 改稿出力の健全性チェック: CLIの許可要求文や途切れた出力を記事として
// 採用してしまう事故 (59点→2点急落) を防ぐ
function isValidRevision(text, prev) {
  const hasFm = /^---\n[\s\S]*?\btitle:/.test(text);
  const longEnough = text.length >= prev.length * 0.5;
  return hasFm && longEnough;
}

// ---------------- メイン処理 ----------------
async function main() {
  requireEnv();
  mkdirSync(REVIEW_DIR, { recursive: true });
  mkdirSync(dirname(LOG_PATH), { recursive: true });

  const drafts = readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".md"));
  if (drafts.length === 0) {
    console.log("[quality-loop] 対象の下書きがありません。スキップします。");
    return;
  }

  const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { entries: [] };

  async function processDraft(file) {
    const path = join(DRAFTS_DIR, file);
    let md = readFileSync(path, "utf8");
    const history = []; // 点数推移
    let result = null;
    let best = { total: -1, md: null }; // 採点のブレ対策: 最高得点版を保持する
    let stale = 0; // ベスト未更新の連続ラウンド数 (2で早期終了して時間を節約)

    console.log(`[quality-loop] 採点開始: ${file}`);
    for (let round = 0; round <= MAX_REVISIONS; round++) {
      try {
        result = await scoreArticle(md);
      } catch (err) {
        console.error(`[quality-loop] ${file} の採点に失敗: ${err.message}`);
        break;
      }
      history.push({ round, total: result.total, seo: result.seoScore, aio: result.aioScore, items: result.items });
      console.log(`[quality-loop] ${file} ラウンド${round}: 総合${result.total} / SEO${result.seoScore} / AIO${result.aioScore} (判定=${result.gateScore})`);
      if (result.gateScore > best.total) { best = { total: result.gateScore, md }; stale = 0; } else { stale++; }

      if (result.gateScore >= MIN_SCORE) break; // 総合・SEO・AIOの全軸が合格ラインを超えた場合のみ通過
      if (round === MAX_REVISIONS) break; // 改稿上限。この後 human-review へ
      if (stale >= 2) {
        console.log(`[quality-loop] ${file} は2ラウンド連続で改善なし → 早期終了 (ベスト${best.total}点)`);
        break;
      }

      console.log(`[quality-loop] ${file} を改稿します (${round + 1}/${MAX_REVISIONS})`);
      let revised = await reviseArticle(md, result.deductions ?? ["総合的に品質を高めてください"], result.items);
      if (!isValidRevision(revised, md)) {
        console.warn(`[quality-loop] 改稿出力が不正 (frontmatter欠落 or 大幅な短文化) → 再改稿を1回試行`);
        revised = await reviseArticle(md, result.deductions ?? ["総合的に品質を高めてください"], result.items);
      }
      if (isValidRevision(revised, md)) {
        md = revised;
        writeFileSync(path, md, "utf8"); // 改稿版で上書き (最終判定前でも最新版を保持)
      } else {
        console.warn(`[quality-loop] 再改稿も不正 → このラウンドは前版を維持して再採点します`);
      }
    }

    // 最終判定は「最高得点版」で行う (最後の改稿で点が下がった場合に良版を捨てない)
    // ※判定スコア = min(総合, SEO, AIO)。両面で85点以上が公開条件
    const finalScore = Math.max(best.total, result ? result.gateScore : -1);
    if (best.md !== null && best.total >= (result ? result.total : -1)) {
      writeFileSync(path, best.md, "utf8");
      console.log(`[quality-loop] ${file} は最高得点版 (${best.total}点) を最終版として採用`);
    }
    const passed = finalScore >= MIN_SCORE;
    if (!passed) {
      // 合格ラインに届かない記事は自動公開せず人間レビューへ隔離
      renameSync(path, join(REVIEW_DIR, file));
      console.warn(`[quality-loop] ${file} は${MAX_REVISIONS}回の改稿でも未達 (最高${finalScore}点) → human-review/ へ移動`);
    }

    return {
      file: basename(file),
      date: new Date().toISOString(),
      finalScore: finalScore >= 0 ? finalScore : null,
      revisions: Math.max(0, history.length - 1),
      passed,
      history,
      stage: "quality-loop",
    };
  }

  // 複数記事は並列で採点・改稿する (朝の2本ランの所要時間を約半分にする)
  const entries = await Promise.all(drafts.map(processDraft));
  log.entries.push(...entries);

  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
  console.log(`[quality-loop] 完了。ログ: ${LOG_PATH}`);
}

main().catch((err) => {
  console.error("[quality-loop] 致命的エラー:", err);
  process.exit(1);
});
