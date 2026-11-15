#!/usr/bin/env python3
"""日本食品標準成分表（八訂）増補2023年の Excel を、アプリ同梱の検索用データ seibun.json に変換する。

使い方（減量サポート フォルダで）:
    python tools/convert_seibun.py                       # tools/ にある .xlsx（1つだけのとき）を使う
    python tools/convert_seibun.py tools/新しい版.xlsx   # Excel を指定
    python tools/convert_seibun.py --try 豚 "鶏 むね" ごはん   # 検索の確認例も表示

入力:
    Excel（シート「表全体」）
    tools/seibun_readings.json  … 単語ごとの読み・表記の辞書（手で直してよい）
    tools/seibun_aliases.json   … 読みが違う言い換えの表（手で直してよい）
    tools/seibun_labels.json    … 食品番号 → 分かりやすい名前（label）の表（手で直してよい）
出力:
    seibun.json（リポジトリのルート。UTF-8、改行LF、ensure_ascii=False、余分な空白なし）

Python 標準ライブラリだけを使う（xlsx は zipfile + xml.etree で読む）。
同じ入力なら何度実行しても同じ seibun.json になる。

==== 文字のそろえ方（正規化）のルール ====
normalize() が唯一の正規化関数。search・terms はすべてこれを通した形で出力する。
アプリ側でも検索語に「同じ処理」をしてから照合すること。

  1. Unicode NFKC 正規化
       全角英数字・全角記号 → 半角（Ａ→A、１→1、（→( 、：→: など）
       半角カタカナ → 全角カタカナ（ｶﾞ→ガ。濁点も結合される）
       全角スペース → 半角スペース
  2. 英字を小文字にする（A→a）
  3. カタカナをひらがなにする
       U+30A1「ァ」〜 U+30F6「ヶ」→ 0x60 引いたひらがな（ア→あ、ヴ→ゔ、ヵ→ゕ）
       U+30FD「ヽ」→「ゝ」、U+30FE「ヾ」→「ゞ」
       長音「ー」はそのまま残す
  4. 空白と次の記号をすべて取り除く（手順1の後なので半角で判定する）
       空白類（スペース・タブ・改行など）
       ( ) [ ] { } < > ・ : ; , . 、 。 「 」 『 』 【 】 〔 〕 〈 〉 《 》
       ! ? " ' ` / \\ | ~ 〜 _ - = + * # & ^ $ @ … ‥
       （「％」「%」「々」「ー」は消さない）

  JavaScript で同じ処理を書くと次のとおり:
    function normalize(s) {
      s = s.normalize("NFKC").toLowerCase();
      s = s.replace(/[\\u30A1-\\u30F6\\u30FD\\u30FE]/g,
                    (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
      return s.replace(/[\\s()\\[\\]{}<>・:;,.、。「」『』【】〔〕〈〉《》!?"'`\\/\\\\|~〜_\\-=+*#&^$@…‥]/g, "");
    }

==== search の形 ====
  食品名を単語に分けて正規化し、半角スペースでつないだもの（同じ単語は1回だけ）の後ろに、
  半角スペース区切りで label の単語（（）・空白で区切ったもの）・読み・表記・言い換え語（正規化済み）を足したもの。
  label の単語は terms にも入る。
  正規化した検索語には空白が残らないので、スペースをまたいで一致することはない
  （単語の境目をまたいだ誤ヒット、例「ココナッツ ナタデココ」に「ツナ」が当たる、を防ぐ）。
  すでに search に含まれる文字列は足さない。1文字のひらがな（葉→は 等）は検索に役立たないので足さない。

==== terms ====
  検索語を区切るための語の一覧。食品名の全単語・辞書の読み/表記・言い換え語を正規化し、重複なく、
  長い順（同じ長さはコード順）に並べたもの。1文字のひらがなは除く。
  アプリ側では「検索語を空白で分けて正規化し、先頭から terms の最長一致で区切る（どの語にも当たらない文字は
  つなげて1つの塊にする）→ 区切った語がすべて当たった食品を出す」。語が当たるとは、search がその語をそのまま含むか、
  その語をそれより短い terms だけで区切った（覆いきれる場合）すべての部分が当たること（再帰的に判定）。
  並びは labelKeys のどれかが検索語全体（正規化）で始まる → どれかに検索語全体を含む → それ以外、の順で、
  同じグループ内は 単語の先頭で一致した語の数 → 食品番号。

==== labelKeys ====
  並び替え専用。label を正規化したものを先頭に、label の単語の中のかな（読み・表記の辞書で漢字の書き方が
  ある2文字以上の語。前後がひらがなでない位置のものだけ）を漢字に置き換えた別の書き方を並べたもの
  （例：鶏むね肉（若鶏・皮なし）生 → 鶏むね肉若鶏皮なし生, 鶏胸肉若鶏皮なし生, …）。一覧の表示は label のまま。
"""

import argparse
import collections
import datetime
import json
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from decimal import ROUND_HALF_UP, Decimal

SOURCE_NAME = "日本食品標準成分表（八訂）増補2023年"
SHEET_NAME = "表全体"
CODE_COL = "B"  # 食品番号
NAME_COL = "D"  # 食品名
HEADER_LABEL = "成分識別子"
# 成分識別子 → (出力キー, 小数の桁数)。成分表の表記に合わせ kcal は整数、g は小数第1位。
NUTRIENTS = [
    ("ENERC_KCAL", "calories", 0),
    ("PROT-", "protein", 1),
    ("FAT-", "fat", 1),
    ("CHOCDF-", "carbohydrate", 1),
]

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(TOOLS_DIR)
READINGS_PATH = os.path.join(TOOLS_DIR, "seibun_readings.json")
ALIASES_PATH = os.path.join(TOOLS_DIR, "seibun_aliases.json")
LABELS_PATH = os.path.join(TOOLS_DIR, "seibun_labels.json")
OUTPUT_PATH = os.path.join(ROOT_DIR, "seibun.json")


class ConvertError(Exception):
    pass


# ---------------------------------------------------------------- 正規化・単語分け

_REMOVE_CHARS = "()[]{}<>・:;,.、。「」『』【】〔〕〈〉《》!?\"'`/\\|~〜_-=+*#&^$@…‥"
_REMOVE_RE = re.compile(r"[\s" + re.escape(_REMOVE_CHARS) + r"]")
_KATA_RE = re.compile(r"[ァ-ヶヽヾ]")


def normalize(s):
    """検索用の正規化（ルールは冒頭のコメントを参照）。"""
    s = unicodedata.normalize("NFKC", s).lower()
    s = _KATA_RE.sub(lambda m: chr(ord(m.group()) - 0x60), s)
    return _REMOVE_RE.sub("", s)


# 食品名を単語に分ける区切り：空白（全角・半角）と ＜＞（）［］・：（半角形も含む）
_SPLIT_RE = re.compile(r"[\s　＜＞（）［］・･：<>()\[\]:]+")


def split_words(name):
    return [w for w in _SPLIT_RE.split(name) if w]


def display_name(name):
    """表示用の名前：空白（全角・半角）の連続を全角スペース1つにし、前後の空白を除く。"""
    return re.sub(r"[\s　]+", "　", name).strip("　 \t\r\n")


def is_single_hiragana(s):
    return len(s) == 1 and "ぁ" <= s <= "ゟ"


# ---------------------------------------------------------------- xlsx の読み込み

def _col_of(ref):
    m = re.match(r"[A-Z]+", ref)
    if not m:
        raise ConvertError(f"セル番地を読めません: {ref}")
    return m.group()


def _text_of(si):
    """sharedStrings の si / inlineStr の is から本文だけを取り出す（ふりがな rPh は除く）。"""
    parts = []
    for ch in si:
        if ch.tag == NS + "t":
            parts.append(ch.text or "")
        elif ch.tag == NS + "r":
            t = ch.find(NS + "t")
            if t is not None:
                parts.append(t.text or "")
    return "".join(parts)


_UPDATED_RE = re.compile(r"更新日\s*[：:]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")


def read_xlsx(path):
    """シート「表全体」の全行を {行番号: {列: 文字列}} で返す。あわせて更新日（YYYY-MM-DD）。"""
    try:
        z = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as e:
        raise ConvertError(f"Excel を開けません: {path}（{e}）")
    with z:
        names = set(z.namelist())
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rid = None
        for sh in wb.iter(NS + "sheet"):
            if sh.get("name") == SHEET_NAME:
                rid = sh.get(NS_REL + "id")
        if rid is None:
            raise ConvertError(f"シート「{SHEET_NAME}」が見つかりません")
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = None
        for rel in rels.iter(NS_PKG_REL + "Relationship"):
            if rel.get("Id") == rid:
                target = rel.get("Target")
        if target is None:
            raise ConvertError(f"シート「{SHEET_NAME}」の実体が見つかりません")
        sheet_path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        sheet_path = os.path.normpath(sheet_path).replace("\\", "/")

        shared = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si"):
                shared.append(_text_of(si))

        rows = {}
        root = ET.fromstring(z.read(sheet_path))
        for r in root.iter(NS + "row"):
            rn = int(r.get("r"))
            cells = {}
            for c in r.findall(NS + "c"):
                col = _col_of(c.get("r"))
                t = c.get("t")
                v = c.find(NS + "v")
                if t == "s":
                    val = shared[int(v.text)] if v is not None else ""
                elif t == "inlineStr":
                    is_ = c.find(NS + "is")
                    val = _text_of(is_) if is_ is not None else ""
                else:
                    val = v.text if v is not None and v.text is not None else ""
                cells[col] = val
            rows[rn] = cells

    # 更新日はシート1行目の「更新日：2026年3月27日」から取る（ふりがなは _text_of で除いてある）
    updated = None
    for val in rows.get(1, {}).values():
        m = _UPDATED_RE.search(val or "")
        if m:
            try:
                updated = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
            except ValueError:
                raise ConvertError(f"シート1行目の更新日が正しい日付ではありません: {val}")
            break
    if updated is None:
        raise ConvertError(f"シート「{SHEET_NAME}」の1行目に「更新日：○年○月○日」が見つかりません")
    return rows, updated


# ---------------------------------------------------------------- 値の変換

_NUM_RE = re.compile(r"^\d+(?:\.\d+)?$")
_EST_RE = re.compile(r"^\((\d+(?:\.\d+)?)\)$")


def round_value(text, digits):
    q = Decimal(text).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    if q == q.to_integral_value():
        return int(q)
    return float(q)


def parse_value(raw, digits):
    """戻り値: (値 or None, 種別)。種別は num / est / tr / est_tr / missing / bad。"""
    s = (raw or "").strip()
    if s == "Tr":
        return 0, "tr"
    if s == "(Tr)":
        return 0, "est_tr"
    if s == "-":
        return None, "missing"
    if _NUM_RE.match(s):
        return round_value(s, digits), "num"
    m = _EST_RE.match(s)
    if m:
        return round_value(m.group(1), digits), "est"
    return None, "bad"


# ---------------------------------------------------------------- 辞書・言い換え表

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except OSError as e:
        raise ConvertError(f"{path} を開けません（{e}）")
    except json.JSONDecodeError as e:
        raise ConvertError(f"{path} の JSON が正しくありません（{e.lineno}行目: {e.msg}）")


def _str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) and x for x in v)


def load_readings(path):
    data = load_json(path)
    words = data.get("words") if isinstance(data, dict) else None
    if not isinstance(words, dict):
        raise ConvertError(f"{path}: \"words\" がオブジェクトではありません")
    for k, v in words.items():
        if not _str_list(v):
            raise ConvertError(f"{path}: 「{k}」の値は文字列のリストにしてください")
    return words


def load_aliases(path):
    data = load_json(path)
    rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rules, list):
        raise ConvertError(f"{path}: \"rules\" がリストではありません")
    for i, r in enumerate(rules, 1):
        if not isinstance(r, dict):
            raise ConvertError(f"{path}: {i}番目のルールがオブジェクトではありません")
        unknown = set(r) - {"any", "all", "none", "add", "note"}
        if unknown:
            raise ConvertError(f"{path}: {i}番目のルールに不明な項目 {sorted(unknown)} があります")
        if not _str_list(r.get("any")) or not r["any"]:
            raise ConvertError(f"{path}: {i}番目のルールの \"any\" は1つ以上の単語のリストにしてください")
        if not _str_list(r.get("add")) or not r["add"]:
            raise ConvertError(f"{path}: {i}番目のルールの \"add\" は1つ以上の語のリストにしてください")
        for key in ("all", "none"):
            if key in r and not _str_list(r[key]):
                raise ConvertError(f"{path}: {i}番目のルールの \"{key}\" は単語のリストにしてください")
    return rules


def rule_matches(rule, wordset):
    if not any(w in wordset for w in rule["any"]):
        return False
    if not all(w in wordset for w in rule.get("all", [])):
        return False
    if any(w in wordset for w in rule.get("none", [])):
        return False
    return True


# ---------------------------------------------------------------- 検索の確認用

def segment(query, terms_set, max_len):
    """正規化した検索語を terms で区切る（app.js の seibunSegment と同じ）。
    区切り方全体を比べて ① terms にない（区切れずに残る）文字が少ない → ② 区切った語の数が少ない
    → ③ 同じなら先頭から長い語を取るもの（今までの最長一致に近いもの）を選ぶ（動的計画法）。
    区切れずに残る文字は、続いていれば1つの語にまとめる。例：「ぎゅうひれ」→ ぎゅう / ひれ"""
    q = normalize(query)
    n = len(q)
    # best[i][s]：i 文字目から後ろの最良の区切り方 (残る文字数, 語の数, 長さ, 次の状態)。s=1 は直前が区切れずに残った文字
    best = [[None, None] for _ in range(n + 1)]
    best[n][0] = best[n][1] = (0, 0, 0, 0)
    for i in range(n - 1, -1, -1):
        for after_left in (0, 1):
            choice = None
            options = [(length, 0, 1, 0) for length in range(min(max_len, n - i), 0, -1) if q[i:i + length] in terms_set]
            options.append((0, 1, 0 if after_left else 1, 1))  # 長さ0は区切れずに残る1文字
            for length, left, count, next_state in options:
                rest = best[i + max(length, 1)][next_state]
                cand = (left + rest[0], count + rest[1], length, next_state)
                if choice is None or cand[:2] < choice[:2]:
                    choice = cand
            best[i][after_left] = choice
    out, pending, i, state = [], "", 0, 0
    while i < n:
        _, _, length, next_state = best[i][state]
        if length:
            if pending:
                out.append(pending)
                pending = ""
            out.append(q[i:i + length])
            i += length
        else:
            pending += q[i]
            i += 1
        state = next_state
    if pending:
        out.append(pending)
    return out


def sub_parts(part, terms_set, max_len):
    """語を、それより短い terms だけで先頭から最長一致で区切る。覆いきれなければ None（app.js の seibunSubParts と同じ）。"""
    pieces, i, limit = [], 0, min(max_len, len(part) - 1)
    while i < len(part):
        hit = next((part[i:i + n] for n in range(min(limit, len(part) - i), 0, -1) if part[i:i + n] in terms_set), None)
        if hit is None:
            return None
        pieces.append(hit)
        i += len(hit)
    return pieces


def part_hits(search, part, terms_set, max_len):
    if part in search:
        return True
    pieces = sub_parts(part, terms_set, max_len)
    return bool(pieces) and all(part_hits(search, p, terms_set, max_len) for p in pieces)


def search_foods(foods, query, segs, terms_set, max_len):
    """app.js の seibunMatches と同じ当て方・並び順。"""
    whole = normalize(query)
    rows = []
    for f in foods:
        if not segs or not all(part_hits(f["search"], s, terms_set, max_len) for s in segs):
            continue
        keys = f.get("labelKeys") or [normalize(f.get("label", f["name"]))]
        group = 0 if any(k.startswith(whole) for k in keys) else 1 if any(whole in k for k in keys) else 2
        head = sum(1 for s in segs if f["search"].startswith(s) or (" " + s) in f["search"])
        rows.append((group, -head, f["code"], f))
    rows.sort(key=lambda r: r[:3])
    return [r[3] for r in rows]


# ---------------------------------------------------------------- 本体

def find_default_xlsx():
    found = sorted(f for f in os.listdir(TOOLS_DIR) if f.lower().endswith(".xlsx") and not f.startswith("~$"))
    if len(found) != 1:
        raise ConvertError("tools/ の .xlsx が1つではありません。Excel のパスを引数で指定してください"
                           f"（見つかったもの: {found}）")
    return os.path.join(TOOLS_DIR, found[0])


LABEL_MAX = 80  # アプリの食品名の上限（index.html の maxlength）


def load_labels(path):
    data = load_json(path)
    labels = data.get("labels") if isinstance(data, dict) else None
    if not isinstance(labels, dict):
        raise ConvertError(f"{path}: \"labels\" がオブジェクトではありません")
    for code, label in labels.items():
        if not re.fullmatch(r"\d{5}", code):
            raise ConvertError(f"{path}: 食品番号「{code}」は5桁の数字にしてください")
        if not isinstance(label, str) or not label.strip():
            raise ConvertError(f"{path}: {code} の名前が空です")
        if label != label.strip() or len(label) > LABEL_MAX:
            raise ConvertError(f"{path}: {code} の名前は前後の空白なし・{LABEL_MAX}文字以内にしてください（{label}）")
    return labels


def split_label(label):
    """分かりやすい名前を（）・空白で単語に分ける。「鶏皮（むね）生」→ 鶏皮 / むね / 生"""
    return [w for w in re.split(r"[（）()・\s　]+", label) if w]


_KANJI_RE = re.compile(r"[一-鿿々]")
_HIRA_RE = re.compile(r"[ぁ-ゟ]")
LABEL_KEY_WORD_MAX = 8   # 1単語あたりの書き方の上限
LABEL_KEY_MAX = 16       # 1食品あたりの labelKeys の上限


def kana_kanji_map(readings):
    """読み・表記の辞書から「かなだけの語（2文字以上）→ 漢字を含む書き方」の対応を作る（正規化した形）。"""
    table = {}
    for word, forms in readings.items():
        key = normalize(word)
        if len(key) < 2 or not all(_HIRA_RE.match(c) or c == "ー" for c in key):
            continue
        kanji = sorted({normalize(f) for f in forms if _KANJI_RE.search(f)} - {key})
        if kanji:
            table[key] = kanji
    return table


def label_keys(label, table):
    """label（正規化）と、単語の中のかなを漢字の書き方に置き換えた別の書き方（例：鶏むね肉 → 鶏胸肉）。
    置き換えるのは、前後がひらがなでない位置にある語だけ（「いかなご」の中の「いか」などは置き換えない）。"""
    keys_by_len = sorted(table, key=lambda k: (-len(k), k))
    word_sets = []
    for w in split_label(label):
        base = normalize(w)
        variants = [base]
        for key in keys_by_len:
            for v in list(variants):
                pos = [m.start() for m in re.finditer(re.escape(key), v)
                       if (m.start() == 0 or not _HIRA_RE.match(v[m.start() - 1]))
                       and (m.end() == len(v) or not _HIRA_RE.match(v[m.end()]))]
                if not pos:
                    continue
                for form in table[key]:
                    nv, shift = v, 0
                    for p in pos:
                        nv = nv[:p + shift] + form + nv[p + shift + len(key):]
                        shift += len(form) - len(key)
                    if nv not in variants and len(variants) < LABEL_KEY_WORD_MAX:
                        variants.append(nv)
        word_sets.append(variants)
    keys = [""]
    for variants in word_sets:
        keys = [k + v for k in keys for v in variants][:LABEL_KEY_MAX]
    base = normalize(label)
    return [base] + sorted(set(keys) - {base})


def convert(xlsx_path, readings_path, aliases_path, labels_path=None):
    labels_path = labels_path or LABELS_PATH
    rows, updated = read_xlsx(xlsx_path)

    # 成分識別子の行を探し、識別子から列を決める（列位置は決め打ちしない）
    header_row = None
    for rn in sorted(rows):
        if HEADER_LABEL in rows[rn].values():
            header_row = rn
            break
    if header_row is None:
        raise ConvertError(f"「{HEADER_LABEL}」の行が見つかりません")
    ident_cols = {}
    for col, val in rows[header_row].items():
        ident_cols.setdefault(val.strip(), col)
    missing_ids = [i for i, _, _ in NUTRIENTS if i not in ident_cols]
    if missing_ids:
        raise ConvertError(f"成分識別子が見つかりません: {', '.join(missing_ids)}（{header_row}行目）")
    cols = [(ident_cols[i], key, d) for i, key, d in NUTRIENTS]

    readings = load_readings(readings_path)
    rules = load_aliases(aliases_path)
    labels = load_labels(labels_path)

    stats = {"tr": {k: 0 for _, k, _ in NUTRIENTS}, "est_tr": {k: 0 for _, k, _ in NUTRIENTS},
             "est": {k: 0 for _, k, _ in NUTRIENTS}}
    bad, excluded, foods_raw, seen = [], [], [], set()
    for rn in sorted(rows):
        if rn <= header_row:
            continue
        r = rows[rn]
        code = (r.get(CODE_COL) or "").strip()
        if not re.fullmatch(r"\d{5}", code):
            continue
        if code in seen:
            raise ConvertError(f"食品番号が重複しています: {code}（{rn}行目）")
        seen.add(code)
        raw_name = r.get(NAME_COL) or ""
        if not raw_name.strip():
            raise ConvertError(f"食品名が空です: {code}（{rn}行目）")
        values, kinds = {}, {}
        for col, key, digits in cols:
            v, kind = parse_value(r.get(col), digits)
            if kind == "bad":
                bad.append(f"{code} {display_name(raw_name)} {key}={r.get(col)!r}")
            values[key], kinds[key] = v, kind
        if "missing" in kinds.values():
            excluded.append((code, display_name(raw_name), [k for k, v in kinds.items() if v == "missing"]))
            continue
        for key, kind in kinds.items():
            if kind in stats:
                stats[kind][key] += 1
        estimated = any(k in ("est", "est_tr") for k in kinds.values())
        foods_raw.append((code, raw_name, values, estimated))
    if bad:
        raise ConvertError("数値にできない値があります:\n  " + "\n  ".join(bad))
    if not foods_raw:
        raise ConvertError("食品の行が見つかりません")

    # 単語・読み・言い換え
    all_words = {}  # 単語 → 出現食品数
    for _, raw_name, _, _ in foods_raw:
        for w in set(split_words(raw_name)):
            all_words[w] = all_words.get(w, 0) + 1
    unknown_words = sorted(w for w in all_words if w not in readings)
    unused_readings = sorted(w for w in readings if w not in all_words)
    rule_unknown = sorted({w for r in rules for k in ("any", "all", "none") for w in r.get(k, [])
                           if w not in all_words})

    terms = set()

    def add_term(s):
        n = normalize(s)
        if n and not is_single_hiragana(n):
            terms.add(n)

    foods, alias_food_count, rule_hits = [], 0, [0] * len(rules)
    missing_labels = []
    kana_table = kana_kanji_map(readings)
    for code, raw_name, values, estimated in foods_raw:
        words = split_words(raw_name)
        wordset = set(words)
        extras = []
        label = labels.get(code)
        if label is None:
            missing_labels.append(f"{code} {display_name(raw_name)}")
        else:
            # 分かりやすい名前も単語に分けて search と terms に加える（「鶏皮」「ツナ缶」でも探せるように）
            for w in split_label(label):
                add_term(w)
                extras.append(w)
        for w in words:
            add_term(w)
            for form in readings.get(w, []):
                add_term(form)
                extras.append(form)
        matched = False
        for i, rule in enumerate(rules):
            if rule_matches(rule, wordset):
                matched = True
                rule_hits[i] += 1
                extras.extend(rule["add"])
        if matched:
            alias_food_count += 1
        # 単語の境目をまたいで一致しないよう、食品名も単語ごとにスペースで区切る
        # （例：「ココナッツ　ナタデココ」を続けると「つな」が一致してしまう）
        search = " ".join(dict.fromkeys(n for n in (normalize(w) for w in words) if n))
        for x in extras:
            n = normalize(x)
            if not n or is_single_hiragana(n) or n in search:
                continue
            search += " " + n
        food = {"code": code, "name": display_name(raw_name)}
        if label is not None:
            food["label"] = label
            food["labelKeys"] = label_keys(label, kana_table)
        food["search"] = search
        food.update(values)
        if estimated:
            food["estimated"] = True
        foods.append(food)
    for rule in rules:
        for a in rule["add"]:
            add_term(a)

    out = {
        "source": SOURCE_NAME,
        "updated": updated,
        "terms": sorted(terms, key=lambda t: (-len(t), t)),
        "foods": foods,
    }
    info = {
        "header_row": header_row, "cols": cols, "stats": stats, "excluded": excluded,
        "unknown_words": unknown_words, "unused_readings": unused_readings, "rule_unknown": rule_unknown,
        "all_words": all_words, "readings": readings, "rules": rules, "rule_hits": rule_hits,
        "alias_food_count": alias_food_count,
        "labels": labels, "missing_labels": missing_labels,
        "unused_labels": sorted(c for c in labels if c not in {f[0] for f in foods_raw}),
        "dup_labels": sorted(l for l, n in collections.Counter(f["label"] for f in foods if "label" in f).items() if n > 1),
    }
    return out, info


def write_json(path, data):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)
    return len(text.encode("utf-8"))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except AttributeError:
            pass
    ap = argparse.ArgumentParser(description="成分表の Excel を seibun.json に変換する")
    ap.add_argument("xlsx", nargs="?", help="成分表の Excel（省略時は tools/ の .xlsx）")
    ap.add_argument("-o", "--output", default=OUTPUT_PATH, help="出力先（既定: ルートの seibun.json）")
    ap.add_argument("--readings", default=READINGS_PATH, help="読み・表記の辞書")
    ap.add_argument("--aliases", default=ALIASES_PATH, help="言い換え表")
    ap.add_argument("--labels", default=LABELS_PATH, help="分かりやすい名前の表")
    ap.add_argument("--try", dest="queries", nargs="*", default=[], help="検索の確認例を表示する語")
    args = ap.parse_args(argv)

    try:
        xlsx = args.xlsx or find_default_xlsx()
        out, info = convert(xlsx, args.readings, args.aliases, args.labels)
        size = write_json(args.output, out)
    except ConvertError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1

    foods = out["foods"]
    print(f"入力: {xlsx}（シート「{SHEET_NAME}」、成分識別子は{info['header_row']}行目、更新日 {out['updated']}（1行目））")
    print("列: " + "、".join(f"{key}={col}列" for col, key, _ in info["cols"]))
    print(f"出力: {args.output}  {len(foods)}件  {size:,}バイト（{size / 1024:.1f}KB）")
    print(f"除外（未測定 - を含む）: {len(info['excluded'])}件")
    for code, name, keys in info["excluded"]:
        print(f"  {code} {name}（{'・'.join(keys)}）")
    st = info["stats"]
    print("変換ルールの該当数（値の個数）:")
    for label, kind in (("Tr → 0", "tr"), ("(Tr) → 0（推計）", "est_tr"), ("(数値) → 数値（推計）", "est")):
        per = "、".join(f"{k} {v}" for k, v in st[kind].items())
        print(f"  {label}: 計{sum(st[kind].values())}（{per}）")
    est_n = sum(1 for f in foods if f.get("estimated"))
    print(f"推計値を含む食品（estimated: true）: {est_n}件")
    print(f"分かりやすい名前（label）: {sum(1 for f in foods if 'label' in f)}件／{len(foods)}件"
          f"、最長 {max((len(f['label']) for f in foods if 'label' in f), default=0)}文字")
    if info["missing_labels"]:
        print(f"警告: tools/seibun_labels.json にない食品番号が {len(info['missing_labels'])}件あります（label なしで出力。アプリでは正式名を使う）:")
        for m in info["missing_labels"]:
            print(f"  {m}")
    if info["dup_labels"]:
        print("警告: 同じ名前（label）の食品があります: " + "、".join(info["dup_labels"]))
    if info["unused_labels"]:
        print(f"参考: 今回の Excel にない（または除外した）食品番号の label: {len(info['unused_labels'])}件: "
              + "、".join(info["unused_labels"][:20]))

    readings, all_words = info["readings"], info["all_words"]
    no_form = sorted(w for w in all_words if w in readings and not readings[w])
    kanji_re = re.compile(r"[一-鿿々]")
    print(f"読み・表記の辞書: {len(readings)}語（今回の食品名の単語 {len(all_words)}語）")
    print(f"  読み・表記が付かなかった語: {len(no_form)}語"
          f"（うち漢字を含む語 {sum(1 for w in no_form if kanji_re.search(w))}語）")
    print("  例: " + "、".join(no_form[:40]) + (" …" if len(no_form) > 40 else ""))
    if info["unknown_words"]:
        print(f"注意: 辞書にない単語が {len(info['unknown_words'])}語あります（tools/seibun_readings.json に追加してください）:")
        print("  " + "、".join(info["unknown_words"]))
    if info["unused_readings"]:
        print(f"参考: 今回の食品名に出てこない辞書の語: {len(info['unused_readings'])}語: "
              + "、".join(info["unused_readings"][:20]))
    if info["rule_unknown"]:
        print("注意: 言い換え表に、食品名に出てこない単語があります: " + "、".join(info["rule_unknown"]))
    print(f"言い換え表: {len(info['rules'])}ルール、言い換えが付いた食品 {info['alias_food_count']}件")
    for rule, hits in zip(info["rules"], info["rule_hits"]):
        cond = "・".join(rule["any"])
        if rule.get("all"):
            cond += " かつ " + "・".join(rule["all"])
        if rule.get("none"):
            cond += " ただし " + "・".join(rule["none"]) + " を除く"
        print(f"  {cond} → {'・'.join(rule['add'])}（{hits}件）" + ("  ※該当なし" if hits == 0 else ""))
    print(f"terms: {len(out['terms'])}語")

    if args.queries:
        terms_set = set(out["terms"])
        max_len = max(len(t) for t in out["terms"])
        print("確認例（正規化 → terms で区切り → 区切った語がすべて当たる食品。並びはアプリと同じ）:")
        for q in args.queries:
            segs = list(dict.fromkeys(s for w in q.split() for s in segment(w, terms_set, max_len)))
            hits = search_foods(foods, q, segs, terms_set, max_len)
            print(f"  「{q}」→ {normalize(q)} → {' / '.join(segs)} → {len(hits)}件")
            for f in hits[:5]:
                print(f"      {f['code']} {f['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
