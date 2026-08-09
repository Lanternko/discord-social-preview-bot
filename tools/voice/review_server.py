#!/usr/bin/env python3
"""Local-only human review workspace for Xibao voice clips and generations."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


APP_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = Path(__file__).with_name("review_ui")
DEFAULT_DATA_ROOT = APP_ROOT / "data" / "voice" / "xibao"
AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}
KINDS = {"identity", "generation"}
IDENTITY_BATCH_SIZE = 5
MAX_HIGH_CONFIDENCE_OTHERS = 3


class ReviewStore:
    def __init__(self, data_root: Path, reviewer: str):
        self.data_root = data_root.resolve()
        self.reviewer = reviewer
        self.review_path = self.data_root / "review" / "reviews.json"
        self.lock = threading.Lock()
        self.media: dict[str, Path] = {}

    @staticmethod
    def _id(path: Path) -> str:
        return hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:20]

    def _scan_audio(self, directory: str) -> list[Path]:
        root = self.data_root / directory
        if not root.exists():
            return []
        return sorted(path.resolve() for path in root.rglob("*")
                      if path.is_file() and path.suffix.lower() in AUDIO_SUFFIXES)

    @staticmethod
    def _sidecar(path: Path) -> dict:
        sidecar = path.with_suffix(".json")
        if not sidecar.is_file():
            return {}
        try:
            value = json.loads(sidecar.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _item(self, path: Path, kind: str, reference_id: str | None) -> dict:
        media_id = self._id(path)
        self.media[media_id] = path
        sidecar = self._sidecar(path)
        times = sidecar.get("times") if isinstance(sidecar.get("times"), dict) else {}
        return {
            "id": media_id,
            "kind": kind,
            "name": path.stem,
            "media_url": f"/media/{media_id}",
            "reference_id": reference_id,
            "source_id": sidecar.get("source_id") or sidecar.get("source"),
            "start_s": sidecar.get("start_s", times.get("start_s")),
            "end_s": sidecar.get("end_s", times.get("end_s")),
            "speaker": sidecar.get("speaker"),
            "transcript": (sidecar.get("transcript_ja_verified") or
                           sidecar.get("transcript_zh_subtitle") or sidecar.get("text")),
            "rank": sidecar.get("rank"),
            "speaker_probability": sidecar.get("speaker_probability"),
        }

    def load_reviews(self) -> dict:
        if not self.review_path.is_file():
            return {}
        try:
            value = json.loads(self.review_path.read_text(encoding="utf-8"))
            return value.get("reviews", {}) if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def session(self) -> dict:
        self.media = {}
        references = self._scan_audio("reference")
        reference_items = [self._item(path, "reference", None) for path in references]
        reference_id = reference_items[0]["id"] if reference_items else None
        identity_paths = self._scan_audio("candidates")
        all_identity = [self._item(path, "identity", reference_id) for path in identity_paths]
        all_identity.sort(key=lambda item: (
            -(item["speaker_probability"] if isinstance(item.get("speaker_probability"), float) else -1),
            item["rank"] if isinstance(item.get("rank"), int) else 10**9,
            item["name"],
        ))
        generation = [self._item(path, "generation", reference_id)
                      for path in self._scan_audio("generations")]
        reviews = self.load_reviews()
        quality_hold = False
        unlocked = min(IDENTITY_BATCH_SIZE, len(all_identity))
        for start in range(0, len(all_identity), IDENTITY_BATCH_SIZE):
            batch = all_identity[start:start + IDENTITY_BATCH_SIZE]
            records = [reviews.get(f"{self.reviewer}:identity:{item['id']}") for item in batch]
            completed = [record for record in records if isinstance(record, dict)]
            high_confidence_others = sum(
                record.get("answers", {}).get("verdict") == "other" and
                record.get("answers", {}).get("confidence", 0) >= 4
                for record in completed
            )
            if high_confidence_others >= MAX_HIGH_CONFIDENCE_OTHERS:
                quality_hold = True
                unlocked = min(len(all_identity), start + len(completed))
                break
            unlocked = min(len(all_identity), start + IDENTITY_BATCH_SIZE)
            if len(completed) < len(batch):
                break
        identity = all_identity[:unlocked]
        return {
            "reviewer": self.reviewer,
            "references": reference_items,
            "queues": {"identity": identity, "generation": generation},
            "reviews": reviews,
            "counts": {
                kind: {"total": len(items),
                       "reviewed": sum(1 for item in items if f"{self.reviewer}:{kind}:{item['id']}" in reviews)}
                for kind, items in (("identity", identity), ("generation", generation))
            },
            "identity_available_total": len(all_identity),
            "quality_hold": quality_hold,
            "quality_policy": {
                "batch_size": IDENTITY_BATCH_SIZE,
                "pause_after_high_confidence_others": MAX_HIGH_CONFIDENCE_OTHERS,
            },
        }

    def save(self, payload: dict) -> dict:
        kind = payload.get("kind")
        item_id = payload.get("item_id")
        if kind not in KINDS or not isinstance(item_id, str) or item_id not in self.media:
            raise ValueError("unknown review item")
        allowed = ({"verdict", "overlap", "confidence", "notes"} if kind == "identity" else
                   {"verdict", "likeness", "naturalness", "artifacts", "notes"})
        answers = payload.get("answers")
        if not isinstance(answers, dict) or set(answers) - allowed:
            raise ValueError("invalid review answers")
        if kind == "identity":
            if answers.get("verdict") not in {"target", "other", "uncertain"}:
                raise ValueError("identity verdict is required")
            if not isinstance(answers.get("overlap"), bool):
                raise ValueError("overlap must be boolean")
            if answers.get("confidence") not in {1, 2, 3, 4, 5}:
                raise ValueError("confidence must be 1..5")
        else:
            if answers.get("verdict") not in {"accept", "reject"}:
                raise ValueError("generation verdict is required")
            if answers.get("likeness") not in {1, 2, 3, 4, 5}:
                raise ValueError("likeness must be 1..5")
            if answers.get("naturalness") not in {1, 2, 3, 4, 5}:
                raise ValueError("naturalness must be 1..5")
            if not isinstance(answers.get("artifacts"), list):
                raise ValueError("artifacts must be an array")
        key = f"{self.reviewer}:{kind}:{item_id}"
        record = {
            "reviewer": self.reviewer,
            "kind": kind,
            "item_id": item_id,
            "media_path": str(self.media[item_id]),
            "answers": answers,
            "reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        with self.lock:
            reviews = self.load_reviews()
            reviews[key] = record
            document = {"schema_version": "pilotfish.human_reviews.v1", "reviews": reviews}
            self.review_path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".reviews.", suffix=".tmp",
                                             dir=self.review_path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=True)
                    handle.write("\n")
                os.replace(temporary, self.review_path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return record


class ReviewHandler(BaseHTTPRequestHandler):
    server_version = "PilotfishReview/1.0"

    @property
    def store(self) -> ReviewStore:
        return self.server.store  # type: ignore[attr-defined]

    def _json(self, value: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/session":
            self._json(self.store.session())
            return
        if parsed.path.startswith("/media/"):
            media_id = parsed.path.removeprefix("/media/")
            path = self.store.media.get(media_id)
            if path is None:
                self.store.session()
                path = self.store.media.get(media_id)
            self._file(path) if path else self.send_error(HTTPStatus.NOT_FOUND)
            return
        name = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
        path = (STATIC_ROOT / name).resolve()
        if STATIC_ROOT.resolve() not in path.parents:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self._file(path)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/reviews":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            record = self.store.save(payload)
            self._json({"ok": True, "review": record, "session": self.store.session()})
        except (ValueError, json.JSONDecodeError) as error:
            self._json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args) -> None:
        print(f"[review] {self.address_string()} {format % args}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default=str(DEFAULT_DATA_ROOT))
    parser.add_argument("--reviewer", required=True, help="Stable reviewer name used for independent votes")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args(argv)
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("review server may only bind to localhost")
    store = ReviewStore(Path(args.data_root), args.reviewer.strip())
    if not store.reviewer:
        parser.error("--reviewer must be non-empty")
    server = ThreadingHTTPServer((args.host, args.port), ReviewHandler)
    server.store = store  # type: ignore[attr-defined]
    url = f"http://{args.host}:{server.server_port}"
    print(f"Pilotfish review workspace: {url}", flush=True)
    ssh_connection = os.environ.get("SSH_CONNECTION", "").split()
    if ssh_connection and args.host in {"127.0.0.1", "localhost"}:
        remote_host = ssh_connection[2] if len(ssh_connection) >= 3 else "<remote-host>"
        print("SSH tunnel (run on your local computer):", flush=True)
        print(
            f"  ssh -N -L {server.server_port}:127.0.0.1:{server.server_port} "
            f"{os.environ.get('USER', '<user>')}@{remote_host}",
            flush=True,
        )
        print(f"Then open locally: http://127.0.0.1:{server.server_port}", flush=True)
    if args.open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
