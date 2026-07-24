# -*- coding: utf-8 -*-
"""ブログ一覧・カテゴリ別一覧(4種)・sitemap.xml を記事ファイルから自動生成
   再実行可能: 記事が増えたらこのスクリプトを再実行するだけで全一覧が更新される"""
import sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOMAIN = "https://lp.7senses.co.jp"

CATS = {  # 表示名 → (slug, ハブページ, 説明)
    "補助金": ("hojokin", "/service/hojokin/", "IT導入補助金(AI導入補助金)の申請実務・採択のコツ"),
    "AIO": ("aio", "/service/aio/", "AI検索(ChatGPT・Perplexity・AI Overview)に引用されるサイト作り"),
    "MEO": ("meo", "/service/meo/", "Googleマップ・ビジネスプロフィールの集客最適化"),
    "システム開発": ("dev", "/service/dev/", "業務システム開発・生成AIの業務活用"),
}
THUMB_DIM = {"calculator-t": (640, 427), "documents-t": (640, 427), "chip-t": (640, 427),
             "osaka-t": (640, 960), "paperwork-t": (640, 367), "analytics-t": (640, 456)}
SLUG_THUMB = {  # 既存6本は従来どおり
    "ai-hojokin-guide-2026": "calculator-t", "it-hojokin-saitakuritsu": "documents-t",
    "aio-taisaku-guide": "chip-t", "meo-osaka-guide": "osaka-t",
    "gbizid-shutoku": "paperwork-t", "excel-dakkyaku": "analytics-t",
}
CAT_THUMBS = {"補助金": ["documents-t", "calculator-t", "paperwork-t"],
              "AIO": ["chip-t", "analytics-t"], "MEO": ["osaka-t"],
              "システム開発": ["analytics-t", "chip-t"]}

# ---- 記事メタ収集 ----
arts = []
for d in sorted((ROOT / "blog").iterdir()):
    f = d / "index.html"
    if not d.is_dir() or not f.is_file() or d.name == "category":
        continue
    c = f.read_text(encoding="utf-8")
    title = re.search(r"<title>(.*?)[||]", c)
    desc = re.search(r'name="description" content="(.*?)"', c)
    date = re.search(r'"datePublished":\s*"(\d{4}-\d{2}-\d{2})"', c)
    cat = re.search(r'<span class="cat">(.*?)</span>', c)
    if not (title and desc and date and cat):
        print(f"WARN meta不足: {d.name}")
        continue
    arts.append({"slug": d.name, "title": title.group(1).strip(), "desc": desc.group(1)[:80],
                 "date": date.group(1), "cat": cat.group(1).strip()})
arts.sort(key=lambda a: a["date"], reverse=True)
print(f"記事: {len(arts)}本")

counters = {k: 0 for k in CAT_THUMBS}
def thumb(a):
    if a["slug"] in SLUG_THUMB:
        t = SLUG_THUMB[a["slug"]]
    else:
        lst = CAT_THUMBS.get(a["cat"], ["documents-t"])
        t = lst[counters[a["cat"]] % len(lst)]
        counters[a["cat"]] += 1
    w, h = THUMB_DIM[t]
    return t, w, h

def thumb_src(a):
    """記事固有の生成サムネがあればそれを、無ければ在庫写真を返す"""
    gen = ROOT / "images" / "blog" / a["slug"] / "thumbnail.webp"
    if gen.is_file():
        return f"/images/blog/{a['slug']}/thumbnail.webp", 1200, 630
    t, w, h = thumb(a)
    return f"/assets/img/{t}.webp", w, h

def card(a):
    src, w, h = thumb_src(a)
    dj = a["date"].replace("-", ".")
    return f'''    <a class="post" href="/blog/{a["slug"]}/">
      <div class="th"><img src="{src}" alt="" width="{w}" height="{h}" loading="lazy"></div>
      <div class="pb"><p class="cat">{a["cat"]}</p><h2>{a["title"]}</h2>
      <p>{a["desc"][:52]}…</p>
      <time datetime="{a["date"]}">{dj}</time></div>
    </a>'''

STYLE = '''
:root{--bg:#fdfcf9;--bg2:#f4f1e9;--panel:#ffffff;--line:#e7e2d4;--line2:rgba(176,139,62,.45);
--text:#212b3d;--muted:#5b6472;--dim:#6d7484;--gold:#8a6d2a;--gold-strong:#8a6a20;--gold-ink:#171104;
--serif:"Shippori Mincho B1",serif;--sans:"Noto Sans JP",sans-serif;--num:"Oswald","Noto Sans JP",sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:15.5px;line-height:1.9;-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:4px}
header{position:sticky;top:0;z-index:50;background:rgba(253,252,249,.9);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.nav{max-width:1240px;margin:0 auto;padding:0 22px;height:62px;display:flex;align-items:center;justify-content:space-between;gap:14px}
.logo{font-family:var(--num);font-weight:600;letter-spacing:.26em;font-size:14px;text-decoration:none;color:#1d3461}
.logo b{color:var(--gold)}
.logo img{height:38px;width:auto;display:block}
.nav a.cta{display:inline-flex;align-items:center;min-height:42px;padding:8px 20px;border-radius:999px;background:linear-gradient(135deg,#ffb25e,#f97316 58%,#e8630a);color:var(--gold-ink);font-weight:700;font-size:13px;text-decoration:none}
main{max-width:1240px;margin:0 auto;padding:56px 22px 90px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:44px;align-items:start}
.main-col{min-width:0}
.side{position:sticky;top:84px;display:grid;gap:16px}
@media(max-width:1023px){main{grid-template-columns:minmax(0,1fr)}.side{position:static}}
.side .sbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:0 6px 20px rgba(29,52,97,.05)}
.side .sbox p.t{font-family:var(--num);font-size:11.5px;letter-spacing:.3em;color:var(--gold);margin:0 0 12px}
.side .sbox ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.side .sbox li{margin:0}
.side .sbox a{display:block;font-size:13.5px;text-decoration:none;color:var(--text);padding:10px 12px;border:1px solid var(--line);border-radius:8px;line-height:1.5}
.side .sbox a:hover{border-color:var(--line2);color:var(--gold-strong)}
.side .scta{background:linear-gradient(150deg,#132445,#1d3461 60%,#24427c);border-radius:12px;padding:22px;color:#fff;text-align:center}
.side .scta p{font-family:var(--serif);font-weight:800;font-size:15px;line-height:1.8;margin:0 0 12px;color:#fff}
.side .scta a{display:block;background:linear-gradient(135deg,#ffb25e,#f97316 58%,#e8630a);color:#171104;border-radius:999px;padding:12px;font-weight:700;font-size:13px;text-decoration:none;margin-top:8px}
.side .scta a.g{background:none;border:1.5px solid rgba(255,255,255,.5);color:#fff}
.crumb{font-size:12px;color:var(--dim);margin-bottom:20px}
.crumb a{color:var(--dim);text-decoration:none}
.kicker{font-family:var(--num);font-size:12px;letter-spacing:.34em;text-transform:uppercase;color:var(--gold);display:flex;align-items:center;gap:14px;margin-bottom:16px}
.kicker::before{content:"";width:34px;height:1px;background:var(--gold)}
h1{font-family:var(--serif);font-weight:800;font-size:clamp(26px,4.4vw,38px);line-height:1.5;margin-bottom:12px;color:#1d3461}
.lead{color:var(--muted);max-width:720px;margin-bottom:8px}
.fresh{font-size:12.5px;color:var(--dim);margin-bottom:30px}
.hub{background:#fff;border:1px solid var(--line2);border-radius:12px;padding:16px 20px;margin-bottom:30px;font-size:13.5px;color:var(--muted)}
.hub a{color:var(--gold-strong);font-weight:700}
.filters{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:34px}
.filter{display:inline-flex;align-items:center;min-height:44px;padding:8px 20px;border-radius:999px;border:1px solid var(--line);color:var(--muted);font-size:13px;font-weight:700;text-decoration:none;background:#fff}
.filter[aria-current="true"]{border-color:var(--line2);color:var(--gold-strong);background:rgba(217,179,106,.1)}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
.post{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;text-decoration:none;transition:border-color .15s,transform .15s;display:flex;flex-direction:column;box-shadow:0 10px 34px rgba(29,52,97,.06)}
.post:hover{border-color:var(--line2);transform:translateY(-3px)}
.post .th{height:104px;background:linear-gradient(135deg,#eef1f8,#e4e9f4);border-bottom:1px solid var(--line);overflow:hidden}
.post .th img{width:100%;height:100%;object-fit:cover;display:block}
.post .pb{padding:18px 18px 20px;display:flex;flex-direction:column;flex:1}
.post .cat{font-size:11.5px;letter-spacing:.22em;color:var(--gold);margin-bottom:8px}
.post h2{font-size:15px;font-weight:700;line-height:1.7;font-family:var(--sans)}
.post p{font-size:12.5px;color:var(--dim);margin-top:8px;line-height:1.8}
.post time{display:block;font-size:12px;color:var(--dim);margin-top:auto;padding-top:12px}
.author{display:flex;gap:16px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;margin-top:48px;font-size:13.5px;color:var(--muted);max-width:760px}
.author img.av{width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid var(--line2);flex:none}
.author b{color:var(--text)}
footer{border-top:1px solid var(--line);background:var(--bg2);padding:40px 22px;font-size:12.5px;color:var(--muted);text-align:center;line-height:1.9}
footer a{color:var(--muted);text-decoration:none;margin:0 10px}
'''

AUTHOR = '''  <div class="author">
    <img class="av" src="/assets/img/ceo.webp" alt="原口優" width="56" height="56" loading="lazy">
    <div><b>原口 優|セブンセンシズ株式会社 代表取締役</b><br>
    大阪・東成区のデジタルマーケティング&AI導入支援会社。IT導入補助金の申請支援50社+、MEO事業「G-ran」運営。<a href="/#contact" style="color:var(--gold-strong)">無料相談はこちら</a>。</div>
  </div>'''

SIDEBAR = '''<aside class="side">
  <div class="sbox">
    <p class="t">CATEGORY</p>
    <ul>
      <li><a href="/blog/category/hojokin/">補助金の記事一覧</a></li>
      <li><a href="/blog/category/aio/">AIO(AI検索対策)の記事一覧</a></li>
      <li><a href="/blog/category/meo/">MEOの記事一覧</a></li>
      <li><a href="/blog/category/dev/">システム開発の記事一覧</a></li>
    </ul>
  </div>
  <div class="sbox">
    <p class="t">SERVICE</p>
    <ul>
      <li><a href="/service/hojokin/">補助金申請サポート</a></li>
      <li><a href="/service/dev/">システム開発・AI導入</a></li>
      <li><a href="/service/aio/">AIOコンサルティング</a></li>
      <li><a href="/service/meo/">MEOコンサルティング</a></li>
    </ul>
  </div>
  <div class="sbox">
    <p class="t">MEMBER</p>
    <ul>
      <li><a href="/#member">会員価格について — ご契約者様は大幅割引</a></li>
    </ul>
  </div>
  <div class="scta">
    <p>補助金を活用できるか、<br>まずは無料診断でチェック。</p>
    <a href="/#diagnosis">無料診断を試す</a>
    <a class="g" href="/#contact">無料で相談する</a>
  </div>
</aside>'''

FOOTER = '''<footer>
  <nav><a href="/">AI導入補助金LP</a><a href="/service/hojokin/">補助金サポート</a><a href="/service/aio/">AIOコンサル</a><a href="/service/meo/">MEOコンサル</a><a href="/service/dev/">システム開発</a><a href="/#diagnosis">無料診断</a><a href="/privacy/">プライバシーポリシー</a></nav>
  <p>© 2026 SEVEN SENSES INC. セブンセンシズ株式会社|大阪市東成区神路1-7-4</p>
</footer>'''

def filters_html(current):
    out = [f'<a class="filter" href="/blog/" aria-current="{"true" if current=="all" else "false"}">すべて({len(arts)})</a>']
    for name, (slug, _, _) in CATS.items():
        n = sum(1 for a in arts if a["cat"] == name)
        cur = "true" if current == name else "false"
        out.append(f'<a class="filter" href="/blog/category/{slug}/" aria-current="{cur}">{name}({n})</a>')
    return "\n    ".join(out)

def page(url_path, title, desc, h1, lead, cards, current_cat, crumb_leaf, hub_html="", jsonld_extra=""):
    return f'''<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- 自動生成: scratchpad/gen_blog_pages.py(記事追加時に再実行) -->
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{DOMAIN}{url_path}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{DOMAIN}{url_path}">
<meta property="og:image" content="{DOMAIN}/ogp.png">
<meta property="og:locale" content="ja_JP">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Shippori+Mincho+B1:wght@600;800&family=Oswald:wght@500;600&display=swap" rel="stylesheet">
<script type="application/ld+json">
{{
  "@context": "https://schema.org",
  "@graph": [
    {{ "@type": "CollectionPage", "url": "{DOMAIN}{url_path}", "name": "{title}",
      "publisher": {{ "@type": "Organization", "@id": "{DOMAIN}/#org", "name": "セブンセンシズ株式会社" }} }},
    {{ "@type": "BreadcrumbList", "itemListElement": [
      {{ "@type": "ListItem", "position": 1, "name": "ホーム", "item": "{DOMAIN}/" }},
      {{ "@type": "ListItem", "position": 2, "name": "ブログ", "item": "{DOMAIN}/blog/" }}{jsonld_extra} ] }}
  ]
}}
</script>
<style>{STYLE}</style>
</head>
<body>
<header>
  <div class="nav">
    <a class="logo" href="/"><img src="/assets/img/logo-h.webp" alt="SEVEN SENSES セブンセンシズ株式会社" width="372" height="148"></a>
    <a class="cta" href="/#contact">無料で相談する</a>
  </div>
</header>
<main>
<div class="main-col">
  <nav class="crumb" aria-label="パンくず"><a href="/">ホーム</a> › {crumb_leaf}</nav>
  <p class="kicker">Blog — 毎日更新</p>
  <h1>{h1}</h1>
  <p class="lead">{lead}</p>
  <p class="fresh">本ページは2026年7月時点の情報です</p>
{hub_html}
  <div class="filters" aria-label="カテゴリで絞り込み">
    {filters_html(current_cat)}
  </div>
  <div class="grid">
{cards}
  </div>
{AUTHOR}
</div>
{SIDEBAR}
</main>
{FOOTER}
</body>
</html>
'''

# ---- ブログ一覧 ----
all_cards = "\n".join(card(a) for a in arts)
(ROOT / "blog" / "index.html").write_text(page(
    "/blog/", "ブログ|補助金・AIO・MEO・システム開発の実務ノウハウ|セブンセンシズ株式会社",
    f"AI導入補助金の申請実務、AIO、MEO、業務システム開発のノウハウを支援現場の一次情報で毎日発信。全{len(arts)}記事をカテゴリ別に読めます。",
    "補助金・AI・集客の<br>実務ノウハウを毎日発信",
    "AI導入補助金(IT導入補助金)の申請実務から、AIO(AI検索最適化)・MEO・業務システム開発まで。支援の現場で得た一次情報だけを書いています。",
    all_cards, "all", "ブログ"), encoding="utf-8")
print("生成: blog/index.html")

# ---- カテゴリ別 ----
for name, (slug, hub, catdesc) in CATS.items():
    cat_arts = [a for a in arts if a["cat"] == name]
    counters = {k: 0 for k in CAT_THUMBS}  # サムネ回転をカテゴリごとにリセット
    cards = "\n".join(card(a) for a in cat_arts)
    hub_html = (f'  <div class="hub">このカテゴリを体系的に知りたい方は、サービス紹介ページ'
                f'「<a href="{hub}">{name}のサービス詳細</a>」をご覧ください。個別のご相談は'
                f'<a href="/#contact">無料相談</a>へ。</div>')
    jsonld_extra = f',\n      {{ "@type": "ListItem", "position": 3, "name": "{name}" }}'
    out = ROOT / "blog" / "category" / slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(page(
        f"/blog/category/{slug}/",
        f"{name}の記事一覧({len(cat_arts)}本)|セブンセンシズ株式会社ブログ",
        f"{catdesc}。全{len(cat_arts)}記事。",
        f"カテゴリ: <span style='color:#8a6a20'>{name}</span>の記事一覧",
        catdesc + "。", cards, name, f'<a href="/blog/">ブログ</a> › {name}',
        hub_html, jsonld_extra), encoding="utf-8")
    print(f"生成: blog/category/{slug}/index.html ({len(cat_arts)}本)")

# ---- sitemap.xml ----
STATIC = [("/", "2026-07-21", "1.0"), ("/blog/", "2026-07-21", "0.8"),
          ("/service/hojokin/", "2026-07-21", "0.9"), ("/service/dev/", "2026-07-21", "0.8"),
          ("/service/aio/", "2026-07-21", "0.9"), ("/service/meo/", "2026-07-21", "0.8"),
          ("/about/", "2026-07-21", "0.5"), ("/youkou/", "2026-07-23", "0.7"),
          ("/privacy/", "2026-07-21", "0.3")]
urls = [f"  <url>\n    <loc>{DOMAIN}{p}</loc>\n    <lastmod>{d}</lastmod>\n    <priority>{pr}</priority>\n  </url>"
        for p, d, pr in STATIC]
for name, (slug, _, _) in CATS.items():
    cat_arts = [a for a in arts if a["cat"] == name]
    last = max((a["date"] for a in cat_arts), default="2026-07-21")
    urls.append(f"  <url>\n    <loc>{DOMAIN}/blog/category/{slug}/</loc>\n    <lastmod>{last}</lastmod>\n    <priority>0.6</priority>\n  </url>")
for a in arts:
    pr = "0.9" if a["slug"] == "ai-hojokin-guide-2026" else "0.7"
    urls.append(f"  <url>\n    <loc>{DOMAIN}/blog/{a['slug']}/</loc>\n    <lastmod>{a['date']}</lastmod>\n    <priority>{pr}</priority>\n  </url>")
# ---- llms.txt の記事セクション自動更新 (AIO: AIクローラーに全記事を提示) ----
llms_path = ROOT / "llms.txt"
if llms_path.is_file():
    llms = llms_path.read_text(encoding="utf-8")
    cut = llms.find("\n## ブログ記事")
    if cut != -1:
        llms = llms[:cut]
    lines = ["", "## ブログ記事(全記事・新しい順)", ""]
    for a in arts:
        lines.append(f"- [{a['title']}]({DOMAIN}/blog/{a['slug']}/): {a['desc'][:70]}")
    lines += ["",
              "## 記事カテゴリ",
              "",
              f"- [補助金の記事一覧]({DOMAIN}/blog/category/hojokin/)",
              f"- [AIO(AI検索対策)の記事一覧]({DOMAIN}/blog/category/aio/)",
              f"- [MEOの記事一覧]({DOMAIN}/blog/category/meo/)",
              f"- [システム開発の記事一覧]({DOMAIN}/blog/category/dev/)", ""]
    llms_path.write_text(llms.rstrip() + "\n" + "\n".join(lines), encoding="utf-8")
    print(f"生成: llms.txt (記事{len(arts)}本を反映)")

(ROOT / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    "<!-- 自動生成: gen_blog_pages.py。lastmodは記事の公開/更新日のみ変更 -->\n"
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "\n".join(urls) + "\n</urlset>\n", encoding="utf-8")
print(f"生成: sitemap.xml ({len(urls)} URLs)")
print("done")







