# -*- coding: utf-8 -*-
"""月次レポート等のMarkdownをブランドスタイルのPDFへ変換する汎用ツール
   使い方: python tools/report_pdf.py <入力md> [出力pdf]
   要: pip install markdown playwright && playwright install chromium"""
import re
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from pathlib import Path

import markdown as md_lib
from playwright.sync_api import sync_playwright

STYLE = """
:root{--navy:#1d3461;--gold2:#d9b36a;--muted:#5b6472;--line:#e2ddd0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Noto Sans JP",sans-serif;color:#22242a;font-size:10pt;line-height:1.85;padding:14mm 16mm}
h1{font-family:"Shippori Mincho B1",serif;font-weight:800;font-size:18pt;color:#fff;background:linear-gradient(160deg,#132445,#1d3461 55%,#24427c);border-radius:4mm;padding:9mm 10mm;line-height:1.5;margin-bottom:6mm}
h2{font-family:"Shippori Mincho B1",serif;font-weight:800;font-size:13pt;color:var(--navy);border-left:5px solid var(--gold2);padding-left:4mm;margin:8mm 0 3mm;page-break-after:avoid}
h3{font-size:11pt;color:var(--navy);margin:4mm 0 1.5mm;page-break-after:avoid}
p{margin:2mm 0}
table{width:100%;border-collapse:collapse;margin:3mm 0;font-size:9pt;page-break-inside:avoid}
th,td{border:1px solid var(--line);padding:2mm 3mm;text-align:left;vertical-align:top}
th{background:var(--navy);color:#fff;font-weight:700}
ol,ul{margin:2mm 0 2mm 6mm}
li{margin:1mm 0}
strong{color:var(--navy)}
hr{border:none;border-top:1px solid var(--line);margin:5mm 0}
em{color:var(--muted);font-size:9pt;font-style:normal}
pre,code{font-family:"Noto Sans JP",sans-serif}
pre{background:#f4f1e9;border:1px solid var(--line);border-radius:2mm;padding:3mm 4mm;font-size:9pt;white-space:pre-wrap;page-break-inside:avoid}
"""

FONTS = ('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700'
         '&family=Shippori+Mincho+B1:wght@800&family=Oswald:wght@500;600&display=swap" rel="stylesheet">')


def main():
    src = Path(sys.argv[1]).resolve()
    out = (Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".pdf")).resolve()
    text = re.sub(r"<!--[\s\S]*?-->", "", src.read_text(encoding="utf-8"))
    body = md_lib.markdown(text, extensions=["tables", "fenced_code"])
    html = f'<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">{FONTS}<style>{STYLE}</style></head><body>{body}</body></html>'
    tmp = out.with_suffix(".tmp.html")
    tmp.write_text(html, encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        pg = b.new_page()
        pg.goto(tmp.as_uri())
        pg.wait_for_load_state("networkidle")
        pg.wait_for_timeout(1200)
        pg.pdf(path=str(out), format="A4", print_background=True,
               margin={"top": "10mm", "bottom": "12mm", "left": "0", "right": "0"})
        b.close()
    tmp.unlink()
    print(f"生成: {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
