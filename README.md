# セブンセンシズ株式会社 AI導入補助金LP

> 公開サイト: https://lp.7senses.co.jp — AI導入補助金(IT導入補助金)の申請サポートを軸にしたリード獲得サイト。
> フレームワーク非依存の静的HTMLと、記事を毎日自動生成・自動公開するパイプラインで構成しています。

## 構成

| パス | 内容 |
|---|---|
| [index.html](index.html) | LP本体(完結HTML1枚。無料診断4種・フォーム・JSON-LD・計測イベント内蔵) |
| [service/](service/) | サービス別ページ(補助金申請サポート/システム開発/AIO/MEO) |
| [youkou/](youkou/) | AI導入補助金の要項・必要書類まとめ |
| [about/](about/) | 会社案内・代表挨拶 |
| [blog/](blog/) | ブログ一覧・記事(補助金カテゴリ専門)+[_template.html](blog/_template.html) |
| [blog-system/](blog-system/) | ブログ自動生成システム(生成→品質採点ループ→安全ゲート→公開)。詳細は [blog-system/README.md](blog-system/README.md) |
| [automation/](automation/) | リード受付の Google Apps Script + 運用ドキュメント |
| [tools/](tools/) | 記事HTML変換・一覧生成・配布物生成・PDF出力のPythonスクリプト |
| [client-config.json](client-config.json) | 会社情報・呼称ルール・実績表記の中央設定(自動生成系はすべてここを参照) |
| [robots.txt](robots.txt) / [llms.txt](llms.txt) / [sitemap.xml](sitemap.xml) | AIクローラー許可・LLM向けサイト要約・サイトマップ |
| [_redirects](_redirects) | 廃止ページの301(Cloudflare Pages) |

## デプロイ

Cloudflare Pages(プロジェクト `seven-hpunyou` / 直接アップロード方式)。

```bash
python tools/make_dist.py   # 内部資料を除外した dist/ を生成
npx wrangler pages deploy dist --project-name seven-hpunyou --branch master --commit-dirty=true
```

`CLOUDFLARE_API_TOKEN`(Pages:Edit)と `CLOUDFLARE_ACCOUNT_ID` を環境変数で渡します。
DNSはお名前.comで CNAME `lp` → `seven-hpunyou.pages.dev`。

## ブログ自動化

[.github/workflows/auto-publish.yml](.github/workflows/auto-publish.yml) が毎日実行します。

| タイミング | 内容 |
|---|---|
| JST 7:00 | 本流記事2本を生成・公開 |
| JST 17:00 | ニュース型記事1本 |
| 日曜 JST 7:30 | 既存記事1本を最新化リライト |

パイプラインは 構成生成 → 執筆 → 推敲 → **品質採点ループ(SEO・AIOの二軸で85点以上が公開条件)** → 図解生成 → 安全ゲート(景表法・出典・リンク実在性など12項目)→ HTML化 → デプロイ → 検索エンジン通知。
不合格記事は同日中に自動修正して再審査します(2周目パイプライン)。

生成時の実績表記・呼称は [client-config.json](client-config.json) で一元管理し、機械チェックで逸脱を検出します。

## 未接続の外部サービス

以下は設定待ちで、未設定でもサイト自体は動作します。

- **Google Apps Script**: フォーム送信先。`GAS_ENDPOINT` 未設定の間はモック動作(送信内容はconsole出力のみ)
- **GA4 / Search Console**: 計測タグと月次レポート([.github/workflows/monthly-report.yml](.github/workflows/monthly-report.yml))のデータ源

## 検証

- Playwright実機テスト: H1唯一性 / 診断フロー / フォームバリデーション / モバイル375pxで横スクロールなし / コンソールエラーゼロ
- 全ページで内部リンク切れゼロ・JSON-LD構文正常を機械検証
- bot対策: ハニーポット + 3秒ルール + 連投制限30秒
