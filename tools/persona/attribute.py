#!/usr/bin/env python3
"""attribute.py — LLM 讀整集逐句表,標出每句是誰講的(Phase 0 歸屬)。

阿拉蕾的歸屬是「聲紋 × LLM 上下文 × 截幀」三重;西寶這邊聲紋只能當佐證
(ECAPA 分不出西和同性別配角),主力是 LLM 讀上下文 + 日語語尾/自稱。
不確定的句子一律標 low,下游 mine/fewshot 只吃 high(+mid 另列)。

輸入:lines/epNN.lines.json(join_lines.py)
輸出:attrib/epNN.attrib.json — lines 的每筆加 {speaker, conf, kind}
模型:Vercel AI Gateway(OpenAI 相容),預設 anthropic/claude-sonnet-5.5,
     金鑰只讀 PERSONA_GATEWAY_KEY(使用者另給的專用 key;禁止讀 bot .env)。
跑法:python3 tools/persona/attribute.py [ep01 ...](冪等;--force 重跑)
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
MODEL = os.environ.get("ATTRIB_MODEL", "anthropic/claude-sonnet-5.5")
URL = "https://ai-gateway.vercel.sh/v1/chat/completions"

CAST = ["西", "山田", "鈴木", "谷", "平", "東", "本田", "渡邊", "其他", "?"]
KINDS = ["dialogue", "monologue", "screen", "lyric"]

SYSTEM = f"""你在替動畫《正反對的你與我》(正反対な君と僕)做逐句說話人標註。
主要角色(用姓稱呼;特徵摘自英文維基的角色介紹):
- 鈴木(鈴木實優):女主角,開朗外向,班上的中心人物。
- 谷(谷悠介):男主角,內向冷靜、意見清楚。
- 山田(山田健太郎):鈴木國中起的好友,怪、少根筋,常跟谷借作業。
- 西(西奈津美):別班、非常害羞,和谷一起當圖書委員;覺得大家的蠢事超好笑,但會因為害羞把笑憋住。
- 本田(本田梨花子):西的死黨、同班;會抿嘴忍笑;對朋友好,對不熟或惹她的人很嫌棄。
- 東(東紫乃):很在意在別人面前酷不酷、想太多,自信心極低;過去的戀愛經驗讓她有點看破。
- 平(平秀司):厭世自嘲、在附近超商打工,很在意人際位階。
- 渡邊(渡邊真奈美):鈴木高一認識的好友,超活潑愛鬧、跟山田一樣少根筋。
其他人一律標「其他」;真的無法判斷標「?」。

關係與辨識線索(標錯最常見的地方):
- 鈴木和谷在第一季前段就交往了。提到「谷同學」、擔心在谷面前的樣子、「有男朋友之後…」
  這類話幾乎都是鈴木;鈴木叫谷「谷同學」(谷くん)。
- 西在第一季中段(約第 5、6 集起)開始和山田傳訊息、被他約,但自己很不擅長回訊息;
  第二季兩人慢慢走近、情人節前後告白並開始交往。跟山田傳訊息/被山田約的煩惱幾乎都是西。
  西是宅、說話前會猶豫、心裡吐槽很多;會對本田解釋自己怕生、話說不出口。
- 內心獨白(monologue)屬於「這段的視角角色」:大多數段落是鈴木,
  但也有以西、山田、谷、平、東為視角的段落——看獨白內容講的是誰的處境。
  連續一大段獨白通常同一人,但換場後要重新判斷。
- 日語自稱:男生多用「俺/僕」,女生多用「私/あたし」——只能分男女,分不出哪個女生。
- 西和東都是會自我懷疑、內心戲很多的女生,聲紋也分不開:
  「怕在別人面前不夠酷、過去的戀愛、跟平有關」偏東;「憋笑、圖書委員、和本田一起、宅、跟山田有關」偏西。
  拿不準就標 mid/low,不要給 high。
- 朋友叫西「にっさん」(字幕可能是「西」「小西」之類);被這樣叫的人、回應這個稱呼的人是西。
- 家裡的場景有家人(兄弟姊妹、父母)——他們標「其他」,不要硬塞給山田或谷。
- vm 連續多句明顯為負時,不要標西;西的台詞 vm 通常 ≥ 0。

每句給你:id、時間、畫面繁中字幕(zh)、音軌日語聽寫(ja,可能有錯或混入鄰句)、
聲紋分數 vm(越高越像西的聲音;null=太短沒算)。乾淨語音上校準過:vm ≥ +0.02 大概是西
(精確率約八成),vm ≤ -0.02 幾乎不會是西;但動畫有配樂和疊話,實際會更不準——只是輔助,
和上下文衝突時以上下文為準。

判斷依據優先序:對話上下文(誰回誰、稱呼對象、劇情)> 日語語尾與自稱(俺/僕/私/あたし、〜だぜ/〜わ)> vm。
kind:dialogue=說出口的台詞;monologue=內心獨白;screen=畫面文字/標題/字卡;lyric=OP/ED 或插入歌詞。
conf:high=幾乎確定;mid=大概;low=猜的。寧可標 low,不要硬標 high。

只輸出 TSV,每句一行,不要任何其他文字:
id<TAB>speaker<TAB>kind<TAB>conf
speaker 只能是:{"、".join(CAST)}。"""


def load_key():
    key = os.environ.get("PERSONA_GATEWAY_KEY")
    if not key:
        sys.exit("PERSONA_GATEWAY_KEY not set (bot 的 .env key 不准借用;先問使用者)")
    return key


def fmt_line(l):
    vm = "null" if l["voice_margin"] is None else f'{l["voice_margin"]:+.2f}'
    return f'{l["id"]}\t{l["start"]:.1f}\tzh={l["zh"]}\tja={l["ja"] or "-"}\tvm={vm}'


def call(key, ep, lines):
    body = {
        "model": MODEL,
        "temperature": 0,
        # sonnet 經 gateway 預設會想很久:16000 token 全花在 reasoning、一句 TSV 都沒吐(ep04 實測)。
        "reasoning_effort": os.environ.get("ATTRIB_EFFORT", "medium"),
        "max_tokens": 64000,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"第 {int(ep[2:])} 集,共 {len(lines)} 句:\n"
             + "\n".join(fmt_line(l) for l in lines)},
        ],
    }
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    return d["choices"][0]["message"]["content"], d.get("usage", {})


def parse(text):
    out = {}
    for row in text.splitlines():
        parts = [p.strip() for p in row.split("\t")]
        if len(parts) != 4 or not parts[0].isdigit():
            continue
        lid, spk, kind, conf = parts
        if spk not in CAST or kind not in KINDS or conf not in ("high", "mid", "low"):
            continue
        out[int(lid)] = {"speaker": spk, "kind": kind, "conf": conf}
    return out


def attribute(key, ep, force=False):
    out = ROOT / "attrib" / f"{ep}.attrib.json"
    if out.exists() and not force:
        print(f"[skip] {out.name}")
        return
    lines = json.load((ROOT / "lines" / f"{ep}.lines.json").open(encoding="utf-8"))
    t0 = time.time()
    text, usage = call(key, ep, lines)
    labels = parse(text)
    missing = [l["id"] for l in lines if l["id"] not in labels]
    merged = [{**l, **labels.get(l["id"], {"speaker": "?", "kind": "dialogue", "conf": "low"})}
              for l in lines]
    out.parent.mkdir(exist_ok=True)
    json.dump(merged, out.open("w", encoding="utf-8"), ensure_ascii=False, indent=1)
    xi = [m for m in merged if m["speaker"] == "西"]
    print(f"[{ep}] {time.time()-t0:.0f}s labels={len(labels)}/{len(lines)} missing={len(missing)} "
          f"西={len(xi)} (high={sum(m['conf']=='high' for m in xi)}) usage={usage}", flush=True)


if __name__ == "__main__":
    force = "--force" in sys.argv
    eps = [a for a in sys.argv[1:] if not a.startswith("-")] \
        or sorted(p.stem.split(".")[0] for p in (ROOT / "lines").glob("ep*.lines.json"))
    key = load_key()
    for ep in eps:
        attribute(key, ep, force)
