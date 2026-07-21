# セブンセンシズ株式会社 AI導入補助金LP プロジェクト

> 一点突破キーワード:「AI導入補助金」/ 詳細は [戦略設計書.md](戦略設計書.md)

## 構成

| パス | 内容 |
|---|---|
| [index.html](index.html) | LP本体(16セクション・完結HTML1枚。適性診断8問+**Webサイト簡易診断(URL入力・100点満点)**・フォーム・JSON-LD 5種・計測イベント内蔵) |
| [robots.txt](robots.txt) | AIクローラー(GPTBot/ClaudeBot/PerplexityBot/Google-Extended)許可 |
| [llms.txt](llms.txt) | LLMO用サイト要約 |
| [sitemap.xml](sitemap.xml) | lastmodは更新時のみ変更 |
| [blog/](blog/) | ブログ一覧+記事6本(静的版。blog-system稼働後は自動生成へ移行)+[_template.html](blog/_template.html) |
| [privacy/](privacy/) | プライバシーポリシー(フォーム運用の前提) |
| [downloads/ai-hojokin-guide-2026.pdf](downloads/ai-hojokin-guide-2026.pdf) | ホワイトペーパー『AI導入補助金 完全ガイド 令和8年度版』(A4×8p。GASの WHITEPAPER_URL に設定) |
| ogp.png / logo.png / favicon.png | OGP画像(1200×630)・ロゴ(512×512)・favicon |
| [assets/img/](assets/img/) | 写真素材(Unsplash License=商用利用可・クレジット不要)。WebP変換済み・全て150KB以下。元jpgも同梱 |
| [戦略設計書.md](戦略設計書.md) | プロンプト0成果物(キーワード選定・LT100本・ペルソナ・数値目標) |
| [blog-system/](blog-system/) | 毎日ブログ自動更新システム(プロンプトB。GitHub Actions+品質採点ループ+安全ゲート) |
| [automation/](automation/) | リード自動化(プロンプトC。GAS完成コード+ステップメール)+計測改善90日運用(プロンプトD) |

## 公開前に必須の残作業

1. **ドメイン確定** — 全ファイルの `lp.7sensesplus.com` を実ドメインに置換
2. **「仮」コメント箇所の差し替え**(index.html内を `仮` で検索)— 代表者名・略歴・事例・お客様の声・価格・採択率98%等の算出根拠。**架空実績のままの公開は景表法リスク**
3. **GAS デプロイ** — [automation/docs/リード対応自動化セットアップ.md](automation/docs/リード対応自動化セットアップ.md) の手順後、index.html の `GAS_ENDPOINT` にURLを設定(未設定でもLPは動作、送信はconsole出力のみ)。WHITEPAPER_URL には `/downloads/ai-hojokin-guide-2026.pdf` の絶対URLを設定
4. **GA4 / Search Console** — index.html の G-XXXXXXXXXX を差し替えてコメント解除、GSC登録+sitemap送信
5. **ブログ記事の事実確認** — blog/ 配下6本の制度記述・数値を最新の公募要領と突合(静的版。以降の新規記事は blog-system で自動生成)
6. **ブログ自動化の稼働** — [blog-system/README.md](blog-system/README.md) 参照(リポジトリ作成・Secrets設定・Astro組込み)

## Webサイト簡易診断(URL入力)の仕組み

- 採点エンジンは [automation/gas/form-endpoint.gs](automation/gas/form-endpoint.gs) の `runSiteAudit_()`(`GET ?action=audit&url=...`)。**GAS無料枠(UrlFetchApp 2万回/日)内で動作し追加費用ゼロ**
- 15項目チェック → 100点満点+5軸(AIO対応30/SEO基礎25/構造化データ20/モバイル15/信頼性10)+S〜D判定+減点理由
- リード動線: URL入力 → 裏で解析しつつ連絡先ゲート → 結果表示(温度=HOTでSlack/メール通知、控えを自動返信)
- **簡易版の注記を入力画面・結果画面・自動返信メールの3箇所に明示**し、「順位・AI被引用の実測・競合比較は精密診断(無料相談)で」の誘導を組み込み済み
- `GAS_ENDPOINT` 未設定時はモック結果(console.warnで警告)。**本番前に必ずGASをデプロイしてURLを設定すること**

## 検証済み

- Playwright実機テスト合格: H1唯一性/診断8問→リードゲート→レーダー表示/URL診断フロー/フォームバリデーション→送信→サンクス/モバイル375pxで横スクロールなし/コンソールエラーゼロ
- 全10ページ(LP・ブログ7・privacy・unsubscribe)で内部リンク切れゼロ・JSON-LD構文正常・プレースホルダ残存ゼロを機械検証済み
- bot対策動作: ハニーポット+3秒ルール+連投制限30秒
- GASコード(リード受付+サイト診断+配信停止)構文チェック合格
