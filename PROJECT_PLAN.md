# Project Implementation Plan

This document describes how the Paper Library App was implemented from the project asset document.

## Summary

The application is a local Flask-based library manager for academic PDFs with the following core capabilities:

- PDF drag-and-drop upload
- arXiv ID extraction from PDF content
- arXiv metadata lookup
- Local SQLite persistence
- Built-in PDF viewer with highlight storage
- Tagging, filtering, and search across papers
- Hugging Face Hub discovery and import support

## Project Structure

- `app.py` - Flask app entrypoint and all backend routes
- `requirements.txt` - Python dependency manifest
- `README.md` - Setup and usage instructions
- `PROJECT_PLAN.md` - Implementation documentation
- `data/library.db` - Persistent SQLite database created on first run
- `data/pdfs/` - Stored PDF files keyed by arXiv ID
- `templates/index.html` - Main library page UI
- `templates/viewer.html` - In-app PDF viewer and highlight UI
- `static/main.js` - Frontend application logic
- `static/style.css` - App styling and responsive layout

## Implementation Notes

- The app uses `PyPDF2` to extract text from uploaded PDFs and locate arXiv identifiers.
- Supports both modern arXiv IDs (e.g. `2101.12345`) and legacy IDs (e.g. `math/0301234`) inside the PDF body.
- Metadata is fetched by querying the arXiv public API and parsing the Atom XML response.
- Six default tags are loaded automatically into the database on first startup.
- Highlights are stored server-side with page coordinates so they persist across reloads.
- The Hugging Face Hub search is implemented through a public `https://huggingface.co/api/models` endpoint with a fallback if the service is unavailable.
- The user interface is built with vanilla JavaScript and CSS custom properties for the colour palette.

## Usage

1. Start the Flask server.
2. Drop a PDF into the page or use the import interface.
3. View imported papers in the library list.
4. Open a paper in the built-in viewer.
5. Create highlights and assign tags to papers.
6. Search the library by title, author, or full-text extracted content.
