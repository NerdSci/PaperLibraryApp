const api = {
    fetchJson: async (url, opts = {}) => {
        const response = await fetch(url, opts)
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || response.statusText)
        }
        return response.json()
    },

    getPapers: async (query = "", tagId = null) => {
        const params = new URLSearchParams()
        if (query) params.set("q", query)
        if (tagId) params.set("tag_id", tagId)
        return api.fetchJson(`/api/papers?${params.toString()}`)
    },

    getTags: async () => api.fetchJson("/api/tags"),

    uploadPdf: async (file) => {
        const form = new FormData()
        form.append("pdf", file)
        return api.fetchJson("/api/add-paper", { method: "POST", body: form })
    },

    savePaperTags: async (paperId, tagIds) => {
        return api.fetchJson("/api/update-paper-tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paper_id: paperId, tag_ids: tagIds }),
        })
    },

    hfSearch: async (query) => api.fetchJson(`/api/hf-search?q=${encodeURIComponent(query)}`),

    hfImport: async (arxivId) => {
        return api.fetchJson("/api/hf-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ arxiv_id: arxivId }),
        })
    },

    getHighlights: async (paperId) => api.fetchJson(`/api/highlights/${paperId}`),

    saveHighlight: async (paperId, highlight) => {
        return api.fetchJson(`/api/highlights/${paperId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(highlight),
        })
    },
}

const dom = {
    $(selector) {
        return document.querySelector(selector)
    },
    $all(selector) {
        return Array.from(document.querySelectorAll(selector))
    },
}

function showStatus(message, type = "info") {
    const status = dom.$("#status-message")
    if (!status) return
    status.textContent = message
    status.className = `status ${type}`
    if (type !== "error") {
        setTimeout(() => {
            status.textContent = ""
            status.className = "status"
        }, 4000)
    }
}

async function renderTags(selectedTag) {
    const tags = await api.getTags()
    const container = dom.$("#tag-list")
    container.innerHTML = ""
    const allTag = document.createElement("button")
    allTag.type = "button"
    allTag.className = selectedTag ? "tag-chip" : "tag-chip active"
    allTag.textContent = "All"
    allTag.addEventListener("click", () => loadLibrary())
    container.appendChild(allTag)

    tags.forEach((tag) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = tag.id === selectedTag ? "tag-chip active" : "tag-chip"
        button.style.borderColor = tag.color
        button.textContent = tag.name
        button.addEventListener("click", () => loadLibrary(dom.$("#search-input").value.trim(), tag.id))
        container.appendChild(button)
    })
}

async function renderLibrary(query = "", tagId = null) {
    const papers = await api.getPapers(query, tagId)
    const container = dom.$("#library-list")
    container.innerHTML = ""
    if (papers.length === 0) {
        container.innerHTML = "<p class=\"empty-state\">No matching papers yet.</p>"
        return
    }

    papers.forEach((paper) => {
        const card = document.createElement("article")
        card.className = "paper-row"
        const tagChipHtml = paper.tags.map((tag) => `<span class=\"paper-tag\" style=\"background:${tag.color};\">${tag.name}</span>`).join("")
        card.innerHTML = `
      <div class="paper-meta">
        <div class="paper-title">${paper.title}</div>
        <div class="paper-info">${paper.authors} · [${paper.category}] · ${paper.year} · ${paper.source}</div>
        <div class="paper-tags">${tagChipHtml}</div>
      </div>
      <div class="paper-actions">
        <a class="secondary-button" href="/viewer/${paper.id}">PDF</a>
      </div>
    `
        container.appendChild(card)
    })
}

let currentTagFilter = null

async function loadLibrary(query = "", tagId = null) {
    currentTagFilter = tagId
    await renderTags(tagId)
    await renderLibrary(query, tagId)
}

function activateDropZone() {
    const dropZone = dom.$("#drop-zone")
    const fileInput = document.createElement("input")
    fileInput.type = "file"
    fileInput.accept = ".pdf"
    fileInput.style.display = "none"
    document.body.appendChild(fileInput)

    dropZone.addEventListener("click", () => fileInput.click())
    fileInput.addEventListener("change", async (event) => {
        const file = event.target.files[0]
        if (file) {
            await handleFileUpload(file)
            fileInput.value = ""
        }
    })

    dropZone.addEventListener("dragover", (event) => {
        event.preventDefault()
        dropZone.classList.add("drag-over")
    })
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"))
    dropZone.addEventListener("drop", async (event) => {
        event.preventDefault()
        dropZone.classList.remove("drag-over")
        const file = event.dataTransfer.files[0]
        if (file) {
            await handleFileUpload(file)
        }
    })
}

async function handleFileUpload(file) {
    try {
        showStatus("Uploading PDF and looking up metadata…", "info")
        await api.uploadPdf(file)
        showStatus("Paper added successfully.", "success")
        loadLibrary(dom.$("#search-input").value.trim(), currentTagFilter)
    } catch (error) {
        showStatus(error.message || "Upload failed.", "error")
    }
}

function addKeyboardSearchShortcut() {
    document.addEventListener("keydown", (event) => {
        if (event.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
            event.preventDefault()
            dom.$("#search-input").focus()
        }
    })
}

function activateHfModal() {
    const modal = dom.$("#hf-modal")
    const openButton = dom.$("#open-hf-search")
    const closeButton = dom.$("#close-hf-modal")
    const searchButton = dom.$("#hf-search-button")
    const searchInput = dom.$("#hf-search-input")
    const results = dom.$("#hf-results")

    openButton.addEventListener("click", () => {
        modal.classList.remove("hidden")
        searchInput.focus()
    })
    closeButton.addEventListener("click", () => modal.classList.add("hidden"))
    searchButton.addEventListener("click", () => doHfSearch(searchInput.value.trim(), results))
    searchInput.addEventListener("keypress", (event) => {
        if (event.key === "Enter") {
            doHfSearch(searchInput.value.trim(), results)
        }
    })
}

async function doHfSearch(query, resultsContainer) {
    if (!query) {
        resultsContainer.innerHTML = "<p class='empty-state'>Enter a query to search.</p>"
        return
    }
    resultsContainer.innerHTML = "<p class='loading'>Searching Hugging Face…</p>"
    try {
        const items = await api.hfSearch(query)
        if (items.error) {
            throw new Error(items.error)
        }
        if (items.length === 0) {
            resultsContainer.innerHTML = "<p class='empty-state'>No results found.</p>"
            return
        }
        resultsContainer.innerHTML = ""
        items.forEach((item) => {
            const card = document.createElement("article")
            card.className = "hf-result"
            card.innerHTML = `
        <div class="hf-result-title">${item.title}</div>
        <div class="hf-result-author">${item.author || "Unknown author"}</div>
        <div class="hf-result-desc">${item.description || "No description."}</div>
        <div class="hf-result-meta">arXiv ID: ${item.arxiv_id || "None provided"}</div>
      ` 
            const importButton = document.createElement("button")
            importButton.type = "button"
            importButton.className = "primary-button"
            importButton.textContent = "Import"
            importButton.disabled = !item.arxiv_id
            importButton.addEventListener("click", async () => {
                if (!item.arxiv_id) return
                try {
                    await api.hfImport(item.arxiv_id)
                    showStatus("Imported paper from Hugging Face successfully.", "success")
                    loadLibrary(dom.$("#search-input").value.trim(), currentTagFilter)
                } catch (err) {
                    showStatus(err.message || "Import failed.", "error")
                }
            })
            card.appendChild(importButton)
            resultsContainer.appendChild(card)
        })
    } catch (error) {
        resultsContainer.innerHTML = `<p class='empty-state'>${error.message || "Search failed."}</p>`
    }
}

async function initIndexPage() {
    activateDropZone()
    addKeyboardSearchShortcut()
    activateHfModal()
    dom.$("#search-input").addEventListener("input", (event) => {
        loadLibrary(event.target.value.trim(), currentTagFilter)
    })
    dom.$("#clear-filter").addEventListener("click", () => {
        dom.$("#search-input").value = ""
        loadLibrary()
    })
    loadLibrary()
}

function createOverlay(highlight) {
    const div = document.createElement("div")
    div.className = "highlight-overlay"
    div.style.left = `${highlight.x * 100}%`
    div.style.top = `${highlight.y * 100}%`
    div.style.width = `${highlight.width * 100}%`
    div.style.height = `${highlight.height * 100}%`
    div.style.backgroundColor = highlight.color
    return div
}

function sortTextLayerByVisualPosition(textLayer) {
    window.__sortTextLayerRan = true
    const spans = Array.from(textLayer.querySelectorAll('span'))
    spans.sort((a, b) => {
        const rectA = a.getBoundingClientRect()
        const rectB = b.getBoundingClientRect()
        const topDiff = rectA.top - rectB.top
        if (Math.abs(topDiff) > 3) {
            return topDiff
        }
        return rectA.left - rectB.left
    })

    spans.forEach((span) => textLayer.appendChild(span))
    Array.from(textLayer.querySelectorAll('br')).forEach((br) => br.remove())
}

async function initViewerPage() {
    if (typeof window.PAPER_ID !== "number") return

    const canvas = dom.$("#pdf-canvas")
    const textLayer = dom.$("#text-layer")
    const highlightLayer = dom.$("#highlight-layer")
    const loader = dom.$("#viewer-loader")
    const pageInfo = dom.$("#page-info")
    const pdfContainer = dom.$("#pdf-container")
    const saveButton = dom.$("#save-highlight")

    let pdfDoc = null
    let currentPage = 1
    let pageScale = 1.25
    let pageViewport = null
    let selectedBox = null

    if (typeof pdfjsLib === "undefined") {
        loader.textContent = "PDF.js failed to initialize. Please check your internet connection or use a supported browser."
        return
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.worker.min.js"
    const documentUrl = `/api/pdf/${window.PAPER_ID}`

    const renderPage = async (pageNumber) => {
        const page = await pdfDoc.getPage(pageNumber)
        const viewport = page.getViewport({ scale: pageScale })
        const context = canvas.getContext("2d")
        canvas.width = viewport.width
        canvas.height = viewport.height
        pageViewport = viewport

        const renderContext = { canvasContext: context, viewport }
        await page.render(renderContext).promise
        pdfContainer.style.width = `${viewport.width}px`
        pdfContainer.style.height = `${viewport.height}px`
        textLayer.innerHTML = ""

        const textContent = await page.getTextContent()
        const items = textContent.items.map((item) => {
            const tm = pdfjsLib.Util.transform(viewport.transform, item.transform)
            return {
                item,
                tm,
                top: tm[5],
                left: tm[4],
            }
        })

        items.sort((a, b) => {
            const topDiff = a.top - b.top
            if (Math.abs(topDiff) > 5) {
                return topDiff
            }
            return a.left - b.left
        })

        items.forEach(({ item, tm }) => {
            const span = document.createElement("span")
            span.textContent = item.str

            span.style.display = 'inline-block'
            span.style.color = 'transparent'
            span.style.opacity = '1'
            span.style.textShadow = 'none'
            span.style.fontSize = '0.5px'
            span.style.lineHeight = '1'
            span.style.whiteSpace = 'pre'
            span.style.position = 'absolute'
            span.style.left = '0px'
            span.style.top = '0px'
            span.style.transform = `matrix(${tm[0].toFixed(6)}, ${tm[1].toFixed(6)}, ${tm[2].toFixed(6)}, ${tm[3].toFixed(6)}, ${tm[4].toFixed(2)}, ${tm[5].toFixed(2)}) scaleY(-1)`
            span.style.transformOrigin = '0 0'
            span.style.pointerEvents = 'auto'
            span.style.userSelect = 'text'
            span.style.cursor = 'text'
            span.style.margin = '0'
            span.style.padding = '0'
            span.style.border = 'none'
            span.className = 'text-item'

            textLayer.appendChild(span)
        })

        pageInfo.textContent = `Page ${pageNumber} / ${pdfDoc.numPages}`
        loader.classList.add("hidden")
        await loadHighlights()
    }

    const loadHighlights = async () => {
        highlightLayer.innerHTML = ""
        const highlights = await api.getHighlights(window.PAPER_ID)
        highlights.forEach((highlight) => {
            if (highlight.page_number !== currentPage) return
            highlightLayer.appendChild(createOverlay(highlight))
        })
    }

    const extractSelectedText = () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) {
            return ""
        }
        const range = selection.getRangeAt(0)
        const rects = Array.from(range.getClientRects())
        if (!rects.length) {
            return selection.toString().trim()
        }

        const spans = Array.from(textLayer.querySelectorAll('span'))
            .filter((span) => {
                const rect = span.getBoundingClientRect()
                return rects.some((r) =>
                    rect.left < r.right && r.left < rect.right && rect.top < r.bottom && r.top < rect.bottom
                )
            })
            .sort((a, b) => {
                const rectA = a.getBoundingClientRect()
                const rectB = b.getBoundingClientRect()
                const topDiff = rectA.top - rectB.top
                if (Math.abs(topDiff) > 3) {
                    return topDiff
                }
                return rectA.left - rectB.left
            })
        const text = spans.map((span) => span.textContent).join("").trim()
        return text || selection.toString().trim()
    }

    const captureSelection = () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) {
            selectedBox = null
            return
        }
        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        const containerRect = pdfContainer.getBoundingClientRect()
        if (!rect.width || !rect.height) {
            selectedBox = null
            return
        }
        selectedBox = {
            x: (rect.left - containerRect.left) / containerRect.width,
            y: (rect.top - containerRect.top) / containerRect.height,
            width: rect.width / containerRect.width,
            height: rect.height / containerRect.height,
            selected_text: extractSelectedText(),
            page_number: currentPage,
            color: "rgba(253, 230, 138, 0.45)",
        }
    }

    saveButton.addEventListener("click", async () => {
        if (!selectedBox || !selectedBox.selected_text) {
            showStatus("Select text before saving a highlight.", "error")
            return
        }
        try {
            await api.saveHighlight(window.PAPER_ID, selectedBox)
            showStatus("Highlight saved.", "success")
            await loadHighlights()
            window.getSelection().removeAllRanges()
            selectedBox = null
        } catch (error) {
            showStatus(error.message || "Could not save highlight.", "error")
        }
    })

    dom.$("#prev-page").addEventListener("click", () => {
        if (currentPage <= 1) return
        currentPage -= 1
        renderPage(currentPage)
    })
    dom.$("#next-page").addEventListener("click", () => {
        if (currentPage >= pdfDoc.numPages) return
        currentPage += 1
        renderPage(currentPage)
    })

    pdfContainer.addEventListener("mouseup", captureSelection)
    pdfContainer.addEventListener("keyup", captureSelection)

    pdfDoc = await pdfjsLib.getDocument(documentUrl).promise
    await renderPage(currentPage)
}

window.addEventListener("DOMContentLoaded", () => {
    if (dom.$("#drop-zone")) {
        initIndexPage()
    }
    if (dom.$("#pdf-canvas")) {
        initViewerPage()
    }
})
