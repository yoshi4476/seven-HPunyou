# -*- coding: utf-8 -*-
"""記事の途中の案内と、スマホの固定ボタンを差し込む（公開の工程で毎回呼ぶ・何度呼んでも二重に入らない）。

記事を見た人のうち、診断や相談のボタンを押したのは約3%だった（GA4・2026-09の28日）。
記事末とPCの横の欄にしか誘いが無く、スマホで読み終える前に離れる人には届いていなかった。
- 記事の途中（2つ目の見出しの後）に、記事の業種に合わせた「3分の補助金適性診断」への案内
- スマホで1画面半読み進めたら、画面下に固定ボタン（記事末の案内・フッターが見えている間は引っ込める）

    python tools/blog_cta.py           # blog/*/index.html に当てる（render_blog / gen_blog_pages の後）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARK = "<!-- blog-cta:v1 -->"

# タイトルに出てくる業種（具体的なものを先に）
INDUSTRIES = ["動物病院", "歯科医院", "クリニック", "エステサロン", "美容室", "飲食店", "学習塾", "不動産会社",
              "自動車整備業", "建設業", "製造業", "小売業", "介護事業所", "運送業", "宿泊業", "士業", "個人事業主"]

STYLE = """<style>
.bcta-mid{background:linear-gradient(135deg,rgba(217,179,106,.16),rgba(217,179,106,.05));border:1px solid var(--line2,#e6d3a3);border-radius:14px;padding:22px 22px 20px;margin:36px 0;text-align:center}
.bcta-mid .t{font-weight:800;font-size:17px;line-height:1.7;margin:0 0 6px}
.bcta-mid .d{font-size:13px;color:var(--muted,#5b6472);margin:0 0 14px;line-height:1.8}
.bcta-mid a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 26px;border-radius:999px;background:linear-gradient(135deg,#ffb25e,#f97316 58%,#e8630a);color:#171104;font-weight:700;font-size:14px;text-decoration:none}
.blog-sticky{position:fixed;left:0;right:0;bottom:0;z-index:60;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:rgba(253,252,249,.96);box-shadow:0 -8px 24px -12px rgba(19,36,69,.35);transform:translateY(110%);transition:transform .3s ease}
.blog-sticky.on{transform:none}
.blog-sticky a{display:block;text-align:center;min-height:48px;line-height:48px;border-radius:999px;background:linear-gradient(135deg,#ffb25e,#f97316 58%,#e8630a);color:#171104;font-weight:700;font-size:14px;text-decoration:none}
@media (min-width:761px){.blog-sticky{display:none}}
@media (prefers-reduced-motion:reduce){.blog-sticky{transition:none}}
</style>"""

STICKY = """<div class="blog-sticky" hidden><a class="cta" href="/#diagnosis" data-cta="blog_sticky_diag">3分の無料診断で「うちの場合」を確かめる</a></div>
<script>
(function(){var b=document.querySelector('.blog-sticky');if(!b||!matchMedia('(max-width:760px)').matches)return;b.hidden=false;
var near=[];if('IntersectionObserver'in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){var i=near.indexOf(e.target);
if(e.isIntersecting&&i<0)near.push(e.target);if(!e.isIntersecting&&i>=0)near.splice(i,1)});t()});
document.querySelectorAll('.cta-box, footer').forEach(function(el){io.observe(el)})}
function t(){b.classList.toggle('on',scrollY>innerHeight*1.5&&near.length===0)}addEventListener('scroll',t,{passive:true});t()})();
</script>"""


def mid_box(title):
    ind = next((w for w in INDUSTRIES if w in title), "")
    who = f"{ind}の場合" if ind else "御社の場合"
    return (f'<aside class="bcta-mid">'
            f'<p class="t">{who}、補助金が使えるか3分で確かめる</p>'
            f'<p class="d">8つの質問に答えるだけで、補助金の使いやすさを判定し、その場で次にやることを表示します。登録不要です。</p>'
            f'<a class="cta" href="/#diagnosis" data-cta="blog_mid_diag">無料で診断する</a></aside>\n')


AICHECK = ('<aside style="max-width:880px;margin:28px auto 0;padding:18px 22px;border:1px solid rgba(19,36,69,.14);border-radius:14px;'
           'background:#fff;text-align:left;font-size:14px;line-height:1.9">'
           '<b style="display:block;font-size:15px;color:#132445">AIに、御社はどう紹介されていますか？</b>'
           '地域と業種を入れると、AIに「地域名＋業種 おすすめ」など3つの質問をして、答えの出典に御社のサイトや社名が出ているかを確かめます（無料）。'
           ' <a href="https://ai.7senses.co.jp/tools/ai-check/?src=lp_subsidy&amp;from=blog" target="_blank" rel="noopener" '
           'data-cta="subsidy_aicheck_blog" style="font-weight:700">無料でチェックする</a></aside>')
SUPERVISOR_END = '<a href="/#contact">監修者に相談する</a></div>'


def add_aicheck(html):
    """AI集客ラボの「AIにどう紹介されているか無料チェック」への入口（監修者の欄の下・既存記事にも入れる）"""
    if "subsidy_aicheck_blog" in html or SUPERVISOR_END not in html:
        return html
    return html.replace(SUPERVISOR_END, SUPERVISOR_END + "\n      " + AICHECK, 1)


TABLE_CSS = "<style>.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:20px 0}</style>"


def wrap_tables(html):
    """包まれていない表を .table-wrap で包む（6本が素の <table> のままだった）"""
    return re.sub(r'(?<!<div class="table-wrap">)(?<!<div class="table-scroll">)<table\b(.*?)</table>',
                  r'<div class="table-wrap"><table\1</table></div>', html, flags=re.S)


def add_table_css(html):
    """管制塔から届く記事は表を .table-wrap で包むが、雛形には .table-scroll しか無く、
    スマホで表が画面からはみ出していた（2026-10-02 に118本で確認）"""
    html = wrap_tables(html)
    if 'class="table-wrap"' not in html or ".table-wrap{" in html:
        return html
    return html.replace("</head>", TABLE_CSS + "\n</head>", 1)


def apply(html):
    html = add_table_css(add_aicheck(html))
    if MARK in html:
        return html
    title = re.sub(r"<[^>]+>", "", (re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S) or [None, ""])[1])
    end = html.find('<section class="faq-sec">')
    scope = html[:end] if end > 0 else html
    heads = [m.start() for m in re.finditer(r"<h2[ >]", scope)]
    # 管制塔から配信された記事には、途中の案内（cta-mid）が既に入っているものがある。二重にしない
    if len(heads) >= 4 and 'class="cta-mid' not in html:
        html = html[:heads[2]] + mid_box(title) + html[heads[2]:]
    return html.replace("</body>", MARK + "\n" + STYLE + "\n" + STICKY + "\n</body>", 1)


def undo(html):
    """差し込んだ部分だけを取り除く（v1 の途中の案内は cta-mid、以降は bcta-mid）"""
    html = re.sub(r'<aside class="b?cta-mid"><p class="t">[^<]*、補助金が使えるか3分で確かめる</p>.*?</aside>\n', "", html, flags=re.S)
    i = html.find(MARK)
    if i >= 0:
        j = html.find("</script>", i)
        html = html[:i] + html[j + len("</script>\n"):]
    return html


def main():
    if "--undo" in sys.argv:
        n = 0
        for p in sorted((ROOT / "blog").glob("*/index.html")):
            s = p.read_text(encoding="utf-8")
            t = undo(s)
            if t != s:
                p.write_text(t, encoding="utf-8")
                n += 1
        print(f"BLOG_CTA: {n}件から取り除きました")
        return 0
    n = 0
    # 雛形には当てない（雛形に目印が付くと、そこから作る新しい記事が「差し込み済み」と見なされる）
    for p in sorted((ROOT / "blog").glob("*/index.html")):
        s = p.read_text(encoding="utf-8")
        t = apply(s)
        if t != s:
            p.write_text(t, encoding="utf-8")
            n += 1
    print(f"BLOG_CTA: {n}件に差し込み")
    return 0


if __name__ == "__main__":
    sys.exit(main())
