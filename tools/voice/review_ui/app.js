const KINDS = ["identity", "transcript", "separation", "generation"];
const state = { session: null, kind: "identity", index: 0 };
const $ = (selector) => document.querySelector(selector);

function rating(container, name) {
  for (let value = 1; value <= 5; value += 1) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="radio" name="${name}" value="${value}" required><span>${value}</span>`;
    container.append(label);
  }
}
document.querySelectorAll(".rating").forEach((node) => rating(node, node.dataset.name));

function reviewKey(item) { return `${state.session.reviewer}:${state.kind}:${item.id}`; }
function queue() { return state.session.queues[state.kind]; }
function current() { return queue()[state.index]; }
function currentForm() { return $(`#${state.kind}-form`); }

function reviewedCount(kind) {
  return state.session.queues[kind].filter((item) =>
    state.session.reviews[`${state.session.reviewer}:${kind}:${item.id}`]
  ).length;
}

function updateTabCounts() {
  KINDS.forEach((kind) => {
    const items = state.session.queues[kind];
    $(`#${kind}-count`).textContent = `${reviewedCount(kind)}/${items.length}`;
  });
}

function selectKind(kind) {
  state.kind = kind;
  state.index = 0;
  document.querySelectorAll(".tab").forEach((node) =>
    node.classList.toggle("active", node.dataset.kind === kind)
  );
}

function nextPendingKind() {
  return KINDS.find((kind) => state.session.queues[kind].some((item) =>
    !state.session.reviews[`${state.session.reviewer}:${kind}:${item.id}`]
  ));
}

async function waveform(audio, canvas) {
  const context = new AudioContext();
  const response = await fetch(audio.src);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  const data = buffer.getChannelData(0);
  const width = canvas.width;
  const height = canvas.height;
  const step = Math.max(1, Math.floor(data.length / width));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = canvas.id.startsWith("reference") ? "#63cbd1" : "#e6c866";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    let min = 1, max = -1;
    for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i += 1) {
      min = Math.min(min, data[i]); max = Math.max(max, data[i]);
    }
    ctx.moveTo(x, (1 + min) * height / 2);
    ctx.lineTo(x, (1 + max) * height / 2);
  }
  ctx.stroke();
  await context.close();
}

function setAudio(selector, url) {
  const audio = $(selector);
  audio.pause();
  audio.src = url || "";
  const canvas = $(selector.replace("audio", "wave"));
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (url) waveform(audio, canvas).catch(() => {});
}

function hydrate(form, saved) {
  form.reset();
  if (!saved) return;
  Object.entries(saved.answers).forEach(([name, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => { const input = form.querySelector(`[name="${name}"][value="${entry}"]`); if (input) input.checked = true; });
    } else if (typeof value === "boolean") {
      const input = form.querySelector(`[name="${name}"]`); if (input) input.checked = value;
    } else {
      const input = form.querySelector(`[name="${name}"][value="${value}"]`) || form.querySelector(`[name="${name}"]`);
      if (input) input.type === "radio" ? input.checked = true : input.value = value;
    }
  });
}

function renderQueue() {
  const list = $("#queue"); list.innerHTML = "";
  queue().forEach((item, index) => {
    const saved = state.session.reviews[reviewKey(item)];
    const li = document.createElement("li");
    li.innerHTML = `<button class="${index === state.index ? "active" : ""} ${saved ? "done" : ""}"><strong>${item.name}</strong><small>${saved ? "已完成" : "待審核"}</small></button>`;
    li.querySelector("button").onclick = () => { state.index = index; render(); };
    list.append(li);
  });
}

function render() {
  const items = queue();
  const reviewed = items.filter((item) => state.session.reviews[reviewKey(item)]).length;
  updateTabCounts();
  $("#position").textContent = items.length ? `${state.index + 1} / ${items.length}` : "0 / 0";
  $("#progress-bar").style.width = items.length ? `${reviewed / items.length * 100}%` : "0";
  const quarantined = state.kind === "identity" ? state.session.identity_quarantined_total : 0;
  const corpus = state.session.training_readiness?.counts;
  const corpusSuffix = state.kind === "identity" && corpus ?
    ` · 素材 ${corpus.valid_unique_clips} 段 / ${corpus.source_episodes} 集` : "";
  $("#queue-status").textContent = state.session.quality_hold ? "品質閘門暫停" :
    (quarantined && !items.length ? `聲線未校準，隔離 ${quarantined} 段` :
      (reviewed === items.length && items.length ? `本輪完成${corpusSuffix}` :
        `審核進行中${corpusSuffix}`));
  renderQueue();
  const item = current();
  $("#empty").hidden = Boolean(item); $("#workspace").hidden = !item;
  if (!item) { $("#empty-path").textContent = state.kind === "identity" ? "data/voice/xibao/candidates" :
    (state.kind === "transcript" ? "data/voice/xibao/transcripts/asr" :
      (state.kind === "separation" ? "data/voice/xibao/separation" : "data/voice/xibao/generations")); return; }
  $("#clip-kind").textContent = state.kind === "identity" ?
    (item.selection_kind === "visual_lipsync_disagreement" ? "素材身份 · 口型／聲紋衝突題" :
      (item.selection_kind === "visual_lipsync_precheck" ? "素材身份 · 口型分歧題" : "素材身份")) :
    (state.kind === "transcript" ? "日文逐字稿" :
      (state.kind === "separation" ? "去伴奏 A/B" : "生成品質"));
  $("#clip-name").textContent = item.name;
  $("#source-id").textContent = item.source_id || "LOCAL";
  $("#time-range").textContent = item.start_s != null ? `${item.start_s}s – ${item.end_s}s` : "完整片段";
  $("#reference-label").textContent = state.kind === "separation" ? "原始片段" : "金標參考";
  $("#candidate-label").textContent = state.kind === "generation" ? "生成結果" :
    (state.kind === "separation" ? "RoFormer Vocal Stem" : "原始片段");
  const reference = state.session.references.find((entry) => entry.id === item.reference_id) || state.session.references[0];
  setAudio("#reference-audio", item.reference_media_url || reference?.media_url);
  setAudio("#candidate-audio", item.media_url);
  $("#transcript").hidden = !item.transcript; $("#transcript").textContent =
    state.kind === "transcript" ? `中文提示：${item.transcript || "（無）"}` : (item.transcript || "");
  $("#identity-form").hidden = state.kind !== "identity";
  $("#transcript-form").hidden = state.kind !== "transcript";
  $("#separation-form").hidden = state.kind !== "separation";
  $("#generation-form").hidden = state.kind !== "generation";
  hydrate(currentForm(), state.session.reviews[reviewKey(item)]);
  if (state.kind === "transcript") {
    $("#transcript-ja-draft").textContent = item.transcript_ja_asr || "（無草稿）";
  }
  if (state.kind === "transcript" && !state.session.reviews[reviewKey(item)]) {
    currentForm().elements.transcript_ja_verified.value = item.transcript_ja_asr || "";
  }
  $("#previous").disabled = state.index === 0;
  $("#save-status").textContent = state.session.reviews[reviewKey(item)] ? "此段已有紀錄" : "";
  if (state.kind === "identity" && state.session.quality_hold) {
    $("#save-status").textContent = "連續出現 3 筆高信心其他角色，本批已自動暫停";
  }
  $("#save").innerHTML = state.index < items.length - 1
    ? "儲存並前往下一段 <span>›</span>"
    : (state.session.reviews[reviewKey(item)] ? "更新本段" : "儲存本段");
  $("#save").disabled = state.kind === "identity" && state.session.quality_hold;
}

function answers(form) {
  const data = new FormData(form);
  const base = { notes: String(data.get("notes") || "").trim() };
  if (state.kind === "identity") return { ...base, verdict: data.get("verdict"), overlap: data.get("overlap") === "on", confidence: Number(data.get("confidence")) };
  if (state.kind === "transcript") return { ...base, verdict: data.get("verdict"), transcript_ja_verified: String(data.get("transcript_ja_verified") || "").trim() };
  if (state.kind === "separation") return { ...base, verdict: data.get("verdict"), voice_intact: Number(data.get("voice_intact")), cleanup: Number(data.get("cleanup")), artifacts: data.getAll("artifacts") };
  return { ...base, verdict: data.get("verdict"), likeness: Number(data.get("likeness")), naturalness: Number(data.get("naturalness")), artifacts: data.getAll("artifacts") };
}

$("#save").onclick = async () => {
  const item = current(); const form = currentForm();
  if (!form.reportValidity()) return;
  $("#save").disabled = true; $("#save-status").textContent = "儲存中…";
  const response = await fetch("/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: state.kind, item_id: item.id, answers: answers(form) }) });
  const result = await response.json();
  if (!response.ok) { $("#save-status").textContent = result.error || "儲存失敗"; $("#save").disabled = false; return; }
  const previousId = item.id;
  state.session = result.session;
  const nextKind = nextPendingKind();
  if (!queue().some((entry) => !state.session.reviews[reviewKey(entry)]) && nextKind) {
    selectKind(nextKind);
    render();
    return;
  }
  const previousIndex = queue().findIndex((entry) => entry.id === previousId);
  state.index = Math.min(Math.max(0, previousIndex + 1), Math.max(0, queue().length - 1));
  render();
};
$("#previous").onclick = () => { if (state.index > 0) { state.index -= 1; render(); } };
document.querySelectorAll(".tab").forEach((tab) => tab.onclick = () => {
  selectKind(tab.dataset.kind); render();
});
document.addEventListener("keydown", (event) => {
  if (event.target.matches("textarea, input")) return;
  if (event.code === "Space") { event.preventDefault(); const audio = $("#candidate-audio"); audio.paused ? audio.play() : audio.pause(); }
});

fetch("/api/session").then((response) => response.json()).then((session) => {
  state.session = session;
  const pendingKind = nextPendingKind();
  if (pendingKind) selectKind(pendingKind);
  const firstUnreviewed = queue().findIndex((item) => !session.reviews[reviewKey(item)]);
  state.index = firstUnreviewed >= 0 ? firstUnreviewed : Math.max(0, queue().length - 1);
  $("#reviewer").textContent = session.reviewer; render();
}).catch(() => { $("#queue-status").textContent = "無法連線"; });
