# -*- coding: utf-8 -*-
"""blog-system が生成した Markdown 記事を、サイトの記事HTML (blog/<slug>/index.html) に変換する。

対象: blog-system/content/publish-queue/*.md (安全ゲート通過済みの公開確定記事)
使用テンプレート: blog/_template.html ({{...}} プレースホルダ差し替え)
画像: blog-system/public/images/blog/<slug>/ → images/blog/<slug>/ へコピー
実行後は tools/gen_blog_pages.py (一覧・カテゴリ・sitemap再生成) を続けて実行すること。

実行: python tools/render_blog.py   (要: pip install markdown)
"""
import json
import re
import shutil
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from pathlib import Path

import markdown as md_lib

ROOT = Path(__file__).resolve().parent.parent
QUEUE = ROOT / "blog-system" / "content" / "publish-queue"
POSTED = ROOT / "blog-system" / "content" / "posted"
IMG_SRC = ROOT / "blog-system" / "public" / "images" / "blog"
TEMPLATE = (ROOT / "blog" / "_template.html").read_text(encoding="utf-8")

CAT_NAME = {"hojokin": "補助金", "aio": "AIO", "meo": "MEO", "dev": "システム開発"}
CTA = {
    "hojokin": ("補助金が使えるか、3分で確認しませんか?",
                "無料診断(8問)と無料相談(Zoom30分)で、対象かどうか・いくら補助されそうかをその場でお答えします。営業電話はいたしません。"),
    "aio": ("AI検索に「引用される」サイトへ。",
            "無料のサイト診断(URL入力)で現在地をスコア化。改善の優先順位は無料相談でご提案します。"),
    "meo": ("Googleマップ集客、まず現在地を無料診断。",
            "MEO無料診断(6問)と無料相談(Zoom30分)で、貴社の商圏で何から直すべきかをお答えします。"),
    "dev": ("その手作業、システム化+補助金で。",
            "AI活用無料診断(6問)と無料相談(Zoom30分)で、どの業務から自動化すると効くかをご提案します。"),
}


def parse_frontmatter(text):
    m = re.match(r"^---\n([\s\S]*?)\n---\n?", text)
    fm = {}
    if m:
        for line in m.group(1).split("\n"):
            kv = re.match(r'^(\w+):\s*"?(.*?)"?\s*$', line)
            if kv:
                fm[kv.group(1)] = kv.group(2)
    return fm, text[m.end():] if m else text


def md_to_html(text):
    return md_lib.markdown(text, extensions=["tables"])


def esc_json(s):
    return json.dumps(s, ensure_ascii=False)[1:-1]


def render_article(md_path):
    raw = md_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(raw)
    slug = fm.get("slug") or md_path.stem
    title = fm.get("title", slug)
    desc = fm.get("description", "")
    cat = fm.get("category", "hojokin")
    date_iso = fm.get("date", "")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_iso):
        raise ValueError(f"{slug}: date が不正 ({date_iso})")
    y, mo, d = date_iso.split("-")
    date_jp = f"{y}.{mo}.{d}"
    date_ym = f"{y}年{int(mo)}月"

    # ---- 本文をH2セクションに分解 ----
    parts = re.split(r"^## +", body, flags=re.M)
    lead_block = parts[0]
    sections = []  # (見出し, 本文)
    for p in parts[1:]:
        nl = p.find("\n")
        sections.append((p[:nl].strip(), p[nl + 1:]))

    # ---- リード処理: 鮮度表示・対象者・目次を除去し、断言文を抽出 ----
    target = "中小企業の経営者・担当者"
    tm = re.search(r"この記事は[、\s]*(.+?)向けです", lead_block)
    if tm:
        target = re.sub(r"[*_「」<>]", "", tm.group(1)).strip()
    lead_lines = []
    for line in lead_block.split("\n"):
        s = line.strip()
        if not s:
            lead_lines.append("")
            continue
        if re.search(r"本記事は.*時点の情報", s) or re.search(r"この記事は.*向けです", s):
            continue
        if re.match(r"^[-*] *\[", s) or re.match(r"^#{1,3} *目次", s) or s == "目次":
            continue
        lead_lines.append(line)
    lead_md = "\n".join(lead_lines).strip()
    lead_html = re.sub(r"^<p>|</p>$", "", md_to_html(lead_md).strip(), flags=re.S) if lead_md else desc

    # ---- FAQセクション抽出 ----
    faq_html, faq_jsonld = "", []
    body_sections = []
    for h, content in sections:
        if "目次" in h:
            continue
        if "よくある質問" in h or re.search(r"FAQ", h, re.I):
            qa = re.split(r"^### +", content, flags=re.M)
            for block in qa[1:]:
                nl = block.find("\n")
                q = block[:nl].strip()
                a = re.sub(r"<[^>]+>", "", md_to_html(block[nl + 1:]).strip())
                a = re.sub(r"\s+", " ", a).strip()
                if q and a:
                    faq_html += (f"    <details>\n      <summary>{q}</summary>\n"
                                 f'      <div class="a">{a}</div>\n    </details>\n')
                    faq_jsonld.append(
                        '{ "@type": "Question", "name": "%s", "acceptedAnswer": { "@type": "Answer", "text": "%s" } }'
                        % (esc_json(q), esc_json(a[:120])))
            continue
        body_sections.append((h, content))

    if not faq_jsonld:  # FAQが無い記事でも構造化データが壊れないよう最低1問を合成
        q = f"{title.split('|')[0].strip()}の相談はできますか?"
        a = "はい。無料相談(オンライン30分)で個別にお答えします。営業のお電話はいたしません。"
        faq_html = f'    <details>\n      <summary>{q}</summary>\n      <div class="a">{a}</div>\n    </details>\n'
        faq_jsonld.append('{ "@type": "Question", "name": "%s", "acceptedAnswer": { "@type": "Answer", "text": "%s" } }'
                          % (esc_json(q), esc_json(a)))

    # ---- 本文HTML + 目次 ----
    toc_items, body_html = [], []
    for i, (h, content) in enumerate(body_sections, 1):
        sec_id = f"sec{i}"
        h_clean = re.sub(r"<[^>]+>", "", h)
        toc_items.append(f'<li><a href="#{sec_id}">{h_clean}</a></li>')
        body_html.append(f'<h2 id="{sec_id}">{h_clean}</h2>\n' + md_to_html(content))
    if not body_sections:
        raise ValueError(f"{slug}: H2セクションが見つからない")

    read_min = max(3, round(len(re.sub(r"<[^>]+>", "", "".join(body_html))) / 600))
    cta_t, cta_d = CTA.get(cat, CTA["hojokin"])

    # ---- 関連記事 (同カテゴリの既存記事から最新3本) ----
    related = []
    for d_ in (ROOT / "blog").iterdir():
        f = d_ / "index.html"
        if not d_.is_dir() or not f.is_file() or d_.name in ("category", slug):
            continue
        c = f.read_text(encoding="utf-8")
        cm = re.search(r'<span class="cat">(.*?)</span>', c)
        dm = re.search(r'"datePublished":\s*"(\d{4}-\d{2}-\d{2})"', c)
        t2 = re.search(r"<title>(.*?)[||]", c)
        if cm and dm and t2 and cm.group(1).strip() == CAT_NAME.get(cat, "補助金"):
            related.append((dm.group(1), d_.name, t2.group(1).strip()))
    related.sort(reverse=True)
    related_html = "\n".join(f'<li><a href="/blog/{s}/">{t}</a></li>' for _, s, t in related[:3]) \
        or f'<li><a href="/blog/">ブログ記事一覧へ</a></li>'

    html = TEMPLATE
    for k, v in {
        "TITLE": title, "TITLE_SHORT": title[:14] + ("…" if len(title) > 14 else ""),
        "SLUG": slug, "DESCRIPTION": desc, "CATEGORY": CAT_NAME.get(cat, "補助金"),
        "DATE_ISO": date_iso, "DATE_JP": date_jp, "DATE_YM": date_ym,
        "READ_MIN": str(read_min), "TARGET": target, "LEAD_DANGEN": lead_html,
        "TOC_ITEMS": "".join(toc_items), "BODY": "\n".join(body_html),
        "FAQ_HTML": faq_html, "FAQ_JSONLD": ",\n      ".join(faq_jsonld),
        "RELATED_LINKS": related_html, "CTA_TITLE": cta_t, "CTA_DESC": cta_d,
    }.items():
        html = html.replace("{{" + k + "}}", v)
    leftover = re.findall(r"\{\{[A-Z_]+\}\}", html)
    if leftover:
        raise ValueError(f"{slug}: 未置換プレースホルダ {leftover}")

    # 生成済みサムネイルがあれば、OGP画像を記事固有のものに差し替える
    if (IMG_SRC / slug / "thumbnail.png").is_file() or (ROOT / "images" / "blog" / slug / "thumbnail.png").is_file():
        html = html.replace(
            'content="https://lp.7senses.co.jp/ogp.png"',
            f'content="https://lp.7senses.co.jp/images/blog/{slug}/thumbnail.png"')

    out = ROOT / "blog" / slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")

    # ---- 記事画像のコピー ----
    src_img = IMG_SRC / slug
    if src_img.is_dir():
        dest_img = ROOT / "images" / "blog" / slug
        dest_img.mkdir(parents=True, exist_ok=True)
        for f in src_img.iterdir():
            shutil.copy2(f, dest_img / f.name)
    return slug


def main():
    targets = sorted(QUEUE.glob("*.md")) if QUEUE.is_dir() else []
    if not targets:
        print("[render] publish-queue に記事なし → スキップ")
        return
    done = []
    for f in targets:
        try:
            done.append(render_article(f))
            print(f"[render] 生成: blog/{done[-1]}/index.html")
        except Exception as e:
            print(f"[render] 失敗 (スキップして続行): {f.name}: {e}")
    print(f"[render] 完了: {len(done)}/{len(targets)} 記事")


if __name__ == "__main__":
    main()
