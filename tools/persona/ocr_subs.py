#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_subs.py（複製自 arale-persona-bot/tools/ocr_subs.py；西寶版加了幀差跳過，見 TEXT_MASK_*） — 燒錄繁中字幕 → 帶時間軸的逐句字幕檔 (.srt + .json)

以 ffmpeg 依 SAMPLE_FPS 抽幀並裁切底部字幕帶，對每幀跑 RapidOCR（繁中），
把連續相同文字合併成字幕事件 (start/end)，輸出 .srt 與 .json。

用法：
    python ocr_subs.py <mp4> <out_prefix>
        <out_prefix> 產出 <out_prefix>.srt 與 <out_prefix>.json

crop / fps / 閾值等所有可調參數集中在下方常數區。

驗證來源：BanG Dream! YUME∞MITA 第 1 集（1280x720 巴哈動畫瘋源）。
字幕帶實測落在 y≈630-695（單行）；雙行字幕上緣可達 y≈590。
故 crop 蓋 y=572..708，同時涵蓋單行與雙行。

已知限制：
  * 極少數對白會被抬到畫面「上緣」（y≈50）以避開下方畫面（ep1 全片抽樣
    僅約 1/40 幀），本腳本只掃底部帶，會漏掉這些上緣字幕。若要補，可另開
    一條 top-band（y≈20..110）掃描——但那區也常出現 OP/ED 製作人員名單與
    場景文字，加了會拉低精確率，故預設不做。
  * 雙人對話字幕（各行以 "- " 起頭）會被併成一個事件，行間以全形空白分隔；
    下游要拆單句時 split("　") 即可。
  * RapidOCR 字典偶爾把「畫面上是繁體」的字輸出成簡體，已用 _S2T 表扳回；
    仍有極少數視覺相近誤認（如 並↔亞）與偶發漏字無法純規則修正。
"""

import sys
import os
import re
import json
import shutil
import tempfile
import subprocess
import glob
import unicodedata

import numpy as np

# ---------------------------------------------------------------------------
# 可調參數（tunable constants）
# ---------------------------------------------------------------------------

# 抽幀頻率（每秒幾幀）。2fps = 每 0.5s 一幀，足以抓住短字幕又不過量。
SAMPLE_FPS = 2.0

# 幀差跳過（西寶版新增）：白色像素門檻、少於幾個白像素視為無字幕、遮罩差異比例門檻。
# 遮罩 = 白（三通道都 > TEXT_MASK_MIN）且 2px 內有黑框（< TEXT_EDGE_DARK）的像素——字幕白字黑框，
# 背景的亮塊不會進來。ep01 實測：有字幕幀 ~1000px、雜訊 26~48px；同一句連續幀差異 0.00。
TEXT_MASK_MIN = 200
TEXT_EDGE_DARK = 70
TEXT_MASK_MIN_PX = 150
SAME_MASK_RATIO = 0.15

# 字幕帶裁切區域（相對 1280x720 影格；非此解析度時會等比縮放）。
# 涵蓋單行（y≈630-695）與雙行字幕（上緣 y≈590）。
CROP_REF_W = 1280          # 參考影格寬（決定 crop 的比例基準）
CROP_REF_H = 720           # 參考影格高
CROP_X = 0                 # crop 左上 x
CROP_Y = 572               # crop 左上 y
CROP_W = 1280              # crop 寬
CROP_H = 136               # crop 高（572..708）

# OCR 前放大倍率（超解析度小字，明顯提升繁中字形辨識率）。
OCR_UPSCALE = 2.0

# 信心閾值：低於此的 OCR 結果直接丟棄。
MIN_CONF = 0.60

# 單字元噪點過濾：長度<=此值且信心低於 SINGLE_CHAR_CONF 的片段丟棄。
SINGLE_CHAR_MAX_LEN = 1
SINGLE_CHAR_CONF = 0.90

# 位置過濾：字幕是水平置中的。box 中心 x 必須落在 [左邊界, 右邊界] 比例內，
# 藉此濾掉貼在左/右緣的製作人員名單、招牌等場景文字。
CENTER_MIN_RATIO = 0.06    # box 中心 x / cropW 下限
CENTER_MAX_RATIO = 0.94    # box 中心 x / cropW 上限

# 行分群：兩個 box 的 y 中心差 < 這個像素數（相對 OCR 放大後座標）視為同一行。
LINE_Y_TOLERANCE = 30

# 去重正規化後，連續幀文字相同即合併為一個事件。
# 事件最短持續幀數（過濾一閃即逝的 OCR 抖動雜訊）。
MIN_EVENT_FRAMES = 1       # 1 = 不因短而丟；靠信心/正規化去雜訊

# 相鄰事件文字若正規化後相同且間隔 <= 此秒數，視為同一句被打斷 → 合併。
MERGE_GAP_S = 0.6

# 事件末端外擴（字幕多半在該幀後仍顯示到下一取樣點前）。
EVENT_TAIL_S = 0.5 / SAMPLE_FPS  # 半個取樣間隔

# ffmpeg / OCR 執行設定
FFMPEG_BIN = "ffmpeg"
FFPROBE_BIN = "ffprobe"

# ---------------------------------------------------------------------------
# 文字正規化
# ---------------------------------------------------------------------------

# OCR 對繁中常見的抖動/異體字對映（把兩種寫法折成同一 key 以利去重）。
# 這裡只做「去重比較」用途的折疊，最終輸出保留出現最多次的原始 OCR 文字。
_CANON_MAP = {
    "妳": "你", "祢": "你",
    "着": "著",
    "麽": "麼", "麼": "麼",
    "裏": "裡",
}

# ---------------------------------------------------------------------------
# 簡→繁修正（S2T）
# ---------------------------------------------------------------------------
# RapidOCR 的辨識字典偶爾對「畫面上明明是繁體字」輸出對應的簡體字（帐/贴/纸/来…）。
# 沒有裝 OpenCC，這裡用一份聚焦動畫字幕高頻字的簡→繁對照表把它扳回繁體。
# 只收「簡體專用、繁體文本不會出現」的字，避免誤傷（如「著/着」已在上表另處理）。
_S2T = {
    "帐": "帳", "贴": "貼", "纸": "紙", "张": "張", "别": "別", "没": "沒",
    "欢": "歡", "来": "來", "圆": "圓", "较": "較", "亚": "亞", "个": "個",
    "顺": "順", "创": "創", "号": "號", "这": "這", "说": "說", "为": "為",
    "们": "們", "处": "處", "两": "兩", "画": "畫", "还": "還", "种": "種",
    "应": "應", "垫": "墊", "参": "參", "员": "員", "书": "書", "间": "間",
    "给": "給", "实": "實", "动": "動", "启": "啟", "录": "錄", "约": "約",
    "缔": "締", "结": "結", "质": "質", "图": "圖", "专": "專",
    "习": "習", "问": "問", "题": "題", "关": "關", "开": "開", "过": "過",
    "对": "對", "会": "會", "样": "樣", "东": "東", "车": "車", "远": "遠",
    "边": "邊", "进": "進", "运": "運", "选": "選", "记": "記", "认": "認",
    "识": "識", "让": "讓", "变": "變", "极": "極", "总": "總", "现": "現",
    "发": "發", "长": "長", "点": "點", "热": "熱", "级": "級", "转": "轉",
    "连": "連", "载": "載", "网": "網", "线": "線", "带": "帶", "从": "從",
    "华": "華", "宝": "寶", "价": "價", "买": "買", "卖": "賣",
    "钟": "鐘", "响": "響", "声": "聲", "静": "靜", "尔": "爾", "务": "務",
    "决": "決", "证": "證", "确": "確", "满": "滿", "闻": "聞",
    "馆": "館", "键": "鍵", "顾": "顧", "顿": "頓", "顶": "頂",
    "顽": "頑", "预": "預", "颂": "頌", "领": "領", "颇": "頗",
    # 驗證時實測補上的簡體字
    "删": "刪", "壶": "壺", "确": "確", "杀": "殺", "边": "邊", "币": "幣",
    "汇": "匯", "阴": "陰", "阳": "陽", "医": "醫", "毕": "畢", "岁": "歲",
    "尽": "盡", "层": "層", "属": "屬", "帮": "幫", "简": "簡", "签": "籤",
    "笔": "筆", "画": "畫", "释": "釋", "厉": "厲", "励": "勵", "梦": "夢",
    "组": "組", "织": "織", "细": "細", "纪": "紀", "级": "級", "继": "繼",
    "维": "維", "综": "綜", "缩": "縮", "绍": "紹", "绝": "絕", "绪": "緒",
    "绿": "綠", "缘": "緣", "练": "練", "绩": "績", "绑": "綁", "纯": "純",
    "纲": "綱", "纳": "納", "纵": "縱", "纷": "紛", "纸": "紙", "纽": "紐",
    "驾": "駕", "驶": "駛", "骑": "騎", "验": "驗", "惊": "驚", "拟": "擬",
    "扑": "撲", "扫": "掃", "护": "護", "报": "報", "拥": "擁", "挂": "掛",
    "挥": "揮", "换": "換", "损": "損", "搁": "擱", "摆": "擺", "击": "擊",
    "旧": "舊", "时": "時", "显": "顯", "晒": "曬", "暂": "暫", "术": "術",
    "杂": "雜", "极": "極", "构": "構", "枪": "槍", "档": "檔", "样": "樣",
    "标": "標", "栏": "欄", "树": "樹", "桥": "橋", "检": "檢", "楼": "樓",
    "欧": "歐", "歼": "殲", "残": "殘", "殇": "殤", "毁": "毀", "气": "氣",
    "汉": "漢", "汤": "湯", "沟": "溝", "泪": "淚", "泽": "澤", "洁": "潔",
    "浃": "浹", "涂": "塗", "涌": "湧", "润": "潤", "涨": "漲", "渐": "漸",
    "渊": "淵", "渔": "漁", "温": "溫", "灭": "滅", "灯": "燈", "灵": "靈",
    "炉": "爐", "烂": "爛", "烛": "燭", "烦": "煩", "热": "熱", "焕": "煥",
    "爱": "愛", "牵": "牽", "犹": "猶", "狈": "狽", "独": "獨", "狮": "獅",
    "猎": "獵", "猫": "貓", "献": "獻", "痒": "癢", "痪": "瘓", "疗": "療",
    "皱": "皺", "盘": "盤", "睁": "睜", "确": "確", "礼": "禮", "祸": "禍",
    "离": "離", "秃": "禿", "种": "種", "积": "積", "称": "稱", "笼": "籠",
    "筑": "築", "简": "簡", "篮": "籃", "粮": "糧", "紧": "緊",
    "绳": "繩", "缠": "纏", "网": "網", "罗": "羅", "罚": "罰", "羁": "羈",
    "翘": "翹", "耸": "聳", "聪": "聰", "肃": "肅", "肠": "腸", "肤": "膚",
    "肮": "骯", "胆": "膽", "脏": "臟", "脚": "腳", "脱": "脫", "腾": "騰",
    "膑": "臏", "艰": "艱", "节": "節", "芜": "蕪", "苏": "蘇",
    "茧": "繭", "荐": "薦", "药": "藥", "莲": "蓮", "获": "獲",
    "萝": "蘿", "营": "營", "蒋": "蔣", "蓝": "藍", "虏": "虜", "虫": "蟲",
    "蚀": "蝕", "蜡": "蠟", "蝇": "蠅", "补": "補", "袄": "襖", "装": "裝",
    "见": "見", "观": "觀", "规": "規", "视": "視", "览": "覽", "觉": "覺",
    "誉": "譽", "誊": "謄", "计": "計", "订": "訂", "认": "認", "讨": "討",
    "让": "讓", "训": "訓", "议": "議", "讯": "訊", "记": "記", "讲": "講",
    "讳": "諱", "论": "論", "讼": "訟", "设": "設", "访": "訪", "证": "證",
    "评": "評", "识": "識", "诈": "詐", "词": "詞", "译": "譯", "试": "試",
    "诗": "詩", "诚": "誠", "话": "話", "诞": "誕", "询": "詢", "该": "該",
    "详": "詳", "语": "語", "误": "誤", "说": "說", "请": "請", "诸": "諸",
    "读": "讀", "课": "課", "谁": "誰", "调": "調", "谅": "諒", "谈": "談",
    "谊": "誼", "谋": "謀", "谎": "謊", "谐": "諧", "谓": "謂", "谜": "謎",
    "谢": "謝", "谣": "謠", "谦": "謙", "谨": "謹", "谱": "譜", "贝": "貝",
    "贞": "貞", "负": "負", "贡": "貢", "财": "財", "责": "責", "贤": "賢",
    "败": "敗", "货": "貨", "质": "質", "贩": "販", "贪": "貪", "购": "購",
    "贮": "貯", "贯": "貫", "贱": "賤", "贴": "貼", "贵": "貴", "贷": "貸",
    "贸": "貿", "费": "費", "贺": "賀", "赁": "賃", "资": "資", "赋": "賦",
    "赌": "賭", "赏": "賞", "赐": "賜", "赔": "賠", "赛": "賽", "赢": "贏",
    "赶": "趕", "趋": "趨", "跃": "躍", "践": "踐", "跷": "蹺", "踌": "躊",
    "踪": "蹤", "车": "車", "轨": "軌", "轩": "軒", "转": "轉", "轮": "輪",
    "软": "軟", "轰": "轟", "轻": "輕", "载": "載", "输": "輸", "辈": "輩",
    "辆": "輛", "辉": "輝", "辐": "輻", "辑": "輯", "输": "輸", "辖": "轄",
    "辗": "輾", "辞": "辭", "辟": "闢", "辫": "辮", "边": "邊", "达": "達",
    "迁": "遷", "过": "過", "迈": "邁", "运": "運", "还": "還", "这": "這",
    "进": "進", "远": "遠", "违": "違", "连": "連", "迟": "遲", "适": "適",
    "选": "選", "逊": "遜", "递": "遞", "遗": "遺", "邮": "郵", "邻": "鄰",
    "郑": "鄭", "释": "釋", "针": "針", "钓": "釣", "钙": "鈣", "钝": "鈍",
    "钞": "鈔", "钢": "鋼", "钥": "鑰", "钦": "欽", "钩": "鉤", "钮": "鈕",
    "钱": "錢", "铁": "鐵", "铃": "鈴", "铅": "鉛", "铜": "銅", "铝": "鋁",
    "银": "銀", "铸": "鑄", "锁": "鎖", "锄": "鋤", "锅": "鍋", "锈": "鏽",
    "锋": "鋒", "锐": "銳", "错": "錯", "锡": "錫", "锣": "鑼", "锤": "錘",
    "锦": "錦", "键": "鍵", "锯": "鋸", "镑": "鎊", "镜": "鏡", "镰": "鐮",
    "长": "長", "门": "門", "闪": "閃", "闭": "閉", "问": "問", "闯": "闖",
    "闲": "閒", "间": "間", "闷": "悶", "闸": "閘", "闹": "鬧", "闻": "聞",
    "阀": "閥", "阁": "閣", "阅": "閱", "阔": "闊", "队": "隊", "阶": "階",
    "际": "際", "陆": "陸", "陇": "隴", "陈": "陳", "陕": "陝", "险": "險",
    "隐": "隱", "难": "難", "雏": "雛", "雾": "霧", "韧": "韌", "顶": "頂",
    "顷": "頃", "项": "項", "顺": "順", "须": "須", "顿": "頓", "颁": "頒",
    "颂": "頌", "预": "預", "颅": "顱", "领": "領", "颈": "頸", "频": "頻",
    "颗": "顆", "题": "題", "颚": "顎", "颜": "顏", "额": "額", "风": "風",
    "飘": "飄", "飞": "飛", "饥": "飢", "饭": "飯", "饮": "飲", "饰": "飾",
    "饱": "飽", "饲": "飼", "饶": "饒", "饺": "餃", "饼": "餅", "馅": "餡",
    "驱": "驅", "驳": "駁", "驴": "驢", "驻": "駐", "驼": "駝", "骂": "罵",
    "骄": "驕", "骆": "駱", "骤": "驟", "鱼": "魚", "鲁": "魯",
    "鲜": "鮮", "鸟": "鳥", "鸡": "雞", "鸣": "鳴", "鸭": "鴨", "鸿": "鴻",
    "鹅": "鵝", "鹰": "鷹", "麦": "麥", "黄": "黃", "齐": "齊",
    "齿": "齒", "龄": "齡", "龙": "龍",
}
# 注意：故意不收 里/后/只/着/系/复 等「簡繁同形或義項會衝突」的字，
# 以免把正確的繁體（公里、皇后、一隻的隻…）反而改壞。


def s2t(text: str) -> str:
    """把 OCR 誤輸出的簡體字扳回繁體。"""
    return "".join(_S2T.get(ch, ch) for ch in text)

# 去重比較時要剝除的字元：空白、各種標點、破折號、OCR 常見雜點。
# 特別把各種點（… ‥ ・ · ． 。 . ）全剝掉——字幕收尾的「⋯」OCR 抖動最兇，
# 不剝會把同一句「夢想即是力量…」拆成好幾個事件。
_STRIP_FOR_COMPARE = re.compile(
    r"[\s　"                      # 半形/全形空白
    r"…‥⋯・·．。.，,、；;：:！!？?～~—–\-ー"  # 標點（含 ASCII 句點）
    r"「」『』（）()【】《》〈〉\"'“”‘’"      # 括號引號
    r"]+"
)


def keys_mergeable(a: str, b: str) -> bool:
    """兩個正規化 key 是否應視為同一句（容忍單字 OCR 抖動）。"""
    if a == b:
        return True
    if not a or not b:
        return False
    # 其一是另一的前綴（如收尾點被抖掉、或字幕淡入只讀到前半）。
    # 要求較短者夠長（>=3 字）避免把零碎片段誤併入不相干的長句。
    shorter = a if len(a) <= len(b) else b
    if len(shorter) >= 3 and (a.startswith(b) or b.startswith(a)):
        return True
    # 同長度且只差 1 個字（如 圖/圓、程/成 的辨識抖動）——僅對較長句子放行，
    # 短句差一字通常是不同句，故要求長度 >= 5 才容忍。
    if len(a) == len(b) and len(a) >= 5:
        diff = sum(1 for x, y in zip(a, b) if x != y)
        if diff <= 1:
            return True
    return False


def normalize_for_compare(text: str) -> str:
    """把一段字幕文字折成去重用的正規化 key。"""
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text)
    t = _STRIP_FOR_COMPARE.sub("", t)
    t = "".join(_CANON_MAP.get(ch, ch) for ch in t)
    return t


def clean_line_text(text: str) -> str:
    """清理單行字幕：NFKC、去內部空白、去行首說話者破折號、簡→繁修正。"""
    t = unicodedata.normalize("NFKC", text)
    t = re.sub(r"\s+", "", t)          # 中文字幕內部不需要空白
    # 去掉行首說話者破折號（雙人對話字幕常以 '- ' 開頭；OCR 會併進來）
    t = re.sub(r"^[\-–—ー]+", "", t)
    t = s2t(t)                         # OCR 誤輸出的簡體字扳回繁體
    # 收尾的省略號抖動（·· / ··. / .. …）統一成標準「…」，避免同句因點數不同分裂
    t = re.sub(r"[·・.．…⋯]{2,}\s*$", "…", t)
    return t.strip()


# 多行（雙人對話）字幕的行間分隔符。用全形空白，讓下游可切回單句。
LINE_JOIN = "　"


# ---------------------------------------------------------------------------
# ffmpeg 抽幀
# ---------------------------------------------------------------------------

def probe_dimensions(mp4: str):
    out = subprocess.run(
        [FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", mp4],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = out.split("x")
    return int(w), int(h)


def scaled_crop(vid_w: int, vid_h: int):
    """把參考解析度下的 crop 等比縮放到實際影格大小。"""
    sx = vid_w / CROP_REF_W
    sy = vid_h / CROP_REF_H
    x = int(round(CROP_X * sx))
    y = int(round(CROP_Y * sy))
    w = int(round(CROP_W * sx))
    h = int(round(CROP_H * sy))
    # clamp
    w = min(w, vid_w - x)
    h = min(h, vid_h - y)
    return x, y, w, h


def extract_frames(mp4: str, frames_dir: str, start=None, dur=None):
    """以 SAMPLE_FPS 抽幀 + 裁切字幕帶，存成 frame_%06d.png。回傳 (list_of_paths, x,y,w,h)。"""
    vid_w, vid_h = probe_dimensions(mp4)
    x, y, w, h = scaled_crop(vid_w, vid_h)
    vf = f"fps={SAMPLE_FPS},crop={w}:{h}:{x}:{y}"
    cmd = [FFMPEG_BIN, "-nostdin", "-loglevel", "error"]
    if start is not None:
        cmd += ["-ss", str(start)]
    cmd += ["-i", mp4]
    if dur is not None:
        cmd += ["-t", str(dur)]
    cmd += ["-vf", vf, "-vsync", "0",
            os.path.join(frames_dir, "frame_%06d.png")]
    subprocess.run(cmd, check=True)
    paths = sorted(glob.glob(os.path.join(frames_dir, "frame_*.png")))
    return paths, (x, y, w, h)


# ---------------------------------------------------------------------------
# 每幀 OCR → 一行字幕文字
# ---------------------------------------------------------------------------

def frame_index_to_time(idx: int, start_offset: float) -> float:
    """frame_000001 = 第 1 幀 = t = start_offset + 0/fps（ffmpeg fps filter 從 0 起算）。"""
    return start_offset + (idx - 1) / SAMPLE_FPS


def ocr_frame(ocr, img):
    """對單幀（已放大的 numpy 影像）跑 OCR，回傳過濾+排版後的 (text, mean_conf) 或 (None, 0)。"""
    res, _ = ocr(img)
    if not res:
        return None, 0.0

    crop_w = img.shape[1]
    boxes = []
    for box, txt, conf in res:
        if conf < MIN_CONF:
            continue
        txt_clean = txt.strip()
        if not txt_clean:
            continue
        if len(txt_clean) <= SINGLE_CHAR_MAX_LEN and conf < SINGLE_CHAR_CONF:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        cx = (min(xs) + max(xs)) / 2.0
        ratio = cx / crop_w
        if ratio < CENTER_MIN_RATIO or ratio > CENTER_MAX_RATIO:
            continue
        cy = (min(ys) + max(ys)) / 2.0
        boxes.append({
            "txt": txt_clean, "conf": conf,
            "cx": cx, "cy": cy, "xmin": min(xs),
        })

    if not boxes:
        return None, 0.0

    # 依 y 分行，行內依 x 排序，行間由上到下。
    boxes.sort(key=lambda b: b["cy"])
    lines = []
    for b in boxes:
        placed = False
        for ln in lines:
            if abs(b["cy"] - ln["cy"]) <= LINE_Y_TOLERANCE:
                ln["items"].append(b)
                ln["cy"] = sum(i["cy"] for i in ln["items"]) / len(ln["items"])
                placed = True
                break
        if not placed:
            lines.append({"cy": b["cy"], "items": [b]})

    lines.sort(key=lambda ln: ln["cy"])
    parts = []
    confs = []
    for ln in lines:
        ln["items"].sort(key=lambda b: b["xmin"])
        raw = "".join(i["txt"] for i in ln["items"])
        line_txt = clean_line_text(raw)
        if not line_txt:
            continue
        parts.append(line_txt)
        confs.extend(i["conf"] for i in ln["items"])

    if not parts:
        return None, 0.0
    text = LINE_JOIN.join(parts)
    mean_conf = sum(confs) / len(confs)
    return text, mean_conf


# ---------------------------------------------------------------------------
# 幀序列 → 事件（合併連續相同）
# ---------------------------------------------------------------------------

def build_events(frame_results, start_offset: float):
    """
    frame_results: list of (frame_idx, text_or_None, conf)
    連續（正規化後）相同文字合併成一個事件。回傳 event dict list。
    """
    events = []
    cur = None  # {"key","texts":{text:count},"confs":[],"start_idx","end_idx"}

    def flush():
        nonlocal cur
        if cur is None:
            return
        n_frames = cur["end_idx"] - cur["start_idx"] + 1
        if n_frames < MIN_EVENT_FRAMES:
            cur = None
            return
        start = frame_index_to_time(cur["start_idx"], start_offset)
        end = frame_index_to_time(cur["end_idx"], start_offset) + EVENT_TAIL_S
        # 保留 texts 眾數表與 confs，留待 merge 後再一次定案（跨抖動投票更穩）
        events.append({
            "start": start,
            "end": end,
            "texts": dict(cur["texts"]),
            "confs": list(cur["confs"]),
            "_key": cur["key"],
        })
        cur = None

    for idx, text, conf in frame_results:
        if text is None:
            flush()
            continue
        key = normalize_for_compare(text)
        if not key:
            flush()
            continue
        if cur is not None and cur["key"] == key:
            cur["end_idx"] = idx
            cur["texts"][text] = cur["texts"].get(text, 0) + 1
            cur["confs"].append(conf)
        else:
            flush()
            cur = {
                "key": key,
                "texts": {text: 1},
                "confs": [conf],
                "start_idx": idx,
                "end_idx": idx,
            }
    flush()

    # 合併：相鄰事件間隔小、且正規化 key 相同或幾乎相同（單字 OCR 抖動，如 圖/圓）
    #        → 視為同一句被短暫遮擋/抖掉，合併並沿用累積的 texts 投票。
    merged = []
    for ev in events:
        if merged:
            prev = merged[-1]
            gap = ev["start"] - prev["end"]
            if gap <= MERGE_GAP_S and keys_mergeable(prev["_key"], ev["_key"]):
                prev["end"] = ev["end"]
                for t, c in ev["texts"].items():
                    prev["texts"][t] = prev["texts"].get(t, 0) + c
                prev["confs"].extend(ev["confs"])
                # key 取較長者（資訊較完整）
                if len(ev["_key"]) > len(prev["_key"]):
                    prev["_key"] = ev["_key"]
                continue
        merged.append(ev)

    out = []
    for i, ev in enumerate(merged):
        # 眾數投票定案文字：出現最多次者勝，同票取較長（保留完整字）
        best_text = max(ev["texts"].items(), key=lambda kv: (kv[1], len(kv[0])))[0]
        conf = sum(ev["confs"]) / len(ev["confs"])
        out.append({
            "id": i + 1,
            "start": round(ev["start"], 3),
            "end": round(ev["end"], 3),
            "text": best_text,
            "conf": round(conf, 3),
        })
    return out


# ---------------------------------------------------------------------------
# 輸出
# ---------------------------------------------------------------------------

def fmt_srt_time(sec: float) -> str:
    if sec < 0:
        sec = 0
    ms = int(round(sec * 1000))
    h = ms // 3600000
    ms -= h * 3600000
    m = ms // 60000
    ms -= m * 60000
    s = ms // 1000
    ms -= s * 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(events, path):
    with open(path, "w", encoding="utf-8") as f:
        for ev in events:
            # 多行（雙人對話）字幕在 SRT 用換行呈現，JSON 保留全形空白分隔。
            srt_text = ev["text"].replace(LINE_JOIN, "\n")
            f.write(f"{ev['id']}\n")
            f.write(f"{fmt_srt_time(ev['start'])} --> {fmt_srt_time(ev['end'])}\n")
            f.write(f"{srt_text}\n\n")


def write_json(events, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def run(mp4: str, out_prefix: str, start=None, dur=None, keep_frames=False):
    import cv2
    from rapidocr_onnxruntime import RapidOCR

    start_offset = float(start) if start is not None else 0.0

    tmp = tempfile.mkdtemp(prefix="ocr_subs_")
    try:
        print(f"[ocr] extracting frames @ {SAMPLE_FPS}fps ...", file=sys.stderr)
        paths, crop = extract_frames(mp4, tmp, start=start, dur=dur)
        print(f"[ocr] {len(paths)} frames, crop(x,y,w,h)={crop}", file=sys.stderr)

        # OCR_THREADS（西寶版新增）：機器滿載時限制 onnxruntime 執行緒，多集並行比單集吃滿核心有效率
        ocr = RapidOCR(intra_op_num_threads=int(os.environ.get("OCR_THREADS", "-1")))
        frame_results = []
        n = len(paths)
        prev_mask, prev_res, n_ocr = None, (None, 0.0), 0
        for i, p in enumerate(paths):
            idx = int(re.search(r"frame_(\d+)\.png", p).group(1))
            img = cv2.imread(p)
            # 幀差跳過（西寶版新增）：字幕是白字，比對「白色像素遮罩」跟上一幀幾乎一樣
            # 就沿用上一幀結果；背景怎麼動都不影響遮罩。整帶都沒白像素 = 沒字幕。
            dark = (img.max(axis=2) < TEXT_EDGE_DARK).astype(np.uint8)
            mask = (img.min(axis=2) > TEXT_MASK_MIN) & \
                (cv2.dilate(dark, np.ones((5, 5), np.uint8)) > 0)
            if mask.sum() < TEXT_MASK_MIN_PX:
                text, conf = None, 0.0
            elif prev_mask is not None and \
                    np.logical_xor(mask, prev_mask).sum() <= SAME_MASK_RATIO * max(mask.sum(), prev_mask.sum()):
                text, conf = prev_res
            else:
                if OCR_UPSCALE and OCR_UPSCALE != 1.0:
                    img = cv2.resize(img, None, fx=OCR_UPSCALE, fy=OCR_UPSCALE,
                                     interpolation=cv2.INTER_CUBIC)
                text, conf = ocr_frame(ocr, img)
                n_ocr += 1
            prev_mask, prev_res = mask, (text, conf)
            frame_results.append((idx, text, conf))
            if (i + 1) % 200 == 0 or i + 1 == n:
                print(f"[ocr] {i+1}/{n} frames (ocr calls {n_ocr})", file=sys.stderr, flush=True)

        events = build_events(frame_results, start_offset)
        print(f"[ocr] {len(events)} subtitle events", file=sys.stderr)

        srt_path = out_prefix + ".srt"
        json_path = out_prefix + ".json"
        write_srt(events, srt_path)
        write_json(events, json_path)
        print(f"[ocr] wrote {srt_path}", file=sys.stderr)
        print(f"[ocr] wrote {json_path}", file=sys.stderr)
        return events
    finally:
        if not keep_frames:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print(f"[ocr] frames kept in {tmp}", file=sys.stderr)


def main():
    # 支援隱藏的驗證用旗標 --ss / --t（切片跑），一般用法只需 <mp4> <out_prefix>。
    args = sys.argv[1:]
    ss = None
    t = None
    keep = False
    pos = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--ss":
            ss = float(args[i + 1]); i += 2; continue
        if a == "--t":
            t = float(args[i + 1]); i += 2; continue
        if a == "--keep-frames":
            keep = True; i += 1; continue
        pos.append(a); i += 1

    if len(pos) != 2:
        print("usage: python ocr_subs.py <mp4> <out_prefix> [--ss S] [--t S] [--keep-frames]",
              file=sys.stderr)
        sys.exit(2)

    mp4, out_prefix = pos
    run(mp4, out_prefix, start=ss, dur=t, keep_frames=keep)


if __name__ == "__main__":
    main()
