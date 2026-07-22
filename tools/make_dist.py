# -*- coding: utf-8 -*-
"""公開用 dist/ を生成する(内部資料を除外して配信対象だけをコピー)
   使い方: python tools/make_dist.py  →  npx wrangler pages deploy dist"""
import shutil
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# 公開するもの(これ以外はデプロイされない)
PUBLIC_DIRS = ["assets", "blog", "service", "about", "privacy", "unsubscribe", "external", "downloads"]
PUBLIC_FILES = ["index.html", "404.html", "_headers", "robots.txt", "llms.txt", "sitemap.xml",
                "favicon.png", "logo.png", "ogp.png"]
# 公開ディレクトリ内でも除外するもの
# ※特典PDF2冊はZoom無料相談の参加特典のため公開配信しない(スタッフがZoom内で手渡し)
EXCLUDE_NAMES = {"_template.html", "chatgpt-starter-kit.pdf", "hojokin-checklist.pdf", "gbp-checksheet.pdf"}
EXCLUDE_SUFFIX = {".jpg"}  # assets/img の元jpgは配信不要(webpのみ配信)

if DIST.exists():
    shutil.rmtree(DIST)
DIST.mkdir()

copied = 0
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

total_mb = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) / 1024 / 1024
print(f"dist/ 生成完了: {copied} ファイル / {total_mb:.1f} MB")
print("除外済み: blog-system/ automation/ 資料/ 戦略設計書.md README.md _template.html 元jpg")
