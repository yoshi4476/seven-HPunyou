# -*- coding: utf-8 -*-
"""公開用 dist/ を生成する(内部資料を除外して配信対象だけをコピー)
   使い方: python tools/make_dist.py  →  npx wrangler pages deploy dist"""
import re
import shutil
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# 公開するもの(これ以外はデプロイされない)
PUBLIC_DIRS = ["assets", "blog", "service", "about", "privacy", "unsubscribe", "external", "downloads", "youkou", "images", "industry", "seido", "research", "compare", "glossary", "topics"]
PUBLIC_FILES = ["index.html", "404.html", "_headers", "_redirects", "robots.txt", "llms.txt", "sitemap.xml",
                "favicon.png", "logo.png", "ogp.png",
                # Bing Webmaster Tools の所有権の確認（ドメイン直下で配信されないと確認できない）
                "BingSiteAuth.xml",
                # 配信済み原稿の指紋。管制塔側がこれを読んで「届いたか」を確かめる。
                # dist へ入れていなかったため、配信しても毎週「未達」と報告され続けていた
                "article-manifest.json"]
# 公開ディレクトリ内でも除外するもの
# ※特典PDF2冊はZoom無料相談の参加特典のため公開配信しない(スタッフがZoom内で手渡し)
EXCLUDE_NAMES = {"_template.html", "chatgpt-starter-kit.pdf", "hojokin-checklist.pdf", "gbp-checksheet.pdf"}
EXCLUDE_SUFFIX = {".jpg"}  # assets/img の元jpgは配信不要(webpのみ配信)

if DIST.exists():
    shutil.rmtree(DIST)
DIST.mkdir()

copied = 0
# Search Console の所有権確認ファイル (google*.html) はルート直下に置けば自動で配信対象にする
PUBLIC_FILES += [f.name for f in ROOT.glob("google*.html")]
# IndexNow の鍵ファイル (英数字だけの .txt)。ドメイン直下で配信されていないと通知が拒否される。
# 実際、鍵を置いたのに dist へ入らず、公開した記事を検索エンジンへ知らせられていなかった
PUBLIC_FILES += [f.name for f in ROOT.glob("*.txt")
                 if re.fullmatch(r"[0-9a-f]{16,64}", f.stem)]

for name in PUBLIC_FILES:
    src = ROOT / name
    if src.is_file():
        shutil.copy2(src, DIST / name)
        copied += 1

for d in PUBLIC_DIRS:
    src = ROOT / d
    if not src.is_dir():
        continue
    for f in src.rglob("*"):
        if not f.is_file():
            continue
        if f.name in EXCLUDE_NAMES or f.suffix.lower() in EXCLUDE_SUFFIX:
            continue
        dest = DIST / f.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest)
        copied += 1


def verify(dist=DIST):
    """sitemap に載せたのに配信物に無いページと、日本語Webフォントの再混入と、送れたかを確かめない送り方を数える。
    2026-10-03: /seido/ を作って sitemap に載せたが PUBLIC_DIRS に足し忘れ、本番は404だった。
    2026-10 前半: ブログの生成テンプレートが Google Fonts を読み、モバイルの LCP が13秒だった。
    2026-10-07: 相談・診断を返事を読まない送り方（no-cors）で受付へ送り、通信が切れても「送信ありがとうございました」と
    出して問い合わせとして数えていた"""
    bad = []
    sm = dist / "sitemap.xml"
    if sm.is_file():
        for loc in re.findall(r"<loc>https?://[^/<]+(/[^<]*)</loc>", sm.read_text(encoding="utf-8")):
            rel = loc.strip("/")
            cands = [dist / rel / "index.html", dist / f"{rel}.html", dist / rel] if rel else [dist / "index.html"]
            if not any(c.is_file() for c in cands):
                bad.append(f"404になる: {loc}")
    for f in dist.rglob("*.html"):
        text = f.read_text(encoding="utf-8", errors="ignore")
        if "fonts.googleapis.com" in text:
            bad.append(f"Google Fonts を読んでいる: {f.relative_to(dist)}")
        if "script.google.com/macros" in text and re.search(r"mode\s*:\s*['\"]no-cors", text):
            bad.append(f"送れたかを確かめない送り方（no-cors）で受付へ送っている: {f.relative_to(dist)}")
    return bad


problems = verify()
if problems:
    print(f"配信を止めます（{len(problems)}件）:")
    for p in problems[:30]:
        print("  " + p)
    sys.exit(1)

total_mb = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) / 1024 / 1024
print(f"dist/ 生成完了: {copied} ファイル / {total_mb:.1f} MB")
print("除外済み: blog-system/ automation/ 資料/ 戦略設計書.md README.md _template.html 元jpg")
