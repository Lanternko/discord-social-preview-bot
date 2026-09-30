#!/usr/bin/env python3
"""mine_tics.py — 西的台詞語料彙整 + 口癖頻率探勘(Phase 1)。

照 arale-persona-bot/tools/persona/mine_tics.py 的方法論,差別:
- 只有動畫一種語料(沒有直播),但有兩個語言面:
  日語音軌(Whisper,register 權威:語尾、自稱、敬語)與
  繁中字幕(西寶在 Discord 講繁中,這是她「實際會打出來的字」最直接的參考)。
- 語料來源 = attrib/epNN.attrib.json 裡 speaker=西 的句子;conf=high 為主,
  mid 另外計數(歸屬實測:mid 以上精確率約 0.83,見 eval_attrib.py)。
- 分季統計:第一季(ep01–12)和第二季(ep13–24)分開,看西交往後語氣有沒有變。

標註規則:
- 西 count >= 3 且「西的出現率 / 其他角色出現率」>= 1.5 → EXTRACTED(西的特徵)
- 西 count >= 3 但不比別人高 → COMMON(大家都這樣講,不算她的口癖)
- 其他 → 不收(表裡留 count 供人工判讀)

輸出(在 $XIBAO_ROOT/persona/):
- nishi_lines.jsonl   西的每一句(ep、時間、zh、ja、kind、conf)
- tics-report.json / tics-report.md

跑法:python3 tools/persona/mine_tics.py(純 CPU、冪等)
"""

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
OUT = ROOT / "persona"
KEEP_KINDS = ("dialogue", "monologue")

CATEGORIES_JA = {
    "自稱": ["私", "わたし", "あたし", "うち"],
    "語尾": ["です", "ます", "けど", "かな", "よね", "だよ", "じゃん", "っけ", "かも", "もん", "でしょ", "のに"],
    "填充/猶豫": ["えっと", "あの", "その", "なんか", "ちょっと", "あっ", "え、", "いや"],
    "道歉/客氣": ["ごめん", "すみません", "すいません", "ありがとう"],
    "反應": ["そっか", "なるほど", "たしかに", "確かに", "ほんと", "本当", "まじ", "やば", "すご", "かわい", "ふふ", "ははは"],
    "內心吐槽": ["なんで", "いや", "だめ", "無理", "キモ", "気まず", "恥ずかし"],
}
CATEGORIES_ZH = {
    "開場/猶豫": ["那個", "呃", "嗯", "欸", "啊", "咦", "……", "…", "這個嘛"],
    "語尾": ["吧", "耶", "啦", "呢", "嗎", "喔", "哦", "欸"],
    "道歉/客氣": ["抱歉", "對不起", "不好意思", "謝謝"],
    "反應": ["真的", "好厲害", "太好了", "好可愛", "好好笑", "不行", "糟了", "等一下"],
    "自我吐槽": ["我在說什麼", "好噁心", "太噁心", "尷尬", "害羞", "緊張", "怎麼辦", "為什麼"],
    "程度": ["超", "太", "好", "有點", "稍微", "完全"],
}


def load_all():
    rows = []
    for p in sorted((ROOT / "attrib").glob("ep??.attrib.json")):
        ep = p.stem.split(".")[0]
        for l in json.load(p.open(encoding="utf-8")):
            if l.get("kind") in KEEP_KINDS:
                rows.append({**l, "ep": ep, "season": 1 if int(ep[2:]) <= 12 else 2})
    return rows


def count(text_list, token):
    pat = re.compile(re.escape(token))
    return sum(len(pat.findall(t)) for t in text_list)


def per10k(n, chars):
    return round(n / max(chars, 1) * 10000, 2)


def mine(xi, others, field, categories):
    out = []
    xi_txt = [r[field] for r in xi if r[field]]
    ot_txt = [r[field] for r in others if r[field]]
    xi_chars, ot_chars = sum(map(len, xi_txt)), sum(map(len, ot_txt))
    for cat, tokens in categories.items():
        for tok in tokens:
            n_xi, n_ot = count(xi_txt, tok), count(ot_txt, tok)
            r_xi, r_ot = per10k(n_xi, xi_chars), per10k(n_ot, ot_chars)
            ratio = round(r_xi / r_ot, 2) if r_ot else None
            tag = ("EXTRACTED" if ratio is None or ratio >= 1.5 else "COMMON") if n_xi >= 3 else "-"
            s1 = count([r[field] for r in xi if r["season"] == 1 and r[field]], tok)
            s2 = count([r[field] for r in xi if r["season"] == 2 and r[field]], tok)
            ex = [f'{r["ep"]}@{r["start"]:.0f}s {r[field]}' for r in xi if r[field] and tok in r[field]][:3]
            out.append({"lang": field, "category": cat, "token": tok, "xi": n_xi, "xi_s1": s1, "xi_s2": s2,
                        "xi_per10k": r_xi, "others_per10k": r_ot, "ratio": ratio, "tag": tag, "examples": ex})
    return out


def main():
    OUT.mkdir(exist_ok=True)
    rows = load_all()
    xi = [r for r in rows if r["speaker"] == "西" and r["conf"] in ("high", "mid")]
    others = [r for r in rows if r["speaker"] not in ("西", "?")]
    with (OUT / "nishi_lines.jsonl").open("w", encoding="utf-8") as f:
        for r in xi:
            f.write(json.dumps({k: r[k] for k in ("ep", "season", "id", "start", "end", "zh", "ja", "kind", "conf",
                                                   "voice_margin")}, ensure_ascii=False) + "\n")
    report = mine(xi, others, "ja", CATEGORIES_JA) + mine(xi, others, "zh", CATEGORIES_ZH)
    summary = {
        "episodes": sorted({r["ep"] for r in rows}),
        "xi_lines": len(xi), "xi_high": sum(r["conf"] == "high" for r in xi),
        "xi_s1": sum(r["season"] == 1 for r in xi), "xi_s2": sum(r["season"] == 2 for r in xi),
        "xi_monologue_ratio": round(sum(r["kind"] == "monologue" for r in xi) / max(len(xi), 1), 2),
        "others_lines": len(others),
    }
    json.dump({"summary": summary, "tics": report}, (OUT / "tics-report.json").open("w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    md = ["# 西 口癖報告(自動產生,mine_tics.py)", "", "```", json.dumps(summary, ensure_ascii=False), "```", ""]
    for lang in ("ja", "zh"):
        md += [f"## {lang}", "", "| 類別 | token | 西 | S1 | S2 | 西/萬字 | 他人/萬字 | 比 | 標註 | 例句 |",
               "|---|---|---|---|---|---|---|---|---|---|"]
        for t in sorted((t for t in report if t["lang"] == lang), key=lambda t: (t["category"], -t["xi"])):
            md.append(f'| {t["category"]} | {t["token"]} | {t["xi"]} | {t["xi_s1"]} | {t["xi_s2"]} | '
                      f'{t["xi_per10k"]} | {t["others_per10k"]} | {t["ratio"]} | {t["tag"]} | '
                      f'{"<br>".join(t["examples"]).replace("|", "/")} |')
        md.append("")
    (OUT / "tics-report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"[tics] {summary}")
    for t in report:
        if t["tag"] == "EXTRACTED":
            print(f'  {t["lang"]} {t["category"]} {t["token"]} xi={t["xi"]} (S1 {t["xi_s1"]}/S2 {t["xi_s2"]}) ratio={t["ratio"]}')


if __name__ == "__main__":
    main()
