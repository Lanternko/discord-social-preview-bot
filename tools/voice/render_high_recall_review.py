#!/usr/bin/env python3
"""Render a local, preliminary listening page for a high-recall report."""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path


TEMPLATE = """<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>西寶 S1 高召回重掃</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#11131a;color:#eef1f8}
header{position:sticky;top:0;z-index:2;background:#191c27;padding:14px 18px;border-bottom:1px solid #34394c}
h1{font-size:20px;margin:0 0 8px}.note{color:#f4c86a}.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input,button{font:inherit;background:#252a3a;color:#fff;border:1px solid #454d68;border-radius:7px;padding:7px}
button{cursor:pointer}.active{background:#4f63d8}.stats{color:#aeb6ce;margin:7px 0 0}
main{max-width:1050px;margin:auto;padding:14px}.card{border:1px solid #32384c;border-radius:10px;padding:12px;margin:10px 0;background:#191c27}
.meta{color:#aeb6ce;font-size:13px}.subtitle{font-size:18px;margin:8px 0}.actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.target{border-color:#3cbb72}.other{border-color:#d85b69}.uncertain{border-color:#d6a63b}audio{width:min(620px,100%)}
</style></head><body><header><h1>西寶第一季：高召回重掃</h1>
<div class="note">這是待人工複核佇列，不是西的台詞清單。聲紋分數未校準；短反應句完全不以聲紋淘汰。</div>
<div class="controls"><select id="episode"><option value="">全部集數</option></select>
<select id="lane"><option value="">兩條路徑</option><option value="spoken_low_threshold">較長台詞</option><option value="short_reaction_unfiltered">短反應（無聲紋 gate）</option></select>
<label>最低 score <input id="score" type="number" min="0" max="1" step=".05" value="0"></label>
<select id="status"><option value="">全部狀態</option><option value="unreviewed">未審</option><option value="target">西</option><option value="other">不是西</option><option value="uncertain">不確定</option></select>
<button id="export">匯出標記 JSON</button></div><div class="stats" id="stats"></div></header><main id="list"></main>
<script>
const report=__REPORT__; const key='xibao-high-recall-s1-v1'; let marks=JSON.parse(localStorage.getItem(key)||'{}');
const $=id=>document.getElementById(id), ep=$('episode'), lane=$('lane'), score=$('score'), status=$('status'), list=$('list');
for(const name of Object.keys(report.per_episode)){const o=document.createElement('option');o.value=name;o.textContent=name;ep.appendChild(o)}
const idOf=c=>`${c.source_id}__${Math.round(c.start_s*1000)}-${Math.round(c.end_s*1000)}`;
let playing=null, timer=null;
function play(c,button){if(playing){playing.pause();playing.remove();clearInterval(timer)} const a=document.createElement('audio');a.controls=true;a.preload='metadata';button.after(a);playing=a;
 if(c.review_audio_url){a.src=c.review_audio_url;a.play();return} a.src=`../full-audio/${c.source_id}.wav`;const start=()=>{a.currentTime=c.start_s;a.play();timer=setInterval(()=>{if(a.currentTime>=c.end_s){a.pause();clearInterval(timer)}},40)};
 if(a.readyState>=1)start();else a.addEventListener('loadedmetadata',start,{once:true});}
function mark(id,value){if(value)marks[id]=value;else delete marks[id];localStorage.setItem(key,JSON.stringify(marks));render()}
function render(){const rows=report.candidates.filter(c=>(!ep.value||c.source_id===ep.value)&&(!lane.value||c.lane===lane.value)&&c.retrieval_score>=+score.value&&
 (!status.value||(status.value==='unreviewed'?!marks[idOf(c)]:marks[idOf(c)]===status.value)));list.replaceChildren();
 $('stats').textContent=`顯示 ${rows.length} / ${report.candidate_count}；已標記 ${Object.keys(marks).length}`;
 for(const c of rows){const id=idOf(c),card=document.createElement('section');card.className='card '+(marks[id]||'');
  card.innerHTML=`<div class="meta">${id}　${c.duration_s.toFixed(2)} 秒　${c.lane==='spoken_low_threshold'?'較長台詞':'短反應'}　retrieval score ${c.retrieval_score.toFixed(4)}</div><div class="subtitle"></div><div class="actions"><button class="listen">▶ 播放此段</button><button data-m="target">西</button><button data-m="other">不是西</button><button data-m="uncertain">不確定</button><button data-m="">清除</button></div>`;
  card.querySelector('.subtitle').textContent=c.subtitle_zh||'（無字幕）';card.querySelector('.listen').onclick=e=>play(c,e.currentTarget);
  card.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>mark(id,b.dataset.m));list.appendChild(card)}}
[ep,lane,score,status].forEach(x=>x.oninput=render);$('export').onclick=()=>{const payload={schema_version:'pilotfish.high_recall_human_marks.v1',report_schema:report.schema_version,marks};
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));a.download='s1-high-recall-marks.json';a.click();URL.revokeObjectURL(a.href)};render();
</script></body></html>"""


def render(report: dict) -> str:
    payload = json.dumps(report, ensure_ascii=False).replace("</", "<\\/")
    return TEMPLATE.replace("__REPORT__", payload)


def materialize_clips(report: dict, clips_dir: Path) -> None:
    """Cut small PCM WAVs so browser review never downloads a whole episode."""
    clips_dir.mkdir(parents=True, exist_ok=True)
    for candidate in report.get("candidates", []):
        start_ms = round(candidate["start_s"] * 1000)
        end_ms = round(candidate["end_s"] * 1000)
        name = f'{candidate["source_id"]}__{start_ms:09d}-{end_ms:09d}.wav'
        output = clips_dir / name
        with wave.open(candidate["audio_path"], "rb") as source:
            rate = source.getframerate()
            source.setpos(round(candidate["start_s"] * rate))
            frames = source.readframes(round((candidate["end_s"] - candidate["start_s"]) * rate))
            with wave.open(str(output), "wb") as target:
                target.setnchannels(source.getnchannels())
                target.setsampwidth(source.getsampwidth())
                target.setframerate(rate)
                target.setcomptype(source.getcomptype(), source.getcompname())
                target.writeframes(frames)
        candidate["review_audio_url"] = f"clips/{name}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--clips-dir")
    args = parser.parse_args()
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.clips_dir:
        materialize_clips(report, Path(args.clips_dir))
    out.write_text(render(report), encoding="utf-8")
    print(out.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
