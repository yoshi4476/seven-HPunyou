# -*- coding: utf-8 -*-
"""公開済み記事どうしの重複を検出して報告する

管制塔は記事HTMLを直接納品するようになったため、render_blog.py の重複ガード
(Markdownを描画する経路)を通らない。公開後にここで気づけるようにする。

判定を1つの数値に頼らないのは、実測で「本当の重複36%」より
「意図的な地域別の書き分け42%」の方が高く出たため。
タイトル・見出し・主題語の3観点を併記し、人が判断できる形で出す。
"""
import re
import sys
import io
from pathlib import Path
from itertools import combinations

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent

# 記事の主題を決める語。両方のタイトルに出れば同じ検索意図を狙っている可能性が高い
CORE = ["GビズID", "必要書類", "採択率", "不採択", "活用事例", "事例", "費用", "相場",
        "対象ツール", "申請代行", "ベンダー", "スケジュール", "実績報告", "納税証明",
        "セキュリティ", "個人事業主", "ホームページ", "会計ソフト", "着金", "補助率"]
# 地域・業種が違えば意図的な書き分けとみなす
AREA = ["大阪", "名古屋", "京都", "神戸", "福岡", "東京", "横浜", "札幌", "仙台", "広島"]
INDUSTRY = ["製造業", "小売業", "飲食", "建設", "士業", "卸売", "美容室", "介護", "運送"]
THRESHOLD = 0.62


def bigrams(s):
    s = re.sub(r"[\s|｜【】\[\]()()、。・:：\-—0-9]", "", s or "")
    return {s[i:i + 2] for i in range(len(s) - 1)}


def dice(a, b):
    x, y = bigrams(a), bigrams(b)
    return 0.0 if not x or not y else 2 * len(x & y) / (len(x) + len(y))


def load():
    arts = []
    for d in sorted((ROOT / "blog").iterdir()):
        f = d / "index.html"
        if not d.is_dir() or not f.is_file() or d.name == "category":
            continue
        h = f.read_text(encoding="utf-8")
        t = re.search(r"<title>(.*?)</title>", h)
        heads = [re.sub(r"<[^>]+>", "", x) for x in re.findall(r"<h2[^>]*>(.*?)</h2>", h, re.S)]
        arts.append({"slug": d.name, "title": (t.group(1) if t else d.name).split("|")[0],
                     "heads": heads})
    return arts


def main():
    arts = load()
    flagged = []
    for a, b in combinations(arts, 2):
        core = [k for k in CORE if k in a["title"] and k in b["title"]]
        ar = [k for k in AREA if k in a["title"]], [k for k in AREA if k in b["title"]]
        ind = [k for k in INDUSTRY if k in a["title"]], [k for k in INDUSTRY if k in b["title"]]
        # 地域・業種が両方にあって異なるなら、狙う読者が違うので重複ではない
        if (ar[0] and ar[1] and ar[0] != ar[1]) or (ind[0] and ind[1] and ind[0] != ind[1]):
            continue
        ts = dice(a["title"], b["title"])
        hs = dice(" ".join(a["heads"]), " ".join(b["heads"]))
        score = ts * 0.6 + hs * 0.2 + (0.2 if core else 0)
        if score >= THRESHOLD:
            flagged.append((score, ts, hs, core, a, b))

    flagged.sort(reverse=True, key=lambda r: r[0])
    print(f"重複検査: 記事{len(arts)}本 / 要確認 {len(flagged)}組")
    for score, ts, hs, core, a, b in flagged:
        print(f"\n  [{score:.2f}] タイトル{ts:.0%} 見出し{hs:.0%} 共通主題{core or 'なし'}")
        print(f"    A /blog/{a['slug']}/  {a['title'][:44]}")
        print(f"    B /blog/{b['slug']}/  {b['title'][:44]}")
    if flagged:
        print("\n→ 片方を残し、もう片方は _redirects で301統合するか、切り口を変えて書き直す")
    return 0  # 公開後の通知が目的のため、ここでは失敗扱いにしない


if __name__ == "__main__":
    sys.exit(main())
