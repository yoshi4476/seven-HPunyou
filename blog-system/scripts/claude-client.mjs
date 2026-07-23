// =============================================================
// claude-client.mjs — Claude 呼び出し共通クライアント
//
// 3スクリプト (generate-articles / quality-loop / embed-images) で
// 重複していた Claude 呼び出しを一本化し、2種類の認証に対応する。
//
// 認証の優先順 (上から順に判定。トークン > APIキー):
//   1. サブスク認証: env CLAUDE_CODE_OAUTH_TOKEN
//      → Claude Code CLI (`claude -p`) を headless 実行して生成する。
//        Claude Pro/Max プランのサブスクリプション枠を消費するため、
//        Anthropic API の従量課金は発生しない。
//        CLAUDE_MODEL は任意 (未設定なら CLI の既定モデルを使用)。
//   2. APIキー: env ANTHROPIC_API_KEY (+ CLAUDE_MODEL 必須)
//      → 従来どおり Anthropic Messages API を fetch で直叩き (従量課金)。
//   3. どちらも無ければ hasClaudeAuth() が false
//      → 各スクリプト側で「明確なメッセージを出して exit 0 (スキップ)」する。
//
// エクスポート:
//   hasClaudeAuth(): boolean
//   callClaude(systemPrompt, userPrompt, opts?): Promise<string>
//     opts.maxTokens … APIキーモードの max_tokens (既定 16000)。
//                      サブスクモードでは CLI が出力長を管理するため未使用。
// =============================================================
import { execFile } from "node:child_process";

// ---------------- 設定定数 ----------------
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16000;
const API_RETRIES = 3;            // APIキーモード: 429/5xx/529 のリトライ回数 (指数バックオフ)
const CLI_RETRIES = 2;            // サブスクモード: 失敗時のリトライ回数
const CLI_RETRY_WAIT_MS = 15000;  // サブスクモード: リトライ前の待機 (レート枠回復待ち)
const CLI_MAX_BUFFER = 64 * 1024 * 1024; // CLI 標準出力の上限 64MB (長文記事対策)

// ---------------- 認証判定 ----------------
/** サブスク認証 (CLAUDE_CODE_OAUTH_TOKEN) と APIキー (ANTHROPIC_API_KEY) の
 *  どちらかが設定されていれば true。どちらも無ければ false。 */
export function hasClaudeAuth() {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

function isSubscriptionMode() {
  // トークンがあれば APIキーの有無にかかわらずサブスク認証を優先する
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
}

// 使用中の認証モードは初回呼び出し時に1度だけログする (デバッグ用)
let modeLogged = false;
function logModeOnce() {
  if (modeLogged) return;
  modeLogged = true;
  if (isSubscriptionMode()) {
    const model = process.env.CLAUDE_MODEL ? `モデル: ${process.env.CLAUDE_MODEL}` : "モデル: CLI既定";
    console.log(`[claude-client] 認証モード: サブスクリプション (Claude Code CLI / ${model})`);
  } else {
    console.log(`[claude-client] 認証モード: APIキー (Anthropic API / モデル: ${process.env.CLAUDE_MODEL})`);
  }
}

// ---------------- 公開API ----------------
/**
 * Claude にプロンプトを渡してテキストを生成する。
 * 認証モード (サブスク / APIキー) は環境変数から自動判定。
 * @param {string} systemPrompt システムプロンプト
 * @param {string} userPrompt   ユーザープロンプト
 * @param {{maxTokens?: number}} [opts]
 * @returns {Promise<string>} 生成テキスト
 */
export async function callClaude(systemPrompt, userPrompt, opts = {}) {
  if (!hasClaudeAuth()) {
    throw new Error(
      "認証情報がありません。CLAUDE_CODE_OAUTH_TOKEN (サブスク認証) または ANTHROPIC_API_KEY (従量課金) を設定してください。"
    );
  }
  logModeOnce();
  if (isSubscriptionMode()) {
    return callViaCli(systemPrompt, userPrompt);
  }
  return callViaApi(systemPrompt, userPrompt, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
}

// ---------------- 1. サブスク認証: Claude Code CLI 経由 ----------------
// `claude -p` (print モード) に stdin でプロンプトを渡して headless 実行する。
// 引数渡しだと OS の引数長制限に当たるため、必ず stdin 経由にする。
function buildCliPrompt(systemPrompt, userPrompt) {
  // CLI にはシステム/ユーザーの区別を1本のプロンプトとして結合して渡す
  return `# System\n${systemPrompt}\n\n# Task\n${userPrompt}`;
}

// 1回分の CLI 実行を Promise 化 (非同期化により複数記事の並列処理を可能にする)
function execCliOnce(cmd, args, prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd, args,
      { encoding: "utf8", maxBuffer: CLI_MAX_BUFFER, env: { ...process.env } }, // CLAUDE_CODE_OAUTH_TOKEN を CLI に引き継ぐ
      (err, stdout, stderr) => {
        if (err) {
          err.stderrText = (stderr || "").toString();
          reject(err);
        } else {
          resolve(stdout);
        }
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function execClaudeCli(prompt) {
  const args = [
    "-p",                       // print モード (対話なしの1回実行)
    "--output-format", "text",  // 生成テキストのみを標準出力へ
    ...(process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : []),
  ];
  // Windows のローカル検証では npm のシム (claude.cmd) しか無い場合があるため
  // "claude" が ENOENT のときだけ "claude.cmd" を再試行する (CI の Linux では不要)
  const commands = process.platform === "win32" ? ["claude", "claude.cmd"] : ["claude"];
  let lastEnoent;
  for (const cmd of commands) {
    try {
      return await execCliOnce(cmd, args, prompt);
    } catch (err) {
      if (err.code === "ENOENT") {
        lastEnoent = err;
        continue; // 次の候補コマンドを試す
      }
      // CLI がエラー終了した場合は stderr を含めて投げ直す (呼び出し側でリトライ)
      const stderr = (err.stderrText || "").trim().slice(0, 500);
      throw new Error(`Claude Code CLI がエラー終了しました: ${err.message}${stderr ? `\n  stderr: ${stderr}` : ""}`);
    }
  }
  // ここに来るのは全候補が ENOENT だった場合のみ
  const notFound = new Error(
    "Claude Code CLI (claude コマンド) が見つかりません。`npm install -g @anthropic-ai/claude-code` でインストールしてください。" +
      " (GitHub Actions では auto-publish.yml の「Claude Code CLI セットアップ」ステップが担当)"
  );
  notFound.cause = lastEnoent;
  notFound.isEnoent = true; // インストール不足はリトライしても無駄なので即時終了させる
  throw notFound;
}

async function callViaCli(systemPrompt, userPrompt) {
  const prompt = buildCliPrompt(systemPrompt, userPrompt);
  let lastError;
  for (let attempt = 0; attempt <= CLI_RETRIES; attempt++) {
    if (attempt > 0) {
      console.warn(`[claude-client] CLI 実行を${CLI_RETRY_WAIT_MS / 1000}秒後にリトライします (${attempt}/${CLI_RETRIES})`);
      await new Promise((r) => setTimeout(r, CLI_RETRY_WAIT_MS));
    }
    try {
      const text = (await execClaudeCli(prompt)).trim();
      if (!text) throw new Error("Claude Code CLI の出力が空でした。");
      return text;
    } catch (err) {
      if (err.isEnoent) throw err; // CLI 未インストールはリトライ対象外
      lastError = err;
      console.warn(`[claude-client] CLI 実行に失敗: ${err.message}`);
    }
  }
  throw lastError;
}

// ---------------- 2. APIキー: Anthropic Messages API (fetch) ----------------
// 旧 generate-articles.mjs の callClaude をそのまま移設。
// リトライ (429/5xx/529 指数バックオフ)・refusal/max_tokens の処理を維持する。
async function callViaApi(systemPrompt, userPrompt, maxTokens) {
  if (!process.env.CLAUDE_MODEL) {
    throw new Error("APIキーモードでは CLAUDE_MODEL の設定が必須です (ハードコード禁止。README 参照)。");
  }
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
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.stop_reason === "refusal") {
        throw new Error("モデルが生成を拒否しました (stop_reason: refusal)。プロンプト内容を確認してください。");
      }
      if (data.stop_reason === "max_tokens") {
        console.warn("[claude-client] 警告: max_tokens に到達。出力末尾が途切れている可能性があります。");
      }
      return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }

    // 429 / 5xx / 529 はリトライ対象 (指数バックオフ)
    if ([429, 500, 529].includes(res.status) || res.status >= 500) {
      lastError = new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
      const waitMs = 2000 * 2 ** (attempt - 1);
      console.warn(`[claude-client] APIエラー(${res.status})。${waitMs}ms 後にリトライ (${attempt}/${API_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Anthropic API エラー: ${res.status} ${await res.text()}`);
  }
  throw lastError;
}
