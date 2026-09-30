"""
voice_common.py — shared speaker-embedding + VAD utilities for the
仲町アラレ (arale) voiceprint comparison toolkit.

Model: speechbrain/spkrec-ecapa-voxceleb (ECAPA-TDNN, 192-dim, non-gated, no HF token).
Runs on CPU. All embeddings here are L2-NORMALISED so cosine similarity is a plain dot.

Public API:
    get_encoder(device="cpu")                  -> cached EncoderClassifier
    embed_slice(encoder, wav16k, sr)           -> np.ndarray (192,), L2-normalised
    embed_segments(encoder, wav16k, sr, spans) -> list of (id, emb_or_None, note)
    cosine(a, b)                               -> float
    load_wav_16k_mono(path)                    -> (np.float32 array, 16000)
    energy_vad(wav16k, sr, ...)                -> list of (start_s, end_s) speech spans
    music_ratio(wav16k, sr, span)             -> float in [0,1], higher = more music-like

Design notes baked in:
- ECAPA raw output is NOT unit-norm (~300). We normalise on the way out so every
  downstream cosine is comparable and the reference .npz stores unit vectors.
- Segment trimming (head/tail 0.15 s inset, <0.6 s -> skip) lives in embed_segments
  so both the reference builder and the scorer share ONE implementation.
"""

import os
import numpy as np

SAMPLE_RATE = 16000
EMBED_DIM = 192

# ---- head/tail inset + minimum length (shared by ref builder AND scorer) ----
EDGE_INSET_S = 0.15   # trim this much off each end (drops onset/offset of a line)
MIN_SEG_S = 0.6       # anything shorter than this after inset -> skip

_ENCODER = None


def get_encoder(device="cpu", savedir=None):
    """Lazy-load and cache the ECAPA encoder. First call downloads the model
    (non-gated, no token) into savedir."""
    global _ENCODER
    if _ENCODER is not None:
        return _ENCODER
    # keep HF quiet-ish; unauthenticated is fine for this public model
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    from speechbrain.inference.speaker import EncoderClassifier
    if savedir is None:
        savedir = os.path.join(os.path.dirname(__file__), "pretrained", "ecapa")
    _ENCODER = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir=savedir,
        run_opts={"device": device},
    )
    return _ENCODER


def load_wav_16k_mono(path):
    """Load any audio file as float32 mono @ 16 kHz. Uses librosa for robust
    resampling/downmixing so callers don't have to pre-convert."""
    import librosa
    wav, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return wav.astype(np.float32), SAMPLE_RATE


def _l2(v):
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def embed_slice(encoder, wav16k, sr=SAMPLE_RATE):
    """Embed a single 1-D waveform slice -> L2-normalised (192,) float32.
    Caller is responsible for slice length; empty/all-zero -> zero vector."""
    import torch
    if wav16k.size == 0 or not np.any(np.abs(wav16k) > 1e-6):
        return np.zeros(EMBED_DIM, dtype=np.float32)
    sig = torch.tensor(np.ascontiguousarray(wav16k), dtype=torch.float32).unsqueeze(0)
    with torch.no_grad():
        emb = encoder.encode_batch(sig).squeeze().detach().cpu().numpy()
    return _l2(emb.astype(np.float32))


def embed_segments(encoder, wav16k, sr, spans):
    """
    spans: iterable of dicts {id, start, end} (seconds).
    Applies EDGE_INSET_S head/tail inset; segments shorter than MIN_SEG_S after
    inset are skipped (emb=None, note='skip:too_short').
    Returns list of (id, emb_or_None, note) preserving input order.
    """
    out = []
    total = len(wav16k) / sr
    for sp in spans:
        sid = sp["id"]
        start = float(sp["start"])
        end = float(sp["end"])
        # clamp to file
        start = max(0.0, min(start, total))
        end = max(0.0, min(end, total))
        a = start + EDGE_INSET_S
        b = end - EDGE_INSET_S
        if b - a < MIN_SEG_S:
            out.append((sid, None, f"skip:too_short(dur={max(0.0, end - start):.2f}s)"))
            continue
        i0 = int(round(a * sr))
        i1 = int(round(b * sr))
        slice_ = wav16k[i0:i1]
        if slice_.size == 0:
            out.append((sid, None, "skip:empty_slice"))
            continue
        emb = embed_slice(encoder, slice_, sr)
        if not np.any(emb):
            out.append((sid, None, "skip:silent"))
            continue
        out.append((sid, emb, "ok"))
    return out


def cosine(a, b):
    """Cosine similarity. Inputs may or may not be unit vectors; normalised here
    defensively so this is correct regardless of caller."""
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ------------------------- energy-based VAD -------------------------

def energy_vad(
    wav16k,
    sr=SAMPLE_RATE,
    frame_ms=30,
    hop_ms=10,
    thresh_pct=55.0,
    min_speech_s=1.5,
    max_speech_s=8.0,
    merge_gap_s=0.25,
    pad_s=0.0,
):
    """
    Cheap, dependency-light speech-activity detector based on short-time RMS energy.
    Returns list of (start_s, end_s) spans likely to contain speech.

    - thresh_pct: energy percentile used as the speech/silence cut (per-file adaptive,
      so it copes with quiet vs loud recordings). Frames above the percentile of
      log-energy are 'active'.
    - Runs of active frames are merged (gaps <= merge_gap_s bridged), then any run
      longer than max_speech_s is chopped into <= max_speech_s pieces, and runs
      shorter than min_speech_s are dropped.

    This is intentionally NOT a trained VAD — it's a robust energy gate. Music/BGM
    with strong energy can pass it; use music_ratio() to filter those out afterwards.
    """
    frame = int(sr * frame_ms / 1000)
    hop = int(sr * hop_ms / 1000)
    if len(wav16k) < frame:
        return []
    n_frames = 1 + (len(wav16k) - frame) // hop
    rms = np.empty(n_frames, dtype=np.float32)
    for i in range(n_frames):
        s = i * hop
        seg = wav16k[s:s + frame]
        rms[i] = np.sqrt(np.mean(seg * seg) + 1e-12)
    log_e = np.log(rms + 1e-8)
    thr = np.percentile(log_e, thresh_pct)
    active = log_e > thr

    # merge active frames into spans (in frame index)
    spans_idx = []
    i = 0
    while i < n_frames:
        if active[i]:
            j = i
            while j < n_frames and active[j]:
                j += 1
            spans_idx.append([i, j - 1])
            i = j
        else:
            i += 1

    if not spans_idx:
        return []

    # merge across small gaps
    merge_gap_frames = merge_gap_s * 1000 / hop_ms
    merged = [spans_idx[0]]
    for s, e in spans_idx[1:]:
        if s - merged[-1][1] <= merge_gap_frames:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    def f2t(fi):
        return fi * hop / sr

    out = []
    for s, e in merged:
        st = max(0.0, f2t(s) - pad_s)
        en = min(len(wav16k) / sr, f2t(e) + frame / sr + pad_s)
        dur = en - st
        if dur < min_speech_s:
            continue
        # chop long spans into <= max_speech_s pieces
        if dur <= max_speech_s:
            out.append((st, en))
        else:
            n_chunks = int(np.ceil(dur / max_speech_s))
            step = dur / n_chunks
            for k in range(n_chunks):
                cs = st + k * step
                ce = min(en, cs + step)
                if ce - cs >= min_speech_s:
                    out.append((cs, ce))
    return out


def music_ratio(wav16k, sr, span=None):
    """
    Heuristic 'is this music/singing rather than plain speech' score in [0,1].
    Higher -> more music-like. Combines two cheap cues:

      1. Spectral flatness (music/noise is flatter; speech is peaky) — mean flatness.
      2. Harmonic energy fraction via librosa HPSS — sustained singing/instruments
         put more energy in the harmonic component than conversational speech.

    Used to reject sung / BGM-heavy VAD spans when auto-picking reference clips.
    Not a hard classifier — a threshold around 0.5 works empirically; tune per corpus.
    """
    import librosa
    if span is not None:
        i0 = int(span[0] * sr)
        i1 = int(span[1] * sr)
        x = wav16k[i0:i1]
    else:
        x = wav16k
    if x.size < sr // 2:
        return 1.0  # too short to trust -> treat as reject
    # 1) spectral flatness (0 tonal .. 1 flat/noise). Speech ~0.05-0.2.
    flat = float(np.mean(librosa.feature.spectral_flatness(y=x)))
    # 2) harmonic fraction
    try:
        harm, perc = librosa.effects.hpss(x)
        he = float(np.mean(harm ** 2))
        pe = float(np.mean(perc ** 2))
        harm_frac = he / (he + pe + 1e-9)
    except Exception:
        harm_frac = 0.5
    # Map: high harmonic fraction (sustained tones/singing) -> music-like.
    # flatness contributes a smaller nudge (very flat = noise/BGM).
    score = 0.75 * harm_frac + 0.25 * min(1.0, flat / 0.3)
    return float(np.clip(score, 0.0, 1.0))
