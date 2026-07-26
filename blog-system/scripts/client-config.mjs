// =============================================================
// client-config.mjs — クライアント設定の共通ローダー
//
// リポジトリ直下の client-config.json を読み、全スクリプトへ提供する。
// 新規クライアント展開時は client-config.json と LP本体の文言だけを
// 差し替えれば、記事生成・採点・ゲート・レポートが追従する。
// ファイルが無い/壊れている場合は例外を投げて即停止する
// (他社設定のまま動く事故を防ぐため、フォールバックしない)。
// =============================================================
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let raw;
try {
  raw = JSON.parse(readFileSync(join(REPO, "client-config.json"), "utf8"));
} catch (e) {
  throw new Error(`client-config.json が読めません (リポジトリ直下に必須): ${e.message}`);
}

const REQUIRED = ["companyName", "siteUrl", "authorName", "naming", "allowedFacts", "factsBlock", "serviceHubs"];
for (const k of REQUIRED) {
  if (raw[k] === undefined) throw new Error(`client-config.json に必須キー「${k}」がありません`);
}

export const CLIENT = {
  ...raw,
  siteUrl: raw.siteUrl.replace(/\/$/, ""),
  factsText: raw.factsBlock.join("\n"),
  namingRuleText:
    `- 制度の呼称は「${raw.naming.preferred}」で統一する。正式名称への言及は記事の初出1回だけ` +
    `「${raw.naming.preferred} (正式名称: ${raw.naming.official})」と書き、以降はすべて「${raw.naming.preferred}」。` +
    `${raw.naming.forbidden.map((f) => `「${f}」`).join("・")}という略称は絶対に使わない`,
};
