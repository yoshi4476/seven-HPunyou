/** =========================================================================
 * セブンセンシズ株式会社 LP リード受付エンドポイント (Google Apps Script / V8)
 *
 * 役割:
 *   LP(静的HTML)からの fetch POST (JSON) を受け取り、
 *   1) スパムフィルタ(ハニーポット / 3秒未満送信 / 24時間以内重複)
 *   2) スプレッドシート「leads」へ記録 + リード温度スコアリング
 *   3) Slack + 管理者メールの二重通知(片方失敗でも他方は送る)
 *   4) type別の自動返信メール(相談 / 診断 / 資料DL)
 *   を行う。
 *
 * デプロイ: スプレッドシートのコンテナバインドスクリプトとして貼り付け、
 *   「デプロイ > 新しいデプロイ > ウェブアプリ」
 *   実行ユーザー: 自分 / アクセスできるユーザー: 全員
 *   発行されたURLを LP側の GAS_ENDPOINT に設定する。
 *
 * スクリプトプロパティ(プロジェクトの設定 > スクリプト プロパティ):
 *   SLACK_WEBHOOK_URL … Slack Incoming Webhook URL(必須)
 *   ADMIN_EMAIL       … 管理者通知先メール(必須)
 *   CALENDLY_URL      … 日程調整リンク(必須)
 *   WHITEPAPER_URL    … 資料DLリンク(必須)
 *   BLOG_URL          … ブログトップURL(任意)
 *   UNSUBSCRIBE_URL   … 配信停止フォームURL(任意・特定電子メール法対応)
 *   SLACK_MENTION     … Slackメンション文字列(任意・例 "<@U0123ABCD>")
 * ========================================================================= */

// ===== 固定設定 =====
const CONFIG = {
  SHEET_NAME: 'leads',
  MIN_SUBMIT_MS: 3000,                    // フォーム表示から3秒未満の送信はBot判定
  DUPLICATE_WINDOW_MS: 24 * 60 * 60 * 1000, // 同一メール24時間以内は既存行に統合
  // WARM→HOT昇格キーワード(相談フォーム本文に含まれていたら昇格)
  HOT_KEYWORDS: ['補助金', '見積', '見積もり', '見積り', '導入', '申請', '予算', '急ぎ', '至急', '締め切り', '締切'],
  COMPANY_NAME: 'セブンセンシズ株式会社',
  COMPANY_ADDRESS: '〒537-0013 大阪市東成区神路1-7-4 コンフォートビル901・902',
  COMPANY_TEL: '06-4305-7547',
  COMPANY_EMAIL: 'info.ai@7senses.co.jp',       // お問い合わせ窓口(通知先の既定・返信先)
  ADMIN_EMAIL_DEFAULT: 'info.ai@7senses.co.jp', // ADMIN_EMAILプロパティ未設定時の通知先
  MAIL_SENDER_NAME: 'セブンセンシズ株式会社',
  SLA_TEXT: '3営業日以内'
};

// 診断5軸のラベル(LP側スコアキーと対応。補助金/MEO/AI活用の3診断すべてのキーを含む)
const SCORE_LABELS = {
  hojokin: '補助金活用度',
  ai: 'AI活用度',
  digital: 'デジタル基盤',
  shukyaku: '集客力',
  suishin: '推進体制',
  profile: 'プロフィール整備',
  kuchikomi: '口コミ力',
  post: '投稿・写真',
  nap: '情報の一致',
  kyoso: '競合優位',
  gyomu: '自動化余地',
  data: 'データ整備',
  tool: 'AI活用度',
  jinzai: '推進体制',
  invest: '投資準備'
};

// 診断種別ラベル(diagnosis.kind → 表示名)
const DIAG_KIND_LABELS = { hojokin: 'AI補助金診断', meo: 'MEO集客診断', ai: 'AI活用診断' };

// 診断グレード別の処方箋(自動返信メールに差し込む)
const GRADE_ADVICE = {
  S: '補助金活用の条件がほぼ整っています。今期の公募回での申請を強くおすすめします。公募締切から逆算した準備スケジュールを無料相談でご提案できます。',
  A: '補助金活用の適性が高い状態です。あと1〜2点の弱点(スコアが低い軸)を補強すれば、採択率をさらに高められます。',
  B: '基礎は合格ラインです。まずはスコアが低い軸(推進体制・デジタル基盤など)の整備から始めると、申請までの道のりが最短になります。',
  C: 'いまは準備段階です。現状業務の棚卸しとGビズIDの取得など、申請の前提づくりから伴走いたします。',
  D: '今すぐの申請よりも、まず「何をAI化すると一番効果が出るか」の優先順位設計をおすすめします。無料相談で一緒に整理しましょう。'
};

// 温度の強さ(重複統合時に高い方へ更新するため)
const TEMP_RANK = { 'HOT': 3, 'WARM': 2, 'COOL': 1 };

const TYPE_LABELS = { contact: '無料相談', diagnosis: 'AI補助金診断', download: '資料ダウンロード', site_audit: 'サイト無料診断' };

// サイト診断5軸のラベル(LP側 audit.axes キーと対応)
const AUDIT_LABELS = {
  aio: 'AIO対応', seo: 'SEO基礎', schema: '構造化データ', mobile: 'モバイル・技術', trust: '信頼性'
};

// =========================================================================
// エントリポイント
// =========================================================================

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ok_(); // 壊れたリクエストも黙って200
  }

  // ---- 入口フィルタ(Botはすべて「成功」を返して黙って破棄)----
  if (data.website) return ok_();                                   // ハニーポット
  const elapsed = Date.now() - Number(data.ts || 0);
  if (!data.ts || elapsed < CONFIG.MIN_SUBMIT_MS) return ok_();     // 3秒未満送信
  if (['contact', 'diagnosis', 'download', 'site_audit', 'unsubscribe'].indexOf(data.type) === -1) return ok_();
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email))) return ok_();

  // ---- 配信停止(リード処理とは独立に扱う)----
  if (data.type === 'unsubscribe') {
    try { handleUnsubscribe_(String(data.email).trim().toLowerCase()); } catch (err) { console.error('配信停止処理失敗: ' + err.message); }
    return ok_();
  }

  const lead = normalize_(data);

  // ---- スプレッドシート記録(重複は既存行に統合)----
  const lock = LockService.getScriptLock();
  let isDuplicate = false;
  try {
    lock.waitLock(10000);
    isDuplicate = saveToSheet_(lead);
  } catch (err) {
    // シート書込失敗でも通知は続行(取りこぼし防止)
    lead.memo = 'シート書込エラー: ' + err.message;
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }

  // ---- 通知の二重化(try-catch分離: 片方失敗でも他方は必ず送る)----
  try {
    notifySlack_(lead, isDuplicate);
  } catch (err) {
    console.error('Slack通知失敗: ' + err.message);
  }
  try {
    notifyAdminEmail_(lead, isDuplicate);
  } catch (err) {
    console.error('管理者メール失敗: ' + err.message);
  }

  // ---- 自動返信(重複でも返信は送る = ユーザー体験優先)----
  try {
    sendAutoReply_(lead);
  } catch (err) {
    console.error('自動返信失敗: ' + err.message);
  }

  return ok_();
}

/**
 * GET エンドポイント:
 *   ?action=audit&url=https://example.com … サイト無料診断(採点JSONを返す)
 *   パラメータなし … ヘルスチェック
 * ContentService の JSON 出力は匿名公開デプロイならクロスオリジンで読み取れる
 * (LP側は単純リクエストのGET fetchで呼ぶこと。カスタムヘッダー禁止)
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'audit') {
    let result;
    try {
      result = runSiteAudit_(String(p.url || ''));
    } catch (err) {
      result = { ok: false, error: '診断中にエラーが発生しました' };
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', service: '7senses-lp-endpoint' })
  ).setMimeType(ContentService.MimeType.JSON);
}

// =========================================================================
// 正規化・スコアリング
// =========================================================================

function normalize_(data) {
  const d = data.diagnosis || {};
  const scores = d.scores || {};
  return {
    now: new Date(),
    type: data.type,
    typeLabel: (data.type === 'diagnosis' && d.kind && DIAG_KIND_LABELS[d.kind])
      ? DIAG_KIND_LABELS[d.kind] : TYPE_LABELS[data.type],
    name: String(data.name || '').slice(0, 100),
    email: String(data.email).trim().toLowerCase().slice(0, 200),
    company: String(data.company || '').slice(0, 100),
    tel: String(data.tel || '').slice(0, 40),
    topic: String(data.topic || '').slice(0, 100),
    // 特典コードは詳細欄への記入で申告してもらう運用。念のため本文からも拾う
    perkCode: String(data.perkCode || (/\b3010\b/.test(String(data.message || '')) ? '3010' : '')).slice(0, 20),
    message: String(data.message || '').slice(0, 2000),
    grade: d.grade || (data.audit ? data.audit.grade : '') || '',
    scores: scores,
    answers: d.answers || [],
    audit: data.audit || null, // site_audit: { url, total, grade, axes, findings }
    temp: scoreLead_(data),
    memo: ''
  };
}

/**
 * リード温度3段階:
 *   診断完了 = HOT / 相談 = WARM(本文にHOTキーワードがあればHOT昇格) / 資料DL = COOL
 */
function scoreLead_(data) {
  if (data.type === 'diagnosis') return 'HOT';
  if (data.type === 'site_audit') return 'HOT'; // 自社URLを差し出した=検討度が高い
  if (data.type === 'contact') {
    const msg = String(data.message || '');
    const hit = CONFIG.HOT_KEYWORDS.some(function (kw) { return msg.indexOf(kw) !== -1; });
    return hit ? 'HOT' : 'WARM';
  }
  return 'COOL'; // download
}

// =========================================================================
// スプレッドシート
// =========================================================================

// 「名前」はフォームの「ご担当者様」に対応する(会社名と担当者名の2項目構成)
const HEADER = ['日時', 'type', 'ご担当者', 'メール', '会社・店舗', '電話', 'ご相談内容',
                '特典コード', '詳細', '診断grade', 'スコア', 'リード温度', 'メモ'];

// 列番号(1始まり)。項目を増減したときに位置を取り違えないよう名前で参照する
const COL = {};
HEADER.forEach(function (h, i) { COL[h] = i + 1; });

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 24時間以内の同一メールは新規行を作らず既存行のメモに追記して統合。
 * @return {boolean} 重複だったかどうか
 */
function saveToSheet_(lead) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const scoreText = formatScoresInline_(lead.scores);

  // 直近200件だけ走査(十分な範囲・高速)
  if (lastRow >= 2) {
    const startRow = Math.max(2, lastRow - 199);
    const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, HEADER.length).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      const rowDate = values[i][0];
      const rowEmail = String(values[i][COL['メール'] - 1] || '').trim().toLowerCase();

      if (rowEmail !== lead.email) continue;
      if (!(rowDate instanceof Date)) continue;
      if (lead.now.getTime() - rowDate.getTime() > CONFIG.DUPLICATE_WINDOW_MS) continue;

      // === 重複: 既存行に統合 ===
      const rowIndex = startRow + i;
      const stamp = Utilities.formatDate(lead.now, 'Asia/Tokyo', 'MM/dd HH:mm');
      const addMemo = '[' + stamp + ' 再送信: ' + lead.typeLabel + ']'
        + (lead.message ? ' ' + lead.message.slice(0, 200) : '')
        + (lead.grade ? ' grade=' + lead.grade : '');
      const oldMemo = String(values[i][COL['メモ'] - 1] || '');
      sheet.getRange(rowIndex, COL['メモ']).setValue(oldMemo ? oldMemo + '\n' + addMemo : addMemo);

      // 温度は高い方へ更新
      const oldTemp = String(values[i][COL['リード温度'] - 1] || 'COOL');
      if ((TEMP_RANK[lead.temp] || 0) > (TEMP_RANK[oldTemp] || 0)) {
        sheet.getRange(rowIndex, COL['リード温度']).setValue(lead.temp);
      }
      // 診断結果が新たに得られた場合は反映
      if (lead.grade && !values[i][COL['診断grade'] - 1]) {
        sheet.getRange(rowIndex, COL['診断grade']).setValue(lead.grade);
        sheet.getRange(rowIndex, COL['スコア']).setValue(scoreText);
      }
      // 後から特典コードの申告があった場合も取りこぼさない
      if (lead.perkCode && !values[i][COL['特典コード'] - 1]) {
        sheet.getRange(rowIndex, COL['特典コード']).setValue(lead.perkCode);
      }
      return true;
    }
  }

  // === 新規行 ===
  sheet.appendRow([
    lead.now, lead.type, lead.name, lead.email, lead.company,
    lead.tel, lead.topic, lead.perkCode,
    lead.message, lead.grade, scoreText, lead.temp, lead.memo
  ]);
  return false;
}

function formatScoresInline_(scores) {
  const parts = [];
  for (const key in SCORE_LABELS) {
    if (scores[key] !== undefined) parts.push(SCORE_LABELS[key] + ':' + scores[key]);
  }
  return parts.join(' / ');
}

// =========================================================================
// 通知(Slack + 管理者メール)
// =========================================================================

const TEMP_TAGS = { HOT: '🔥【HOT】', WARM: '🌤【WARM】', COOL: '❄️【COOL】' };

function buildSummary_(lead) {
  const lines = [];
  lines.push('種別: ' + lead.typeLabel + (lead.grade ? '(判定 ' + lead.grade + ')' : ''));
  if (lead.company) lines.push('会社・店舗: ' + lead.company);
  lines.push('ご担当者: ' + (lead.name || '(未入力)'));
  lines.push('メール: ' + lead.email);
  if (lead.tel) lines.push('電話: ' + lead.tel);
  if (lead.topic) lines.push('ご相談内容: ' + lead.topic);
  // 特典希望は対応時に見落とすと不満につながるため目立たせる
  if (lead.perkCode) lines.push('★特典希望: コード ' + lead.perkCode
    + '(MEOスタンダード無料付帯 / オウンドメディア運営のご契約者限定)');
  if (lead.message) lines.push('詳細: ' + lead.message);
  const scoreText = formatScoresInline_(lead.scores);
  if (scoreText) lines.push('スコア: ' + scoreText);
  if (lead.audit) {
    lines.push('診断URL: ' + lead.audit.url);
    lines.push('サイト診断: ' + lead.audit.total + '点(' + lead.audit.grade + '判定)');
    const ax = [];
    for (const key in AUDIT_LABELS) {
      if (lead.audit.axes && lead.audit.axes[key] !== undefined) ax.push(AUDIT_LABELS[key] + ':' + lead.audit.axes[key]);
    }
    if (ax.length) lines.push('5軸: ' + ax.join(' / '));
  }
  if (lead.answers && lead.answers.length) lines.push('回答: [' + lead.answers.join(', ') + ']');
  if (lead.memo) lines.push('注意: ' + lead.memo);
  return lines.join('\n');
}

function notifySlack_(lead, isDuplicate) {
  const url = getProp_('SLACK_WEBHOOK_URL');
  if (!url) throw new Error('SLACK_WEBHOOK_URL 未設定');
  const mention = getProp_('SLACK_MENTION') || '<!channel>';
  const dupTag = isDuplicate ? '(24h内の再送信・既存行に統合)' : '新規リード';

  const text = TEMP_TAGS[lead.temp] + ' ' + dupTag + ' ' + mention + '\n'
    + buildSummary_(lead) + '\n'
    + '対応SLA: ' + CONFIG.SLA_TEXT + 'に返信(HOTは当日推奨)';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Slack応答 ' + res.getResponseCode());
  }
}

function notifyAdminEmail_(lead, isDuplicate) {
  const admin = getProp_('ADMIN_EMAIL') || CONFIG.ADMIN_EMAIL_DEFAULT;
  const subject = '【LPリード/' + lead.temp + '】' + lead.typeLabel + ' - '
    + (lead.name || lead.email) + (isDuplicate ? '(再送信)' : '');
  const body = 'LPから新しい送信がありました。\n\n'
    + buildSummary_(lead) + '\n\n'
    + '受信日時: ' + Utilities.formatDate(lead.now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') + '\n'
    + 'スプレッドシート「' + CONFIG.SHEET_NAME + '」を確認してください。';
  MailApp.sendEmail({ to: admin, subject: subject, body: body, name: CONFIG.MAIL_SENDER_NAME });
}

// =========================================================================
// 自動返信メール(3文面)
// =========================================================================

function sendAutoReply_(lead) {
  let subject, body;
  if (lead.type === 'contact') {
    subject = '【受付完了】無料相談のお申し込みありがとうございます|' + CONFIG.COMPANY_NAME;
    body = buildContactReply_(lead);
  } else if (lead.type === 'diagnosis') {
    subject = '【診断結果:' + lead.grade + '判定】AI導入補助金 適性診断の結果をお送りします|' + CONFIG.COMPANY_NAME;
    body = buildDiagnosisReply_(lead);
  } else if (lead.type === 'site_audit') {
    subject = '【サイト診断:' + (lead.audit ? lead.audit.total + '点' : lead.grade + '判定') + '】Web サイト簡易診断の結果をお送りします|' + CONFIG.COMPANY_NAME;
    body = buildAuditReply_(lead);
  } else {
    subject = '【資料のご案内】ダウンロードリンクをお送りします|' + CONFIG.COMPANY_NAME;
    body = buildDownloadReply_(lead);
  }
  MailApp.sendEmail({
    to: lead.email,
    subject: subject,
    body: body + mailFooter_(),
    name: CONFIG.MAIL_SENDER_NAME,
    replyTo: CONFIG.COMPANY_EMAIL
  });
}

function honorific_(lead) {
  return (lead.name ? lead.name + ' 様' : 'ご担当者様');
}

/** ① 無料相談 */
function buildContactReply_(lead) {
  const calendly = getProp_('CALENDLY_URL') || 'https://lp.7senses.co.jp/#contact';
  return honorific_(lead) + '\n\n'
    + 'このたびは' + CONFIG.COMPANY_NAME + 'へお問い合わせいただき、誠にありがとうございます。\n'
    + '以下の内容でお申し込みを受け付けました。\n\n'
    + '----------------------------------------\n'
    + 'お名前: ' + (lead.name || '(未入力)') + '\n'
    + (lead.company ? '会社名: ' + lead.company + '\n' : '')
    + 'ご相談内容:\n' + (lead.message || '(未入力)') + '\n'
    + '----------------------------------------\n\n'
    + '担当者より ' + CONFIG.SLA_TEXT + ' にメールでご返信いたします。\n'
    + 'お約束どおり、こちらから営業のお電話をおかけすることはありません。\n\n'
    + 'お急ぎの場合は、下記リンクから無料相談(オンライン30分)の日時を直接ご予約いただけます。\n'
    + '▼ 日程を予約する\n'
    + calendly + '\n\n'
    + 'ご相談では、貴社の状況に合わせて\n'
    + '・IT導入補助金(上限350万円)の対象になるかどうか\n'
    + '・採択までのスケジュールと必要な準備\n'
    + '・補助金適用後の自己負担額の目安\n'
    + 'を、その場で率直にお伝えします。\n\n'
    + '■ Zoom無料相談 ご参加特典(参加された方全員に、その場で進呈)\n'
    + '① ChatGPT業務活用スターターキット(コピペで使える業務プロンプト20本・PDF)\n'
    + '② Googleビジネスプロフィール セルフ改善チェックシート(30項目採点式・PDF)\n'
    + '※採択・ご契約の有無は問いません。特典は相談の中でお渡しします。';
}

/** ② 診断結果 */
function buildDiagnosisReply_(lead) {
  const calendly = getProp_('CALENDLY_URL') || 'https://lp.7senses.co.jp/#contact';
  const scoreLines = [];
  for (const key in SCORE_LABELS) {
    if (lead.scores[key] !== undefined) {
      scoreLines.push('  ' + SCORE_LABELS[key] + ': ' + lead.scores[key] + ' / 100 ' + scoreBar_(lead.scores[key]));
    }
  }
  const advice = GRADE_ADVICE[lead.grade] || GRADE_ADVICE.C;
  return honorific_(lead) + '\n\n'
    + 'AI導入補助金 適性診断(8問)へのご回答ありがとうございました。\n'
    + '診断結果をお送りします。\n\n'
    + '========================================\n'
    + ' 総合判定: 【 ' + lead.grade + ' 】\n'
    + '========================================\n'
    + scoreLines.join('\n') + '\n'
    + '----------------------------------------\n\n'
    + '■ 診断からの処方箋\n'
    + advice + '\n\n'
    + '■ 次の一歩\n'
    + '診断結果をもとに、貴社が「いくら補助されるか」「どの公募回に間に合うか」を\n'
    + '無料相談(オンライン30分)で具体的にお答えできます。\n'
    + '営業のお電話はいたしません。日程は下記からご都合の良い枠をお選びください。\n\n'
    + '▼ 無料相談を予約する\n'
    + calendly + '\n\n'
    + '(参考)IT導入補助金は上限350万円・当社支援の採択通過率は90%以上です(※当社支援実績)。';
}

/** ③ 資料DL */
function buildDownloadReply_(lead) {
  const whitepaper = getProp_('WHITEPAPER_URL') || 'https://lp.7senses.co.jp/downloads/ai-hojokin-guide-2026.pdf';
  const blog = getProp_('BLOG_URL') || 'https://lp.7senses.co.jp/blog/';
  return honorific_(lead) + '\n\n'
    + '資料のダウンロードをお申し込みいただき、ありがとうございます。\n'
    + '下記リンクからご覧いただけます。\n\n'
    + '▼ 資料ダウンロード\n'
    + whitepaper + '\n\n'
    + '資料では、AI導入補助金(IT導入補助金)の\n'
    + '・補助上限350万円のしくみと対象ツール\n'
    + '・採択率を左右する申請準備のポイント\n'
    + '・着金までの実際のスケジュール(約2〜3ヶ月)\n'
    + 'をまとめています。\n\n'
    + 'また、ブログでは補助金・AI導入・集客(AIO/MEO)の最新情報を随時更新しています。\n'
    + '「自社の場合はどうなのか」を考える材料としてお役立てください。\n\n'
    + '▼ 関連ブログを読む\n'
    + blog + '\n\n'
    + 'ご不明点があれば、このメールへの返信でお気軽にお尋ねください。\n'
    + CONFIG.SLA_TEXT + 'にご返信いたします(営業のお電話はいたしません)。';
}

/** ④ サイト無料診断(簡易版であることを明示し、精密診断=無料相談へ誘導) */
function buildAuditReply_(lead) {
  const calendly = getProp_('CALENDLY_URL') || 'https://lp.7senses.co.jp/#contact';
  const a = lead.audit || { url: '', total: 0, grade: 'C', axes: {}, findings: [] };
  const axLines = [];
  for (const key in AUDIT_LABELS) {
    if (a.axes[key] !== undefined) {
      axLines.push('  ' + AUDIT_LABELS[key] + ': ' + a.axes[key] + ' / 100 ' + scoreBar_(a.axes[key]));
    }
  }
  const findLines = (a.findings || []).slice(0, 5).map(function (f) {
    return '  ・' + f.label + '(−' + (f.max - f.got) + '点)' + (f.note ? ': ' + f.note : '');
  });
  return honorific_(lead) + '\n\n'
    + 'Webサイト無料診断(簡易版)をご利用いただき、ありがとうございました。\n'
    + '診断結果をお送りします。\n\n'
    + '対象URL: ' + a.url + '\n\n'
    + '========================================\n'
    + ' 総合スコア: ' + a.total + ' / 100点 【 ' + a.grade + ' 判定 】\n'
    + '========================================\n'
    + axLines.join('\n') + '\n'
    + '----------------------------------------\n'
    + (findLines.length ? '■ 主な減点ポイント\n' + findLines.join('\n') + '\n\n' : '')
    + '※ご注意ください\n'
    + '本診断はページのHTMLを機械的に解析した「簡易版」です。\n'
    + '検索順位・AI検索(ChatGPT/Perplexity等)での実際の被引用状況・\n'
    + '表示速度の実測・競合との比較は、簡易版では確認できません。\n\n'
    + '■ 精密診断(無料)のご案内\n'
    + '無料相談をお申し込みいただいた方には、専門スタッフによる精密診断として\n'
    + '  ・AI検索での実際の被引用・言及状況の調査\n'
    + '  ・競合サイトとの比較と勝ち筋の特定\n'
    + '  ・改善の優先順位と概算効果(何から直すと一番伸びるか)\n'
    + 'までレポートいたします。簡易版とは精度が大きく異なります。\n\n'
    + '▼ 精密診断つき無料相談を予約する\n'
    + calendly + '\n\n'
    + '営業のお電話はいたしません。' + CONFIG.SLA_TEXT + 'にご返信いたします。';
}

/** 全メール共通フッター(特定電子メール法: 送信者表示 + 配信停止導線) */
function mailFooter_() {
  const unsubscribe = getProp_('UNSUBSCRIBE_URL') || 'https://lp.7senses.co.jp/unsubscribe/';
  return '\n\n'
    + '━━━━━━━━━━━━━━━━━━━━━━━━\n'
    + CONFIG.COMPANY_NAME + '\n'
    + CONFIG.COMPANY_ADDRESS + '\n'
    + 'TEL: ' + CONFIG.COMPANY_TEL + '\n'
    + 'Mail: ' + CONFIG.COMPANY_EMAIL + '\n'
    + '━━━━━━━━━━━━━━━━━━━━━━━━\n'
    + '本メールは、当社Webサイトのフォームよりご送信いただいた方へ\n'
    + '自動でお送りしています。\n'
    + '今後、当社からのご案内メールが不要な場合は、下記より配信停止の\n'
    + 'お手続きをお願いいたします(本メールに「配信停止」とご返信\n'
    + 'いただく形でも承ります)。\n'
    + '配信停止: ' + unsubscribe + '\n';
}

// =========================================================================
// 配信停止(特定電子メール法対応)
//   「unsubscribe」シートに記録し、以後の案内メール送信前にこのシートを照合する
// =========================================================================

function handleUnsubscribe_(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('unsubscribe');
  if (!sheet) {
    sheet = ss.insertSheet('unsubscribe');
    sheet.appendRow(['日時', 'メール']);
    sheet.setFrozenRows(1);
  }
  // 既登録チェック
  const last = sheet.getLastRow();
  if (last >= 2) {
    const emails = sheet.getRange(2, 2, last - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); });
    if (emails.indexOf(email) !== -1) { sendUnsubscribeConfirm_(email); return; }
  }
  sheet.appendRow([new Date(), email]);
  sendUnsubscribeConfirm_(email);
  // 管理者への軽い通知(失敗しても停止処理自体は完了扱い)
  try {
    const admin = getProp_('ADMIN_EMAIL') || CONFIG.ADMIN_EMAIL_DEFAULT;
    if (admin) MailApp.sendEmail({ to: admin, subject: '【配信停止】' + email, body: '配信停止の登録がありました: ' + email, name: CONFIG.MAIL_SENDER_NAME });
  } catch (err) {}
}

function sendUnsubscribeConfirm_(email) {
  MailApp.sendEmail({
    to: email,
    subject: '【手続き完了】配信停止を承りました|' + CONFIG.COMPANY_NAME,
    body: '配信停止のお手続きが完了しました。\n'
      + '今後、当社からのご案内メールはお送りいたしません。\n'
      + '(お問い合わせへの返信など、お取引に必要なご連絡は除きます)\n\n'
      + 'ご利用ありがとうございました。\n\n'
      + '━━━━━━━━━━━━━━━━━━━━━━━━\n'
      + CONFIG.COMPANY_NAME + '\n' + CONFIG.COMPANY_ADDRESS + '\nTEL: ' + CONFIG.COMPANY_TEL + '\n',
    name: CONFIG.MAIL_SENDER_NAME
  });
}

/** 案内メール送信前の照合用: 配信停止済みなら true */
function isUnsubscribed_(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('unsubscribe');
  if (!sheet || sheet.getLastRow() < 2) return false;
  const emails = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); });
  return emails.indexOf(String(email).toLowerCase()) !== -1;
}

// =========================================================================
// ステップメール自動送信(COOLリード=資料DLのみの方へ週1×3通)
//   導入: GASエディタで setupStepMailTrigger() を1回実行(毎日10時に判定)
//   仕組み: leadsシートの download リードを stepmail シートで進行管理し、
//           前回送信から7日経過ごとに 1通目→2通目→3通目 を自動送信。
//           配信停止(unsubscribeシート)登録者へは送らない。
// =========================================================================

const STEPMAIL = {
  SHEET: 'stepmail',
  INTERVAL_DAYS: 7,      // 送信間隔
  MAX_PER_RUN: 30,       // 1回の実行での最大送信数(クォータ保護)
  LOOKBACK_DAYS: 120     // これより古いリードは対象外
};

function setupStepMailTrigger() {
  // 二重登録防止
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runStepMails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runStepMails').timeBased().everyDays(1).atHour(10).create();
  console.log('ステップメールトリガーを登録しました(毎日10時台に判定)');
}

function runStepMails() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const leads = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!leads || leads.getLastRow() < 2) return;

  let sm = ss.getSheetByName(STEPMAIL.SHEET);
  if (!sm) {
    sm = ss.insertSheet(STEPMAIL.SHEET);
    sm.appendRow(['メール', '名前', '送信済みステップ', '最終送信日時']);
    sm.setFrozenRows(1);
  }
  const state = {};
  if (sm.getLastRow() >= 2) {
    sm.getRange(2, 1, sm.getLastRow() - 1, 4).getValues().forEach(function (r, i) {
      state[String(r[0]).toLowerCase()] = { row: i + 2, step: Number(r[2]) || 0, last: r[3] };
    });
  }

  const now = new Date();
  const lookback = now.getTime() - STEPMAIL.LOOKBACK_DAYS * 86400000;
  const rows = leads.getRange(2, 1, leads.getLastRow() - 1, HEADER.length).getValues();
  let sent = 0;

  for (let i = 0; i < rows.length && sent < STEPMAIL.MAX_PER_RUN; i++) {
    const type = String(rows[i][1]);
    if (type !== 'download') continue;                    // 対象はCOOL(資料DLのみ)
    const date = rows[i][0];
    if (!(date instanceof Date) || date.getTime() < lookback) continue;
    const email = String(rows[i][3] || '').trim().toLowerCase();
    const name = String(rows[i][2] || '');
    if (!email || isUnsubscribed_(email)) continue;

    const st = state[email] || { row: 0, step: 0, last: null };
    if (st.step >= 3) continue;                           // 3通完了
    const lastTime = (st.last instanceof Date) ? st.last.getTime() : date.getTime();
    if (now.getTime() - lastTime < STEPMAIL.INTERVAL_DAYS * 86400000) continue;

    try {
      sendStepMail_(email, name, st.step + 1);
      sent++;
      if (st.row) {
        sm.getRange(st.row, 3).setValue(st.step + 1);
        sm.getRange(st.row, 4).setValue(now);
      } else {
        sm.appendRow([email, name, 1, now]);
        state[email] = { row: sm.getLastRow(), step: 1, last: now };
      }
    } catch (err) {
      console.error('ステップメール送信失敗 ' + email + ': ' + err.message);
    }
  }
  console.log('ステップメール送信: ' + sent + '通');
}

/** 文面: automation/docs/ステップメール3通.md と同趣旨(CTA: ①診断 ②事例ブログ ③無料相談) */
function sendStepMail_(email, name, step) {
  const site = getProp_('SITE_URL') || 'https://lp.7senses.co.jp';
  const blog = getProp_('BLOG_URL') || (site + '/blog/');
  const calendly = getProp_('CALENDLY_URL') || (site + '/#contact');
  const to = name ? name + ' 様' : 'ご担当者様';
  let subject, body;
  if (step === 1) {
    subject = '資料はお役に立ちましたか?3分でわかる無料診断のご案内|' + CONFIG.COMPANY_NAME;
    body = to + '\n\n先日は『AI導入補助金 完全ガイド』をご覧いただき、ありがとうございました。\n'
      + '正直に言うと、資料を読んだだけでは「うちの場合はどうなのか」が一番分かりにくいところです。\n\n'
      + 'そこで、8つの質問に答えるだけで補助金活用の適性が5段階で分かる無料診断をご用意しています。\n'
      + '結果はその場で表示され、貴社への処方箋も一緒にお届けします。\n\n'
      + '▼ 3分でできる無料診断\n' + site + '/#diagnosis\n';
  } else if (step === 2) {
    subject = '導入費550万円のうち350万円が補助された計算の内訳|' + CONFIG.COMPANY_NAME;
    body = to + '\n\n' + CONFIG.COMPANY_NAME + 'です。\n\n'
      + '「補助金は気になるが、実際いくら補助されるのか」というご質問を多くいただきます。\n'
      + 'モデルケースでは、導入費550万円に対して補助金350万円が交付され、自己負担は200万円でした\n'
      + '(※補助額は導入内容と審査により変動します)。\n'
      + 'この計算の内訳と、事務作業が月40時間→6時間になった事例の裏側をブログで公開しています。\n\n'
      + '▼ 事例・実務ノウハウ(毎日更新)\n' + blog + '\n';
  } else {
    subject = '令和8年度の公募締切から逆算した準備スケジュールのご案内|' + CONFIG.COMPANY_NAME;
    body = to + '\n\n' + CONFIG.COMPANY_NAME + 'です。このメールがシリーズの最後です。\n\n'
      + '補助金申請で最も多いつまずきは「締切に準備が間に合わない」ことです。\n'
      + 'GビズIDの取得だけで最長2週間かかるため、公募締切から逆算した早めの着手をおすすめします。\n'
      + '「対象になるか」の確認だけなら、Zoom30分の無料相談で完結します。\n'
      + '相談したからといって、お申し込みいただく必要はありません。\n\n'
      + '▼ 無料相談を予約する(営業電話はいたしません)\n' + calendly + '\n';
  }
  MailApp.sendEmail({ to: email, subject: subject, body: body + mailFooter_(), name: CONFIG.MAIL_SENDER_NAME, replyTo: CONFIG.COMPANY_EMAIL });
}

// =========================================================================
// ユーティリティ
// =========================================================================

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function scoreBar_(v) {
  const filled = Math.round(Number(v) / 10);
  let bar = '';
  for (let i = 0; i < 10; i++) bar += (i < filled ? '■' : '□');
  return bar;
}

function ok_() {
  return ContentService.createTextOutput(JSON.stringify({ result: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// =========================================================================
// 手動テスト用(GASエディタから実行して動作確認)
// =========================================================================

// =========================================================================
// サイト無料診断(簡易版)採点エンジン — 100点満点・5軸
//   HTMLの静的解析のみ(順位・AI被引用・CWV実測は含まない=有料/精密診断の領域)
//   コストゼロ: UrlFetchApp の無料枠(2万回/日)内で動作
// =========================================================================

/**
 * @param {string} rawUrl 診断対象URL
 * @return {Object} { ok, url, total, grade, axes:{aio,seo,schema,mobile,trust}(各0-100), findings:[{key,label,got,max,note}] }
 */
function runSiteAudit_(rawUrl) {
  // ---- URL検証(http/https以外・プライベート帯は拒否)----
  const url = rawUrl.trim();
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) return { ok: false, error: 'URLの形式が正しくありません' };
  if (/^https?:\/\/(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/i.test(url)) {
    return { ok: false, error: 'このURLは診断できません' };
  }

  // ---- ページ取得 ----
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (err) {
    return { ok: false, error: 'サイトにアクセスできませんでした。URLをご確認ください' };
  }
  if (res.getResponseCode() >= 400) {
    return { ok: false, error: 'サイトが応答しませんでした(HTTP ' + res.getResponseCode() + ')' };
  }
  const html = res.getContentText() || '';
  const lower = html.toLowerCase();

  // ---- robots.txt / llms.txt 取得(失敗しても診断続行)----
  const origin = url.match(/^https?:\/\/[^\/]+/i)[0];
  const robots = fetchTextQuiet_(origin + '/robots.txt');
  const llms = fetchTextQuiet_(origin + '/llms.txt');

  const F = []; // findings
  const add = function (key, label, got, max, note) { F.push({ key: key, label: label, got: got, max: max, note: note || '' }); };

  // ===== AIO対応(30点)=====
  if (robots === null) {
    add('robots_ai', 'AIクローラー許可(robots.txt)', 6, 8, 'robots.txt未設置。既定では許可扱いですが明示設置を推奨');
  } else if (isAiBlocked_(robots)) {
    add('robots_ai', 'AIクローラー許可(robots.txt)', 0, 8, 'GPTBot等のAIクローラーをブロック中。AI検索に引用されません');
  } else {
    add('robots_ai', 'AIクローラー許可(robots.txt)', 8, 8);
  }
  add('llms', 'llms.txtの設置', (llms !== null && llms.length > 50) ? 8 : 0, 8,
    (llms !== null && llms.length > 50) ? '' : 'AI向けサイト要約ファイルが未設置');
  add('faq_schema', 'FAQ構造化データ', lower.indexOf('faqpage') !== -1 ? 8 : 0, 8,
    lower.indexOf('faqpage') !== -1 ? '' : 'FAQPageスキーマなし。AI検索が回答を引用しにくい状態');
  const firstText = extractFirstParagraph_(html);
  const metaDesc = extractMeta_(html, 'description');
  const hasTeigi = /とは[、,\s]/.test(firstText) || /とは[、,\s]/.test(metaDesc);
  add('teigi', '冒頭の定義文(「〜とは」構造)', hasTeigi ? 6 : 0, 6,
    hasTeigi ? '' : '冒頭に「〜とは」形式の断言文がなく、AIが要約を作りにくい');

  // ===== SEO基礎(25点)=====
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const titleLen = title.trim().length;
  add('title', 'titleタグ', titleLen === 0 ? 0 : (titleLen >= 10 && titleLen <= 45 ? 6 : 3), 6,
    titleLen === 0 ? 'titleタグがありません' : (titleLen < 10 || titleLen > 45 ? '文字数が最適範囲(10〜45字)外' : ''));
  const descLen = metaDesc.trim().length;
  add('desc', 'meta description', descLen === 0 ? 0 : (descLen >= 50 && descLen <= 160 ? 6 : 3), 6,
    descLen === 0 ? '説明文がありません' : (descLen < 50 || descLen > 160 ? '文字数が最適範囲(50〜160字)外' : ''));
  add('canonical', 'canonical設定', /rel=["']canonical["']/i.test(html) ? 4 : 0, 4,
    /rel=["']canonical["']/i.test(html) ? '' : 'URL正規化タグなし。評価が分散する恐れ');
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  add('h1', 'H1見出しの唯一性', h1Count === 1 ? 5 : (h1Count > 1 ? 2 : 0), 5,
    h1Count === 1 ? '' : (h1Count === 0 ? 'H1がありません' : 'H1が' + h1Count + '個あります(1個が原則)'));
  const hasOgTitle = /property=["']og:title["']/i.test(html), hasOgImage = /property=["']og:image["']/i.test(html);
  add('ogp', 'OGP設定', (hasOgTitle && hasOgImage) ? 4 : (hasOgTitle || hasOgImage ? 2 : 0), 4,
    (hasOgTitle && hasOgImage) ? '' : 'SNS・AI検索でのプレビュー情報が不足');

  // ===== 構造化データ(20点)=====
  const hasJsonLd = lower.indexOf('application/ld+json') !== -1;
  add('jsonld', 'JSON-LD構造化データ', hasJsonLd ? 8 : 0, 8, hasJsonLd ? '' : '構造化データが皆無。検索エンジン・AIへの情報提供不足');
  const hasOrg = /"@type"\s*:\s*"(Organization|LocalBusiness|ProfessionalService)/i.test(html);
  add('org', '運営者スキーマ(Organization等)', hasOrg ? 6 : 0, 6, hasOrg ? '' : '運営者情報のスキーマなし(E-E-A-Tシグナル欠落)');
  const typeVariety = countSchemaTypes_(html);
  add('variety', 'スキーマの種類数', typeVariety >= 3 ? 6 : (typeVariety === 2 ? 4 : (typeVariety === 1 ? 2 : 0)), 6,
    typeVariety >= 3 ? '' : '現在' + typeVariety + '種類。FAQ・パンくず・記事等の追加余地あり');

  // ===== モバイル・技術(15点)=====
  add('https', 'HTTPS対応', /^https:/i.test(url) ? 5 : 0, 5, /^https:/i.test(url) ? '' : '非HTTPSは検索・AI双方で大幅マイナス');
  add('viewport', 'モバイルviewport', /name=["']viewport["']/i.test(html) ? 5 : 0, 5,
    /name=["']viewport["']/i.test(html) ? '' : 'モバイル表示設定なし');
  const imgs = html.match(/<img[^>]*>/gi) || [];
  let altOk = 0;
  imgs.forEach(function (t) { if (/alt=["'][^"']+["']/i.test(t)) altOk++; });
  const altRatio = imgs.length === 0 ? 1 : altOk / imgs.length;
  add('alt', '画像altの充足率', altRatio >= 0.8 ? 5 : (altRatio >= 0.5 ? 3 : 0), 5,
    altRatio >= 0.8 ? '' : '画像' + imgs.length + '枚中alt付き' + altOk + '枚。AIは画像内容を読めません');

  // ===== 信頼性(10点)=====
  const hasCompany = /(〒\s*\d{3}-?\d{4})|会社概要|運営者|運営会社|特定商取引/.test(html);
  add('company', '運営者情報の明示', hasCompany ? 5 : 0, 5, hasCompany ? '' : '住所・会社概要が見当たらない(E-E-A-T減点要因)');
  const hasFresh = /(dateModified|datePublished)/i.test(html) || /<time[\s>]/i.test(html) || /202[5-9]年/.test(html);
  add('fresh', '情報鮮度の明示', hasFresh ? 5 : 0, 5, hasFresh ? '' : '更新日・鮮度表示なし。AIは古い情報を引用しません');

  // ---- 集計 ----
  const AXIS_MAP = { aio: ['robots_ai', 'llms', 'faq_schema', 'teigi'], seo: ['title', 'desc', 'canonical', 'h1', 'ogp'],
    schema: ['jsonld', 'org', 'variety'], mobile: ['https', 'viewport', 'alt'], trust: ['company', 'fresh'] };
  const axes = {}; let total = 0;
  for (const ax in AXIS_MAP) {
    let got = 0, max = 0;
    AXIS_MAP[ax].forEach(function (k) {
      const f = F.filter(function (x) { return x.key === k; })[0];
      if (f) { got += f.got; max += f.max; }
    });
    axes[ax] = Math.round(got / max * 100);
    total += got;
  }
  const grade = total >= 90 ? 'S' : total >= 75 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : 'D';

  return { ok: true, url: url, total: total, grade: grade, axes: axes,
    findings: F.filter(function (f) { return f.got < f.max; }) };
}

// ---- 補助関数 ----

function fetchTextQuiet_(url) {
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return r.getResponseCode() < 400 ? r.getContentText() : null;
  } catch (err) { return null; }
}

/** robots.txt で主要AIクローラー(または全UA)が Disallow: / になっているか */
function isAiBlocked_(robots) {
  const AI_BOTS = ['gptbot', 'claudebot', 'perplexitybot', 'google-extended'];
  const groups = robots.toLowerCase().split(/\n(?=user-agent\s*:)/);
  return groups.some(function (g) {
    const uaMatch = AI_BOTS.some(function (b) { return g.indexOf('user-agent:') !== -1 && g.indexOf(b) !== -1; })
      || /user-agent\s*:\s*\*/.test(g);
    return uaMatch && /disallow\s*:\s*\/\s*($|\n)/.test(g);
  });
}

function extractMeta_(html, name) {
  const m = html.match(new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'))
    || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']' + name + '["\']', 'i'));
  return m ? m[1] : '';
}

function extractFirstParagraph_(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const m = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').slice(0, 300) : '';
}

function countSchemaTypes_(html) {
  const KNOWN = ['Organization', 'LocalBusiness', 'ProfessionalService', 'FAQPage', 'Article', 'BlogPosting',
    'BreadcrumbList', 'WebSite', 'Person', 'Service', 'Product', 'HowTo'];
  let n = 0;
  KNOWN.forEach(function (t) {
    if (new RegExp('"@type"\\s*:\\s*"' + t + '"', 'i').test(html)) n++;
  });
  return n;
}

// GASエディタから実行してサイト診断を動作確認
function testSiteAudit() {
  const result = runSiteAudit_('https://www.7senses.co.jp/');
  console.log(JSON.stringify(result, null, 2));
}

function testDiagnosisSubmission() {
  const e = {
    postData: {
      contents: JSON.stringify({
        type: 'diagnosis',
        name: 'テスト太郎',
        email: 'test@example.com',
        company: 'テスト設備工事株式会社',
        message: '',
        diagnosis: {
          answers: [3, 2, 4, 1, 3, 2, 4, 3],
          scores: { hojokin: 78, ai: 45, digital: 60, shukyaku: 52, suishin: 70 },
          grade: 'A'
        },
        website: '',
        ts: Date.now() - 60000
      })
    }
  };
  const res = doPost(e);
  console.log(res.getContent());
}
