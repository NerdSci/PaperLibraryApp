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


def fetch_url_with_retries(url, timeout=15, retries=3, backoff=1.0):
    """Fetch a URL with retries and exponential backoff."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return requests.get(url, timeout=timeout)
        except requests.RequestException as exc:
            last_error = exc
            if attempt == retries:
                raise
            time.sleep(backoff * attempt)


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
    urls = [
        f"https://export.arxiv.org/api/query?id_list={arxiv_id}",
        f"http://export.arxiv.org/api/query?id_list={arxiv_id}",
    ]
    last_error = None
    for url in urls:
        try:
            response = fetch_url_with_retries(url, timeout=15)
            response.raise_for_status()
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
                "arxiv_id": arxiv_id,
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
    """Return the library data, optionally filtered by search query or tag."""
    query = request.args.get("q", "").strip()
    tag_id = request.args.get("tag_id")
    db = get_db()
    sql = "SELECT p.* FROM papers p"
    params = []
    if tag_id:
        sql += " JOIN paper_tags pt ON p.id = pt.paper_id WHERE pt.tag_id = ?"
        params.append(tag_id)
        if query:
            sql += " AND (p.title LIKE ? OR p.authors LIKE ? OR p.extracted_text LIKE ?)"
            params.extend([f"%{query}%"] * 3)
    elif query:
        sql += " WHERE p.title LIKE ? OR p.authors LIKE ? OR p.extracted_text LIKE ?"
        params.extend([f"%{query}%"] * 3)
    sql += " ORDER BY p.date_added DESC"
    papers = [row_to_dict(row) for row in db.execute(sql, params).fetchall()]
    for paper in papers:
        tag_rows = db.execute(
            "SELECT t.* FROM tags t JOIN paper_tags pt ON t.id = pt.tag_id WHERE pt.paper_id = ? ORDER BY t.display_order",
            (paper["id"],),
        ).fetchall()
        paper["tags"] = [row_to_dict(tag) for tag in tag_rows]
    return jsonify(papers)


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
    """Assign a set of tag IDs to a paper."""
    data = request.get_json(silent=True) or {}
    paper_id = data.get("paper_id")
    tag_ids = data.get("tag_ids", [])
    if not paper_id:
        return jsonify({"error": "paper_id is required."}), 400

    db = get_db()
    db.execute("DELETE FROM paper_tags WHERE paper_id = ?", (paper_id,))
    for tag_id in tag_ids:
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
        return jsonify([row_to_dict(row) for row in rows])

    data = request.get_json(silent=True) or {}
    page_number = data.get("page_number")
    x = float(data.get("x", 0))
    y = float(data.get("y", 0))
    width = float(data.get("width", 0))
    height = float(data.get("height", 0))
    color = data.get("color", "#FDE68A")
    selected_text = data.get("selected_text", "")
    created_at = datetime.datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO highlights (paper_id, page_number, x, y, width, height, color, selected_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (paper_id, page_number, x, y, width, height, color, selected_text, created_at),
    )
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


@app.route("/api/hf-search", methods=["GET"])
def hf_search():
    """Search the Hugging Face hub for papers or models without requiring a token."""
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    candidates = [
        ("https://huggingface.co/api/models", {"search": query}),
        ("https://huggingface.co/api/hub/search", {"search": query, "type": "model"}),
    ]

    results = None
    for hf_url, params in candidates:
        try:
            response = fetch_url_with_retries(hf_url, timeout=10, retries=2)
            if response.status_code == 404:
                continue
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict) and "results" in data:
                results = data["results"]
            elif isinstance(data, list):
                results = data
            else:
                results = []
            break
        except Exception:
            results = None
            continue

    if results is None:
        return jsonify([])

    simplified = []
    for item in results[:12]:
        metadata = item.get("cardData", {}) if isinstance(item, dict) else {}
        arxiv_id = None
        if isinstance(metadata, dict):
            paper_refs = metadata.get("paper", [])
            if isinstance(paper_refs, list) and paper_refs:
                arxiv_id = paper_refs[0].get("external_id") or paper_refs[0].get("arxiv_id")
        if not arxiv_id and isinstance(item, dict):
            tags = item.get("tags", [])
            for tag in tags:
                if isinstance(tag, str) and tag.startswith("arxiv:"):
                    arxiv_id = tag.split(":", 1)[1]
                    break
        simplified.append(
            {
                "id": item.get("id"),
                "title": item.get("modelId") or item.get("id"),
                "author": item.get("author"),
                "description": item.get("cardData", {}).get("description", "") if isinstance(item.get("cardData"), dict) else item.get("summary", ""),
                "arxiv_id": arxiv_id,
            }
        )
    return jsonify(simplified)


@app.route("/api/hf-import", methods=["POST"])
def hf_import():
    """Import a paper from Hugging Face by arXiv ID if available."""
    data = request.get_json(silent=True) or {}
    arxiv_id = data.get("arxiv_id")
    if not arxiv_id:
        return jsonify({"error": "arxiv_id is required for import."}), 400

    try:
        metadata = fetch_arxiv_metadata(arxiv_id)
    except Exception as exc:
        return jsonify({"error": f"Failed to fetch arXiv metadata: {exc}"}), 500

    if metadata is None:
        return jsonify({"error": "arXiv metadata not found."}), 404

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    response = requests.get(pdf_url, timeout=10)
    response.raise_for_status()
    pdf_path = PDF_DIR / f"{arxiv_id}.pdf"
    pdf_path.write_bytes(response.content)
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
