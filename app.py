import json
import os
import re
import sqlite3
import datetime
import time
import requests
import xml.etree.ElementTree as ET
from pathlib import Path
from flask import Flask, g, jsonify, request, render_template, send_file, abort, url_for
from PyPDF2 import PdfReader

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PDF_DIR = DATA_DIR / "pdfs"
DB_PATH = DATA_DIR / "library.db"

# Ensure the persistence folders exist before the app starts.
DATA_DIR.mkdir(exist_ok=True)
PDF_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB upload limit


def get_db():
    """Return a database connection for the current request context."""
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        g.db = conn
    return g.db


def close_db(e=None):
    """Close the database connection at the end of the request."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def normalize_arxiv_id(arxiv_id):
    """Strip HF/arXiv prefixes and version suffixes for API and PDF URLs."""
    if not arxiv_id:
        return None
    cleaned = str(arxiv_id).strip()
    if cleaned.lower().startswith("arxiv:"):
        cleaned = cleaned.split(":", 1)[1].strip()
    cleaned = re.sub(r"v\d+$", "", cleaned, flags=re.IGNORECASE)
    return cleaned or None


def fetch_url_with_retries(url, timeout=15, retries=3, backoff=1.0, retry_statuses=(429, 503, 504)):
    """Fetch a URL with retries, backoff, and optional retry on rate-limit status codes."""
    last_error = None
    headers = {"User-Agent": "DocsReader/1.0 (local paper library; academic use)"}

    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, timeout=timeout, headers=headers)
            if response.status_code in retry_statuses:
                last_error = requests.HTTPError(
                    f"{response.status_code} from arXiv",
                    response=response,
                )
                if attempt == retries:
                    response.raise_for_status()
                time.sleep(backoff * attempt * 2)
                continue
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last_error = exc
            if attempt == retries:
                raise
            time.sleep(backoff * attempt)

    if last_error is not None:
        raise last_error
    raise requests.RequestException("Request failed after retries.")


@app.teardown_appcontext
def teardown_db(exception):
    close_db(exception)


def init_db():
    """Create schema for the paper library if it does not exist."""
    db = get_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS papers (
            id INTEGER PRIMARY KEY,
            arxiv_id TEXT UNIQUE,
            title TEXT,
            authors TEXT,
            year INTEGER,
            category TEXT,
            source TEXT,
            extracted_text TEXT,
            pdf_path TEXT,
            date_added TEXT
        );
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE,
            color TEXT,
            display_order INTEGER
        );
        CREATE TABLE IF NOT EXISTS paper_tags (
            paper_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY(paper_id, tag_id),
            FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS highlights (
            id INTEGER PRIMARY KEY,
            paper_id INTEGER,
            page_number INTEGER,
            x REAL,
            y REAL,
            width REAL,
            height REAL,
            color TEXT,
            selected_text TEXT,
            created_at TEXT,
            FOREIGN KEY(paper_id) REFERENCES papers(id) ON DELETE CASCADE
        );
        """
    )
    db.commit()
    ensure_default_tags()
    ensure_highlight_schema()


def ensure_highlight_schema():
    """Add rects_json for multi-rectangle highlights (plan-09)."""
    db = get_db()
    columns = {row[1] for row in db.execute("PRAGMA table_info(highlights)").fetchall()}
    if "rects_json" not in columns:
        db.execute("ALTER TABLE highlights ADD COLUMN rects_json TEXT")
        db.commit()


def ensure_default_tags():
    """Insert the six default colours if the tags table is empty."""
    db = get_db()
    rows = db.execute("SELECT COUNT(*) AS count FROM tags").fetchone()
    if rows["count"] == 0:
        default_tags = [
            ("Red", "#FDA4AF"),
            ("Orange", "#FCD34D"),
            ("Yellow", "#FDE68A"),
            ("Green", "#86EFAC"),
            ("Blue", "#93C5FD"),
            ("Purple", "#C4B5FD"),
        ]
        for idx, (name, color) in enumerate(default_tags, start=1):
            db.execute(
                "INSERT OR IGNORE INTO tags (name, color, display_order) VALUES (?, ?, ?)",
                (name, color, idx),
            )
        db.commit()


def row_to_dict(row):
    """Convert a SQLite row to a plain Python dict."""
    return {key: row[key] for key in row.keys()}


def parse_arxiv_id_from_pdf(file_path):
    """Attempt to extract an arXiv ID from the uploaded PDF's text content.

    The app supports both modern (e.g. 2101.12345) and legacy (e.g. math/0301234)
    identifiers. It reads up to the first five pages of the PDF because arXiv
    metadata is normally present on the title page or first page.
    """
    try:
        reader = PdfReader(str(file_path))
    except Exception:
        return None

    patterns = [
        r"arXiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?",
        r"arXiv[:\s]*([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?",
        r"https?://arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})(v\d+)?",
        r"https?://arxiv\.org/(?:abs|pdf)/([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?",
        r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})(v\d+)?",
        r"arxiv\.org/(?:abs|pdf)/([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?",
    ]

    page_count = min(len(reader.pages), 5)
    text_chunks = []
    for page in reader.pages[:page_count]:
        try:
            contents = page.extract_text() or ""
        except Exception:
            contents = ""
        text_chunks.append(contents)

    text = "\n".join(text_chunks)
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def fetch_arxiv_metadata(arxiv_id):
    """Fetch metadata from the arXiv API for a given arXiv identifier."""
    canonical_id = normalize_arxiv_id(arxiv_id)
    if not canonical_id:
        return None

    urls = [
        f"https://export.arxiv.org/api/query?id_list={canonical_id}",
        f"http://export.arxiv.org/api/query?id_list={canonical_id}",
    ]
    last_error = None
    for url in urls:
        try:
            response = fetch_url_with_retries(url, timeout=20, retries=5, backoff=2.0)
            root = ET.fromstring(response.text)
            entry = root.find("{http://www.w3.org/2005/Atom}entry")
            if entry is None:
                continue

            title = entry.find("{http://www.w3.org/2005/Atom}title").text.strip()
            author_elems = entry.findall("{http://www.w3.org/2005/Atom}author")
            authors = ", ".join(a.find("{http://www.w3.org/2005/Atom}name").text.strip() for a in author_elems)
            published = entry.find("{http://www.w3.org/2005/Atom}published").text
            year = int(published[:4]) if published else None
            categories = [c.attrib.get("term") for c in entry.findall("{http://arxiv.org/schemas/atom}primary_category")]
            category = categories[0] if categories else "unknown"
            source = "arXiv"
            summary = entry.find("{http://www.w3.org/2005/Atom}summary").text.strip() if entry.find("{http://www.w3.org/2005/Atom}summary") is not None else ""
            return {
                "arxiv_id": canonical_id,
                "title": title,
                "authors": authors,
                "year": year,
                "category": category,
                "source": source,
                "summary": summary,
            }
        except requests.RequestException as exc:
            last_error = exc
            continue
        except ET.ParseError:
            raise

    if last_error is not None:
        raise last_error
    return None


def save_pdf_and_metadata(file_storage, metadata):
    """Save the uploaded PDF file and return the destination path."""
    filename = f"{metadata['arxiv_id']}.pdf"
    destination = PDF_DIR / filename
    if hasattr(file_storage, "save"):
        file_storage.save(destination)
    else:
        file_storage.replace(destination)
    return str(destination)


with app.app_context():
    init_db()


@app.route("/")
def index():
    """Render the main library page."""
    return render_template("index.html")


@app.route("/viewer/<int:paper_id>")
def viewer(paper_id):
    """Render the inline PDF viewer for a single paper."""
    db = get_db()
    paper = db.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
    if paper is None:
        abort(404)
    return render_template("viewer.html", paper=row_to_dict(paper))


@app.route("/api/papers", methods=["GET"])
def list_papers():
    """Return the library data, optionally filtered by search query, tag, or source."""
    query = request.args.get("q", "").strip()
    tag_id = request.args.get("tag_id")
    source = request.args.get("source", "").strip()
    if source and source not in ("arXiv", "HuggingFace"):
        return jsonify({"error": "Invalid source filter."}), 400

    db = get_db()
    sql = "SELECT p.* FROM papers p"
    params = []
    conditions = []

    if tag_id:
        sql += " JOIN paper_tags pt ON p.id = pt.paper_id"
        conditions.append("pt.tag_id = ?")
        params.append(tag_id)

    if query:
        conditions.append("(p.title LIKE ? OR p.authors LIKE ? OR p.extracted_text LIKE ?)")
        params.extend([f"%{query}%"] * 3)

    if source:
        conditions.append("p.source = ?")
        params.append(source)

    if conditions:
        sql += " WHERE " + " AND ".join(conditions)

    sql += " ORDER BY p.date_added DESC"
    papers = [row_to_dict(row) for row in db.execute(sql, params).fetchall()]
    for paper in papers:
        tag_rows = db.execute(
            "SELECT t.* FROM tags t JOIN paper_tags pt ON t.id = pt.tag_id WHERE pt.paper_id = ? ORDER BY t.display_order",
            (paper["id"],),
        ).fetchall()
        paper["tags"] = [row_to_dict(tag) for tag in tag_rows]
    return jsonify(papers)


@app.route("/api/papers/<int:paper_id>", methods=["DELETE"])
def delete_paper(paper_id):
    """Remove a paper from the library, including tags, highlights, and its PDF file."""
    db = get_db()
    paper = db.execute(
        "SELECT id, pdf_path FROM papers WHERE id = ?", (paper_id,)
    ).fetchone()
    if paper is None:
        return jsonify({"error": "Paper not found."}), 404

    db.execute("DELETE FROM paper_tags WHERE paper_id = ?", (paper_id,))
    db.execute("DELETE FROM highlights WHERE paper_id = ?", (paper_id,))
    db.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
    db.commit()

    if paper["pdf_path"]:
        pdf_path = Path(paper["pdf_path"])
        if pdf_path.is_file():
            try:
                pdf_path.unlink()
            except OSError:
                pass

    return jsonify({"success": True})


@app.route("/api/tags", methods=["GET"])
def get_tags():
    """Return the tag list."""
    db = get_db()
    tags = [row_to_dict(row) for row in db.execute("SELECT * FROM tags ORDER BY display_order").fetchall()]
    return jsonify(tags)


@app.route("/api/add-paper", methods=["POST"])
def add_paper():
    """Accept a PDF upload, extract arXiv metadata, and add it to the library."""
    if "pdf" not in request.files:
        return jsonify({"error": "Missing PDF upload."}), 400

    pdf_file = request.files["pdf"]
    if not pdf_file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are supported."}), 400

    temp_path = PDF_DIR / f"upload_{datetime.datetime.utcnow().timestamp()}.pdf"
    pdf_file.save(temp_path)
    arxiv_id = parse_arxiv_id_from_pdf(temp_path)
    if not arxiv_id:
        temp_path.unlink(missing_ok=True)
        return jsonify({"error": "Could not find an arXiv ID inside the PDF."}), 400

    try:
        metadata = fetch_arxiv_metadata(arxiv_id)
    except Exception as exc:
        temp_path.unlink(missing_ok=True)
        return jsonify({"error": f"Failed to fetch arXiv metadata: {exc}"}), 500

    if metadata is None:
        temp_path.unlink(missing_ok=True)
        return jsonify({"error": "arXiv metadata not found for the detected ID."}), 404

    pdf_path = save_pdf_and_metadata(temp_path, metadata)
    extracted_text = ""
    try:
        reader = PdfReader(pdf_path)
        extracted_text = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception:
        extracted_text = ""

    db = get_db()
    db.execute(
        "INSERT OR REPLACE INTO papers (arxiv_id, title, authors, year, category, source, extracted_text, pdf_path, date_added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            metadata["arxiv_id"],
            metadata["title"],
            metadata["authors"],
            metadata["year"],
            metadata["category"],
            metadata["source"],
            extracted_text,
            pdf_path,
            datetime.datetime.utcnow().isoformat(),
        ),
    )
    db.commit()
    return jsonify({"success": True, "paper": metadata})


@app.route("/api/update-paper-tags", methods=["POST"])
def update_paper_tags():
    """Replace all tag links for one paper (empty list clears tags)."""
    data = request.get_json(silent=True) or {}
    paper_id = data.get("paper_id")
    tag_ids = data.get("tag_ids", [])
    if not paper_id:
        return jsonify({"error": "paper_id is required."}), 400

    db = get_db()
    paper = db.execute("SELECT id FROM papers WHERE id = ?", (paper_id,)).fetchone()
    if paper is None:
        return jsonify({"error": "Paper not found."}), 404

    valid_tag_ids = []
    for tag_id in tag_ids:
        row = db.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone()
        if row is None:
            return jsonify({"error": f"Unknown tag id: {tag_id}"}), 400
        valid_tag_ids.append(tag_id)

    db.execute("DELETE FROM paper_tags WHERE paper_id = ?", (paper_id,))
    for tag_id in valid_tag_ids:
        db.execute("INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)", (paper_id, tag_id))
    db.commit()
    return jsonify({"success": True})


@app.route("/api/highlights/<int:paper_id>", methods=["GET", "POST"])
def paper_highlights(paper_id):
    """Store and retrieve highlight rectangles for a paper."""
    db = get_db()
    if request.method == "GET":
        rows = db.execute(
            "SELECT * FROM highlights WHERE paper_id = ? ORDER BY created_at DESC",
            (paper_id,),
        ).fetchall()
        payload = []
        for row in rows:
            item = row_to_dict(row)
            if item.get("rects_json"):
                try:
                    item["rects"] = json.loads(item["rects_json"])
                except json.JSONDecodeError:
                    item["rects"] = []
            payload.append(item)
        return jsonify(payload)

    data = request.get_json(silent=True) or {}
    page_number = data.get("page_number")
    color = data.get("color", "#FDE68A")
    selected_text = data.get("selected_text", "")
    rects = data.get("rects")

    # Normalized 0–1 rectangles; fallback to legacy single-box fields.
    if not rects:
        rects = [
            {
                "x": float(data.get("x", 0)),
                "y": float(data.get("y", 0)),
                "width": float(data.get("width", 0)),
                "height": float(data.get("height", 0)),
            }
        ]

    x = min(r["x"] for r in rects)
    y = min(r["y"] for r in rects)
    max_x = max(r["x"] + r["width"] for r in rects)
    max_y = max(r["y"] + r["height"] for r in rects)
    width = max_x - x
    height = max_y - y
    rects_json = json.dumps(rects)

    created_at = datetime.datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO highlights (paper_id, page_number, x, y, width, height, color, selected_text, created_at, rects_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (paper_id, page_number, x, y, width, height, color, selected_text, created_at, rects_json),
    )
    db.commit()
    highlight_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    return jsonify({"success": True, "highlight_id": highlight_id})


@app.route("/api/highlights/item/<int:highlight_id>", methods=["DELETE"])
def delete_highlight(highlight_id):
    """Remove one stored highlight rectangle."""
    db = get_db()
    row = db.execute("SELECT id, paper_id FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
    if row is None:
        return jsonify({"error": "Highlight not found."}), 404
    db.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,))
    db.commit()
    return jsonify({"success": True})


@app.route("/api/pdf/<int:paper_id>")
def serve_pdf(paper_id):
    """Serve the stored PDF file for the viewer."""
    db = get_db()
    paper = db.execute("SELECT pdf_path FROM papers WHERE id = ?", (paper_id,)).fetchone()
    if paper is None:
        abort(404)
    pdf_path = Path(paper["pdf_path"])
    if not pdf_path.exists():
        abort(404)
    return send_file(str(pdf_path), mimetype="application/pdf")


def _normalize_hf_paper_entry(item):
    """Map a Hugging Face /api/papers/search item to the JSON shape expected by the UI."""
    paper = item.get("paper", item) if isinstance(item, dict) else {}
    if not isinstance(paper, dict):
        return None

    arxiv_id = normalize_arxiv_id(paper.get("id") or paper.get("arxiv_id"))

    authors = paper.get("authors") or []
    if authors and isinstance(authors[0], dict):
        author_str = ", ".join(a.get("name", "") for a in authors if a.get("name"))
    else:
        author_str = ", ".join(str(a) for a in authors)

    summary = paper.get("summary") or paper.get("abstract") or ""
    if summary and len(summary) > 400:
        summary = summary[:397] + "..."

    return {
        "id": arxiv_id,
        "title": paper.get("title") or arxiv_id or "Untitled",
        "author": author_str or "Unknown author",
        "description": summary,
        "arxiv_id": arxiv_id,
    }


@app.route("/api/hf-search", methods=["GET"])
def hf_search():
    """Search Hugging Face papers index (public /api/papers/search, no token)."""
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    # HF enforces a short maximum query length on this endpoint.
    query = query[:250]

    try:
        response = requests.get(
            "https://huggingface.co/api/papers/search",
            params={"q": query, "limit": 12},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException:
        return jsonify({"error": "Hugging Face papers search is unavailable."}), 502

    if isinstance(data, dict):
        results = data.get("papers") or data.get("results") or []
    elif isinstance(data, list):
        results = data
    else:
        results = []

    simplified = []
    for item in results[:12]:
        normalized = _normalize_hf_paper_entry(item)
        if normalized and normalized.get("arxiv_id"):
            simplified.append(normalized)

    if simplified:
        arxiv_ids = [entry["arxiv_id"] for entry in simplified]
        placeholders = ",".join("?" * len(arxiv_ids))
        db = get_db()
        rows = db.execute(
            f"SELECT arxiv_id FROM papers WHERE arxiv_id IN ({placeholders})",
            arxiv_ids,
        ).fetchall()
        imported_ids = {row["arxiv_id"] for row in rows}
        for entry in simplified:
            entry["already_imported"] = entry["arxiv_id"] in imported_ids

    return jsonify(simplified)


def arxiv_http_error_response(exc):
    """Map arXiv HTTP failures to a clear API status for the UI."""
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        code = exc.response.status_code
        if code == 429:
            return jsonify(
                {"error": "arXiv is rate-limiting requests. Wait a minute, then try Import again."}
            ), 503
        if code in (503, 504):
            return jsonify({"error": "arXiv is temporarily unavailable. Try again shortly."}), 503
    return jsonify({"error": f"Failed to reach arXiv: {exc}"}), 502


@app.route("/api/hf-import", methods=["POST"])
def hf_import():
    """Import a paper from Hugging Face by arXiv ID if available."""
    data = request.get_json(silent=True) or {}
    arxiv_id = normalize_arxiv_id(data.get("arxiv_id"))
    if not arxiv_id:
        return jsonify({"error": "arxiv_id is required for import."}), 400

    try:
        metadata = fetch_arxiv_metadata(arxiv_id)
    except requests.HTTPError as exc:
        return arxiv_http_error_response(exc)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to fetch arXiv metadata: {exc}"}), 502

    if metadata is None:
        return jsonify({"error": "arXiv metadata not found for that ID."}), 404

    pdf_url = f"https://arxiv.org/pdf/{metadata['arxiv_id']}.pdf"
    try:
        pdf_response = fetch_url_with_retries(pdf_url, timeout=30, retries=4, backoff=2.0)
    except requests.HTTPError as exc:
        return arxiv_http_error_response(exc)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to download PDF: {exc}"}), 502

    pdf_path = PDF_DIR / f"{metadata['arxiv_id']}.pdf"
    pdf_path.write_bytes(pdf_response.content)
    extracted_text = ""
    try:
        reader = PdfReader(str(pdf_path))
        extracted_text = "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception:
        extracted_text = ""

    db = get_db()
    db.execute(
        "INSERT OR REPLACE INTO papers (arxiv_id, title, authors, year, category, source, extracted_text, pdf_path, date_added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            metadata["arxiv_id"],
            metadata["title"],
            metadata["authors"],
            metadata["year"],
            metadata["category"],
            "HuggingFace",
            extracted_text,
            str(pdf_path),
            datetime.datetime.utcnow().isoformat(),
        ),
    )
    db.commit()
    return jsonify({"success": True, "paper": metadata})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
