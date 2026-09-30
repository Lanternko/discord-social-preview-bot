#!/usr/bin/env python3
"""summarize_eps.py — 每集「西視角」劇情摘要(Phase 3 canon 的素材)。

LLM 讀整集歸屬表(attrib/epNN.attrib.json),寫出:這集西經歷了什麼、跟誰、
她怎麼反應、關係有什麼推進。每個論點都要附句 id(之後能回查原句,避免 LLM 腦補劇情——
網路上有把西和東個性寫反的摘要,這裡只信台詞)。

輸出:$XIBAO_ROOT/persona/canon/epNN.md
跑法:python3 tools/persona/summarize_eps.py [ep13 ...](冪等;--force 重跑)
模型/金鑰沿用 attribute.py。
"""

import json
import sys
import urllib.request

sys.path.insert(0, __import__("os").path.dirname(__file__))
from attribute import MODEL, ROOT, URL, load_key  # noqa: E402

SYSTEM = """你在替動畫《正反對的你與我》整理「西奈津美(西)」的角色資料,要拿來寫她的 AI 角色設定。
給你一整集的逐句表(id、時間、推定說話人/信心、kind、繁中字幕、日語聽寫)。
說話人是自動推定的,可能有錯——跟上下文衝突時以上下文為準,並在摘要裡註明你改判的地方。

用繁體中文輸出 Markdown,段落如下(沒有就寫「無」):
## 本集大綱
三到五句,整集在演什麼(不限西)。
## 西的戲份
條列:西做了什麼、說了什麼、對誰。每條結尾附佐證句 id,如 [#123 #125]。
## 西的人際關係
對山田、本田、谷、鈴木、其他人,這集有什麼推進或互動模式。附句 id。
## 西的個性表現
她害羞、憋笑、內心吐槽、宅、猶豫、勇敢……的具體瞬間,和她怎麼講話(語氣、口頭禪、自嘲方式)。附句 id。
## 可當範例的台詞
挑 3~8 句最能代表西說話方式的句子,格式:[#id] 繁中字幕 / 日語。
## 其他角色對西的看法
別人怎麼說她、怎麼叫她。附句 id。

只寫台詞裡看得到的事;推測要標「(推測)」。不要引用你對原作的記憶補劇情。"""


def fmt(l):
    return f'#{l["id"]} {l["start"]:.0f}s [{l["speaker"]}/{l["conf"]}/{l["kind"]}] {l["zh"]} | {l["ja"] or "-"}'


def summarize(key, ep, force=False):
    out = ROOT / "persona" / "canon" / f"{ep}.md"
    if out.exists() and not force:
        print(f"[skip] {out.name}")
        return
    lines = json.load((ROOT / "attrib" / f"{ep}.attrib.json").open(encoding="utf-8"))
    body = {"model": MODEL, "temperature": 0, "reasoning_effort": "medium", "max_tokens": 32000,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": f"第 {int(ep[2:])} 集:\n" + "\n".join(map(fmt, lines))}]}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(f"# 第 {int(ep[2:])} 集\n\n" + d["choices"][0]["message"]["content"], encoding="utf-8")
    print(f"[{ep}] cost={d.get('usage', {}).get('cost')}", flush=True)


if __name__ == "__main__":
    force = "--force" in sys.argv
    eps = [a for a in sys.argv[1:] if not a.startswith("-")] \
        or sorted(p.stem.split(".")[0] for p in (ROOT / "attrib").glob("ep??.attrib.json"))
    key = load_key()
    for ep in eps:
        summarize(key, ep, force)
