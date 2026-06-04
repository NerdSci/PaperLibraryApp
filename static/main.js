/**
 * Paper Library App — client-side logic for the library page and PDF viewer.
 * See docs/plan-*.md for feature-level implementation notes.
 */

/**
 * PDF.js build served from jsDelivr (pdfjs-dist package).
 * cdnjs "pdf.js/3.17.0" paths 404 — do not use that host for this version.
 */
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build"

/** Plan-09: device pixel ratio for canvas + text layer alignment. */
function getOutputRatio() {
    return window.devicePixelRatio || 1
}

/**
 * Plan-08/09: return true when the browser selection is inside the PDF text layer.
 */
function selectionAnchoredIn(containerEl) {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false
    const anchor = selection.anchorNode
    const focus = selection.focusNode
    return (
        (anchor && containerEl.contains(anchor)) ||
        (focus && containerEl.contains(focus))
    )
}

/** Resolve a DOM node to its PDF.js text-layer div index, if any. */
function findTextDivIndex(node, textDivs) {
    let el = node
    if (el?.nodeType === Node.TEXT_NODE) el = el.parentElement
    while (el && el !== document.body) {
        const idx = textDivs.indexOf(el)
        if (idx >= 0) return idx
        el = el.parentElement
    }
    return -1
}

/**
 * Plan-10: selected text from the browser range (matches visible selection).
 * Falls back to textDiv indices only when toString() is empty on the PDF layer.
 */
function extractSelectedText(range, textDivs, textContentItemsStr, textItems) {
    if (!range || range.collapsed) return ""

    const direct = range.toString().replace(/\s+/g, " ").trim()
    if (direct) return direct

    const startIdx = findTextDivIndex(range.startContainer, textDivs)
    const endIdx = findTextDivIndex(range.endContainer, textDivs)
    if (startIdx < 0 || endIdx < 0) return ""

    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const parts = []
    for (let i = lo; i <= hi; i++) {
        const chunk = textContentItemsStr[i] ?? textDivs[i]?.textContent ?? ""
        if (chunk) parts.push(chunk)
        if (textItems?.[i]?.hasEOL && i < hi) parts.push(" ")
    }
    return parts.join("").replace(/[ \t]+/g, " ").trim()
}

/** Convert a viewport client rect to normalized 0–1 coords against a reference element. */
function normalizeClientRect(rect, referenceEl) {
    const ref = referenceEl.getBoundingClientRect()
    if (!ref.width || !ref.height) return null
    return {
        x: (rect.left - ref.left) / ref.width,
        y: (rect.top - ref.top) / ref.height,
        width: rect.width / ref.width,
        height: rect.height / ref.height,
    }
}

/** Merge normalized rects into one bounding box (legacy x/y/width/height). */
function unionNormalizedRects(rects) {
    if (!rects?.length) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const r of rects) {
        minX = Math.min(minX, r.x)
        minY = Math.min(minY, r.y)
        maxX = Math.max(maxX, r.x + r.width)
        maxY = Math.max(maxY, r.y + r.height)
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Plan-10: overlay geometry from selection quads only (never full PDF.js textDiv boxes).
 */
function captureNormalizedRects(range, referenceEl) {
    const ref = referenceEl.getBoundingClientRect()
    if (!ref.width || !ref.height) return []

    const rects = Array.from(range.getClientRects())
        .filter((r) => r.width > 0.5 || r.height > 0.5)
        .map((r) => normalizeClientRect(r, referenceEl))
        .filter(Boolean)

    if (rects.length) return rects

    const fallback = normalizeClientRect(range.getBoundingClientRect(), referenceEl)
    return fallback ? [fallback] : []
}

/** Parse stored highlight geometry (multi-rect or legacy single box). */
function getHighlightRects(highlight) {
    if (Array.isArray(highlight.rects) && highlight.rects.length) {
        return highlight.rects
    }
    if (highlight.rects_json) {
        try {
            const parsed = JSON.parse(highlight.rects_json)
            if (Array.isArray(parsed) && parsed.length) return parsed
        } catch {
            /* use legacy fields */
        }
    }
    return [
        {
            x: highlight.x,
            y: highlight.y,
            width: highlight.width,
            height: highlight.height,
        },
    ]
}

/** Translucent highlight colours aligned with default tag palette (plan-07). */
const HIGHLIGHT_COLORS = [
    { label: "Yellow", value: "rgba(253, 230, 138, 0.45)" },
    { label: "Red", value: "rgba(253, 164, 175, 0.45)" },
    { label: "Green", value: "rgba(134, 239, 172, 0.45)" },
    { label: "Blue", value: "rgba(147, 197, 253, 0.45)" },
    { label: "Purple", value: "rgba(196, 181, 253, 0.45)" },
]

const api = {
    fetchJson: async (url, opts = {}) => {
        const response = await fetch(url, opts)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error(data.error || response.statusText)
        }
        return data
    },

    getPapers: async (query = "", tagId = null, source = null) => {
        const params = new URLSearchParams()
        if (query) params.set("q", query)
        if (tagId) params.set("tag_id", tagId)
        if (source) params.set("source", source)
        return api.fetchJson(`/api/papers?${params.toString()}`)
    },

    deletePaper: async (paperId) =>
        api.fetchJson(`/api/papers/${paperId}`, { method: "DELETE" }),

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

    deleteHighlight: async (highlightId) => {
        return api.fetchJson(`/api/highlights/item/${highlightId}`, { method: "DELETE" })
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

/** Index-page state shared across library, tags, filters, and bulk actions. */
const indexState = {
    currentTagFilter: null,
    sourceFilter: null,
    cachedTags: null,
    selectedPaperIds: new Set(),
    editingPaperId: null,
    tagEditorTargetIds: null,
    tagEditorAnchorEl: null,
    uploadInProgress: false,
    dragDepth: 0,
}

function escapeHtml(text) {
    const div = document.createElement("div")
    div.textContent = text == null ? "" : String(text)
    return div.innerHTML
}

/** Google Material Symbols icon (see templates/includes/fonts.html). */
function icon(name, extraClass = "") {
    const el = document.createElement("span")
    el.className = extraClass
        ? `material-symbols-outlined ${extraClass}`
        : "material-symbols-outlined"
    el.textContent = name
    el.setAttribute("aria-hidden", "true")
    return el
}

function setButtonLabel(btn, iconName, label) {
    btn.replaceChildren()
    btn.appendChild(icon(iconName, "btn-icon"))
    const text = document.createElement("span")
    text.className = "btn-label"
    text.textContent = label
    btn.appendChild(text)
}

function setLinkLabel(link, iconName, label) {
    link.replaceChildren()
    link.appendChild(icon(iconName, "btn-icon"))
    const text = document.createElement("span")
    text.className = "btn-label"
    text.textContent = label
    link.appendChild(text)
}

function setPageInfo(el, pageNumber, totalPages) {
    if (!el) return
    el.replaceChildren()
    el.appendChild(icon("description", "page-info__icon"))
    const text = document.createElement("span")
    text.className = "page-info__text"
    text.textContent = `Page ${pageNumber} / ${totalPages}`
    el.appendChild(text)
}

const TOAST_AUTO_DISMISS_MS = 4500
const ARXIV_RATE_LIMIT_RE = /rate-limit/i

let statusDismissTimer = null
let activeToast = null

function getToastContainer() {
    let container = dom.$("#toast-container")
    if (!container) {
        container = document.createElement("div")
        container.id = "toast-container"
        container.className = "toast-container"
        container.setAttribute("aria-live", "polite")
        document.body.appendChild(container)
    }
    return container
}

function clearStatusDismissTimer() {
    if (statusDismissTimer) {
        clearTimeout(statusDismissTimer)
        statusDismissTimer = null
    }
}

function removeToastImmediate(alertEl) {
    clearStatusDismissTimer()
    if (!alertEl) return
    if (activeToast === alertEl) activeToast = null
    alertEl.remove()
}

function dismissToast(alertEl) {
    if (!alertEl?.isConnected) return
    if (activeToast === alertEl) activeToast = null
    clearStatusDismissTimer()
    alertEl.classList.remove("toast-alert--visible")
    alertEl.classList.add("toast-alert--leaving")
    const remove = () => alertEl.remove()
    alertEl.addEventListener("transitionend", remove, { once: true })
    setTimeout(remove, 280)
}

function parseToastContent(message, type) {
    if (ARXIV_RATE_LIMIT_RE.test(message)) {
        return {
            toastType: "warning",
            title: "arXiv is rate-limiting requests",
            message: "Wait a minute, then try Import again.",
            icon: "schedule",
        }
    }
    const icons = {
        success: "check_circle",
        error: "error",
        warning: "warning",
        info: "info",
    }
    return {
        toastType: type,
        title: null,
        message,
        icon: icons[type] || icons.info,
    }
}

function showStatus(message, type = "info", options = {}) {
    const legacy = dom.$("#status-message")
    if (legacy) {
        legacy.textContent = ""
        legacy.className = "status"
    }

    if (!message) {
        if (activeToast) removeToastImmediate(activeToast)
        return
    }

    if (activeToast) removeToastImmediate(activeToast)

    const { toastType, title, message: bodyText, icon: iconName } = parseToastContent(message, type)
    const autoDismiss = options.autoDismiss ?? type !== "info"
    const autoDismissMs = options.autoDismissMs ?? TOAST_AUTO_DISMISS_MS

    const alert = document.createElement("div")
    alert.className = `toast-alert toast-alert--${toastType}`
    alert.setAttribute("role", "alert")

    const iconEl = icon(iconName, "toast-alert__icon")

    const body = document.createElement("div")
    body.className = "toast-alert__body"
    if (title) {
        const titleEl = document.createElement("div")
        titleEl.className = "toast-alert__title"
        titleEl.textContent = title
        body.appendChild(titleEl)
    }
    const textEl = document.createElement("p")
    textEl.className = "toast-alert__message"
    textEl.textContent = bodyText
    body.appendChild(textEl)

    const dismissBtn = document.createElement("button")
    dismissBtn.type = "button"
    dismissBtn.className = "toast-alert__dismiss icon-button"
    dismissBtn.setAttribute("aria-label", "Dismiss notification")
    dismissBtn.appendChild(icon("close"))
    dismissBtn.addEventListener("click", () => dismissToast(alert))

    alert.append(iconEl, body, dismissBtn)
    getToastContainer().appendChild(alert)
    activeToast = alert
    requestAnimationFrame(() => alert.classList.add("toast-alert--visible"))

    if (autoDismiss) {
        statusDismissTimer = setTimeout(() => dismissToast(alert), autoDismissMs)
    }
}

function getActiveSourceFilter() {
    const arxiv = dom.$("#filter-source-arxiv")?.checked
    const hf = dom.$("#filter-source-hf")?.checked
    if (arxiv && !hf) return "arXiv"
    if (hf && !arxiv) return "HuggingFace"
    return null
}

function updateFilterPanelStatus() {
    const statusEl = dom.$("#filter-tag-status")
    if (!statusEl) return
    const tagName = indexState.currentTagFilter
        ? indexState.cachedTags?.find((t) => t.id === indexState.currentTagFilter)?.name
        : null
    const source = getActiveSourceFilter()
    const parts = []
    parts.push(tagName ? `Tag: ${tagName}` : "Tag: All papers")
    if (source) parts.push(`Source: ${source}`)
    statusEl.textContent = parts.join(" · ")
}

async function ensureTagsCached() {
    if (!indexState.cachedTags) {
        indexState.cachedTags = await api.getTags()
    }
    return indexState.cachedTags
}

async function renderTags(selectedTag) {
    const tags = await ensureTagsCached()
    const container = dom.$("#tag-list")
    container.innerHTML = ""
    const allTag = document.createElement("button")
    allTag.type = "button"
    allTag.className = selectedTag ? "tag-chip" : "tag-chip active"
    setButtonLabel(allTag, "grid_view", "All")
    allTag.addEventListener("click", () => {
        clearPaperSelection()
        loadLibrary(dom.$("#search-input").value.trim(), null)
    })
    container.appendChild(allTag)

    tags.forEach((tag) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = tag.id === selectedTag ? "tag-chip active" : "tag-chip"
        button.style.borderColor = tag.color
        button.innerHTML = `<span class="tag-dot" style="background-color: ${tag.color};"></span><span>${escapeHtml(tag.name)}</span>`
        button.addEventListener("click", () => {
            clearPaperSelection()
            loadLibrary(dom.$("#search-input").value.trim(), tag.id)
        })
        container.appendChild(button)
    })
    updateFilterPanelStatus()
}

function updateBulkBar() {
    const bar = dom.$("#bulk-action-bar")
    const countEl = dom.$("#bulk-selection-count")
    const n = indexState.selectedPaperIds.size
    if (!bar) return
    if (n === 0) {
        bar.classList.add("hidden")
    } else {
        bar.classList.remove("hidden")
        countEl.textContent = `${n} selected`
    }
}

function clearPaperSelection() {
    indexState.selectedPaperIds.clear()
    const selectAll = dom.$("#select-all-papers")
    if (selectAll) selectAll.checked = false
    dom.$all(".paper-checkbox").forEach((cb) => {
        cb.checked = false
    })
    dom.$all(".paper-row.selected").forEach((row) => row.classList.remove("selected"))
    updateBulkBar()
}

async function renderLibrary(query = "", tagId = null, source = null) {
    closeTagEditor()
    const papers = await api.getPapers(query, tagId, source)
    const container = dom.$("#library-list")
    container.innerHTML = ""

    if (papers.length === 0) {
        container.innerHTML = '<p class="empty-state">No matching papers yet.</p>'
        return
    }

    papers.forEach((paper) => {
        const card = document.createElement("article")
        card.className = "paper-row"
        card.dataset.paperId = String(paper.id)
        if (indexState.selectedPaperIds.has(paper.id)) {
            card.classList.add("selected")
        }

        const checkbox = document.createElement("input")
        checkbox.type = "checkbox"
        checkbox.className = "paper-checkbox"
        checkbox.checked = indexState.selectedPaperIds.has(paper.id)
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                indexState.selectedPaperIds.add(paper.id)
                card.classList.add("selected")
            } else {
                indexState.selectedPaperIds.delete(paper.id)
                card.classList.remove("selected")
            }
            updateBulkBar()
        })

        const meta = document.createElement("div")
        meta.className = "paper-meta"

        const titleLink = document.createElement("a")
        titleLink.className = "paper-title-link"
        titleLink.href = `/viewer/${paper.id}`
        titleLink.textContent = paper.title

        const info = document.createElement("div")
        info.className = "paper-info"
        info.textContent = `${paper.authors} · [${paper.category}] · ${paper.year} · ${paper.source}`

        const tagsRow = document.createElement("div")
        tagsRow.className = "paper-tags-row"

        const chipsWrap = document.createElement("div")
        chipsWrap.className = "paper-tags"
        paper.tags.forEach((tag) => {
            const chip = document.createElement("span")
            chip.className = "paper-tag"
            chip.style.background = tag.color
            chip.textContent = tag.name
            chipsWrap.appendChild(chip)
        })

        const editTagsBtn = document.createElement("button")
        editTagsBtn.type = "button"
        editTagsBtn.className = "secondary-button edit-tags-button btn-with-icon"
        setButtonLabel(editTagsBtn, "sell", "Edit tags")
        editTagsBtn.addEventListener("click", (event) => {
            event.preventDefault()
            event.stopPropagation()
            void openTagEditor(
                paper.id,
                paper.tags.map((t) => t.id),
                event.currentTarget
            )
        })

        tagsRow.appendChild(chipsWrap)
        tagsRow.appendChild(editTagsBtn)

        meta.appendChild(titleLink)
        meta.appendChild(info)
        meta.appendChild(tagsRow)

        const actions = document.createElement("div")
        actions.className = "paper-actions"
        const pdfLink = document.createElement("a")
        pdfLink.className = "pdf-link btn-with-icon"
        pdfLink.href = `/viewer/${paper.id}`
        setLinkLabel(pdfLink, "picture_as_pdf", "PDF")
        const deleteBtn = document.createElement("button")
        deleteBtn.type = "button"
        deleteBtn.className = "secondary-button delete-paper-button btn-with-icon"
        setButtonLabel(deleteBtn, "delete", "Delete")
        deleteBtn.addEventListener("click", async () => {
            const message =
                `Remove "${paper.title}" from your library?\n\n` +
                "This deletes the stored PDF and all highlights. This cannot be undone."
            if (!window.confirm(message)) return
            deleteBtn.disabled = true
            try {
                await api.deletePaper(paper.id)
                indexState.selectedPaperIds.delete(paper.id)
                showStatus(`Removed "${paper.title}" from the library.`, "success")
                await loadLibrary(dom.$("#search-input").value.trim())
            } catch (err) {
                showStatus(err.message || "Could not delete paper.", "error")
                deleteBtn.disabled = false
            }
        })
        actions.appendChild(pdfLink)
        actions.appendChild(deleteBtn)

        card.appendChild(checkbox)
        card.appendChild(meta)
        card.appendChild(actions)
        container.appendChild(card)
    })

    const selectAll = dom.$("#select-all-papers")
    if (selectAll) {
        const visibleIds = papers.map((p) => p.id)
        selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => indexState.selectedPaperIds.has(id))
    }
}

async function loadLibrary(query = "", tagId = undefined, source = undefined) {
    if (tagId !== undefined) {
        indexState.currentTagFilter = tagId
    }
    if (source !== undefined) {
        indexState.sourceFilter = source
    }
    const effectiveSource = indexState.sourceFilter
    await renderTags(indexState.currentTagFilter)
    await renderLibrary(query, indexState.currentTagFilter, effectiveSource)
    updateBulkBar()
}

let tagEditorRepositionHandler = null

function unbindTagEditorReposition() {
    if (!tagEditorRepositionHandler) return
    window.removeEventListener("scroll", tagEditorRepositionHandler, true)
    window.removeEventListener("resize", tagEditorRepositionHandler)
    tagEditorRepositionHandler = null
}

function bindTagEditorReposition(anchorEl) {
    unbindTagEditorReposition()
    const popover = dom.$("#tag-editor-popover")
    if (!popover || !anchorEl) return
    tagEditorRepositionHandler = () => {
        if (popover.classList.contains("hidden")) return
        if (!anchorEl.isConnected) {
            closeTagEditor()
            return
        }
        positionTagEditorPopover(popover, anchorEl)
    }
    window.addEventListener("scroll", tagEditorRepositionHandler, true)
    window.addEventListener("resize", tagEditorRepositionHandler)
}

/** Position the tag popover in the viewport (fixed; do not add scroll offsets). */
function positionTagEditorPopover(popover, anchorEl) {
    const margin = 8
    const viewportPad = 12
    const anchorRect = anchorEl.getBoundingClientRect()

    popover.classList.remove("hidden")
    popover.style.visibility = "hidden"

    const popW = popover.offsetWidth
    const popH = popover.offsetHeight

    let top = anchorRect.bottom + margin
    let left = anchorRect.left

    if (top + popH > window.innerHeight - viewportPad) {
        const aboveTop = anchorRect.top - popH - margin
        if (aboveTop >= viewportPad) {
            top = aboveTop
        } else {
            top = Math.max(viewportPad, window.innerHeight - popH - viewportPad)
        }
    }

    if (left + popW > window.innerWidth - viewportPad) {
        left = window.innerWidth - popW - viewportPad
    }
    if (left < viewportPad) {
        left = viewportPad
    }

    popover.style.top = `${top}px`
    popover.style.left = `${left}px`
    popover.style.visibility = ""
}

function closeTagEditor() {
    unbindTagEditorReposition()
    const popover = dom.$("#tag-editor-popover")
    if (popover) {
        popover.classList.add("hidden")
        popover.style.visibility = ""
        popover.style.top = ""
        popover.style.left = ""
    }
    indexState.editingPaperId = null
    indexState.tagEditorTargetIds = null
    indexState.tagEditorAnchorEl = null
}

async function openTagEditor(paperIdOrIds, assignedTagIds, anchorEl) {
    const popover = dom.$("#tag-editor-popover")
    const options = dom.$("#tag-editor-options")
    if (!popover || !options || !anchorEl) return

    if (
        !popover.classList.contains("hidden") &&
        indexState.tagEditorAnchorEl === anchorEl
    ) {
        closeTagEditor()
        return
    }

    const paperIds = Array.isArray(paperIdOrIds) ? paperIdOrIds : [paperIdOrIds]
    indexState.tagEditorTargetIds = paperIds
    indexState.editingPaperId = paperIds.length === 1 ? paperIds[0] : null
    indexState.tagEditorAnchorEl = anchorEl

    const tags = await ensureTagsCached()
    const title = popover.querySelector(".tag-editor-title")
    title.textContent = paperIds.length > 1 ? `Tags for ${paperIds.length} papers` : "Tags for this paper"

    options.innerHTML = ""
    const selectedSet = new Set(assignedTagIds.map((id) => Number(id)))

    tags.forEach((tag) => {
        const label = document.createElement("label")
        label.className = "tag-editor-option"
        const input = document.createElement("input")
        input.type = "checkbox"
        input.checked = selectedSet.has(Number(tag.id))
        input.dataset.tagId = String(tag.id)
        const dot = document.createElement("span")
        dot.className = "tag-dot"
        dot.style.backgroundColor = tag.color
        label.appendChild(input)
        label.appendChild(dot)
        label.appendChild(document.createTextNode(tag.name))

        input.addEventListener("change", async () => {
            label.classList.add("saving")
            const checkedIds = dom
                .$all("#tag-editor-options input:checked")
                .map((el) => parseInt(el.dataset.tagId, 10))

            try {
                for (const pid of indexState.tagEditorTargetIds) {
                    await api.savePaperTags(pid, checkedIds)
                }
                showStatus("Tags updated.", "success")
                await loadLibrary(dom.$("#search-input").value.trim())
                closeTagEditor()
            } catch (error) {
                showStatus(error.message || "Could not save tags.", "error")
                input.checked = !input.checked
            } finally {
                label.classList.remove("saving")
            }
        })

        options.appendChild(label)
    })

    positionTagEditorPopover(popover, anchorEl)
    bindTagEditorReposition(anchorEl)
}

function isPdfFile(file) {
    if (!file) return false
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}

async function handleFileUpload(file) {
    if (!isPdfFile(file)) {
        showStatus("Only PDF files are supported.", "error")
        return
    }
    if (indexState.uploadInProgress) return
    indexState.uploadInProgress = true
    try {
        showStatus("Uploading PDF and looking up metadata…", "info")
        await api.uploadPdf(file)
        showStatus("Paper added successfully.", "success")
        loadLibrary(dom.$("#search-input").value.trim())
    } catch (error) {
        showStatus(error.message || "Upload failed.", "error")
    } finally {
        indexState.uploadInProgress = false
    }
}

/** Plan-03: accept drops anywhere on the index page, not only the drop zone. */
function activateGlobalDrop() {
    const dropZone = dom.$("#drop-zone")
    const overlay = dom.$("#drop-overlay")
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

    const hasFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files")

    const onDragEnter = (event) => {
        if (!hasFileDrag(event)) return
        if (!dom.$("#hf-modal")?.classList.contains("hidden")) return
        event.preventDefault()
        indexState.dragDepth += 1
        document.body.classList.add("page-drag-active")
        overlay?.classList.remove("hidden")
        dropZone?.classList.add("drag-over")
    }

    const onDragLeave = (event) => {
        if (!hasFileDrag(event)) return
        indexState.dragDepth = Math.max(0, indexState.dragDepth - 1)
        if (indexState.dragDepth === 0) {
            document.body.classList.remove("page-drag-active")
            overlay?.classList.add("hidden")
            dropZone?.classList.remove("drag-over")
        }
    }

    const onDragOver = (event) => {
        if (!hasFileDrag(event)) return
        if (!dom.$("#hf-modal")?.classList.contains("hidden")) return
        event.preventDefault()
    }

    const onDrop = async (event) => {
        if (!hasFileDrag(event)) return
        if (!dom.$("#hf-modal")?.classList.contains("hidden")) return
        event.preventDefault()
        indexState.dragDepth = 0
        document.body.classList.remove("page-drag-active")
        overlay?.classList.add("hidden")
        dropZone?.classList.remove("drag-over")
        const file = event.dataTransfer.files[0]
        if (file) await handleFileUpload(file)
    }

    document.body.addEventListener("dragenter", onDragEnter)
    document.body.addEventListener("dragleave", onDragLeave)
    document.body.addEventListener("dragover", onDragOver)
    document.body.addEventListener("drop", onDrop)
}

function addKeyboardSearchShortcut() {
    document.addEventListener("keydown", (event) => {
        if (event.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
            event.preventDefault()
            dom.$("#search-input").focus()
        }
        if (event.key === "Escape") {
            closeTagEditor()
            dom.$("#search-filter-panel")?.classList.add("hidden")
        }
    })
}

function activateSearchFilterPanel() {
    const toggle = dom.$("#search-filter-toggle")
    const panel = dom.$("#search-filter-panel")
    const clearBtn = dom.$("#filter-clear-all")
    const arxivCb = dom.$("#filter-source-arxiv")
    const hfCb = dom.$("#filter-source-hf")

    toggle?.addEventListener("click", () => {
        panel.classList.toggle("hidden")
        toggle.classList.toggle("active", !panel.classList.contains("hidden"))
    })

    const applySourceFilter = () => {
        if (arxivCb.checked && hfCb.checked) {
            showStatus("Select only one source filter, or clear both.", "error")
            return
        }
        indexState.sourceFilter = getActiveSourceFilter()
        clearPaperSelection()
        loadLibrary(dom.$("#search-input").value.trim())
    }

    arxivCb?.addEventListener("change", () => {
        if (arxivCb.checked) hfCb.checked = false
        applySourceFilter()
    })
    hfCb?.addEventListener("change", () => {
        if (hfCb.checked) arxivCb.checked = false
        applySourceFilter()
    })

    clearBtn?.addEventListener("click", () => {
        dom.$("#search-input").value = ""
        arxivCb.checked = false
        hfCb.checked = false
        indexState.sourceFilter = null
        indexState.currentTagFilter = null
        clearPaperSelection()
        loadLibrary()
    })
}

function activateBulkActions() {
    dom.$("#bulk-apply-tags")?.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const ids = Array.from(indexState.selectedPaperIds)
        if (ids.length === 0) return
        void openTagEditor(ids, [], event.currentTarget)
    })
    dom.$("#bulk-clear-selection")?.addEventListener("click", clearPaperSelection)

    dom.$("#select-all-papers")?.addEventListener("change", (event) => {
        const checked = event.target.checked
        dom.$all(".paper-row").forEach((row) => {
            const id = parseInt(row.dataset.paperId, 10)
            const cb = row.querySelector(".paper-checkbox")
            if (checked) {
                indexState.selectedPaperIds.add(id)
                row.classList.add("selected")
                if (cb) cb.checked = true
            } else {
                indexState.selectedPaperIds.delete(id)
                row.classList.remove("selected")
                if (cb) cb.checked = false
            }
        })
        updateBulkBar()
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
        if (event.key === "Enter") doHfSearch(searchInput.value.trim(), results)
    })
}

async function doHfSearch(query, resultsContainer) {
    if (!query) {
        resultsContainer.innerHTML = "<p class='empty-state'>Enter a query to search.</p>"
        return
    }
    resultsContainer.innerHTML = "<p class='loading'>Searching Hugging Face papers…</p>"
    try {
        const items = await api.hfSearch(query)
        if (items.error) throw new Error(items.error)
        if (!Array.isArray(items) || items.length === 0) {
            resultsContainer.innerHTML = "<p class='empty-state'>No papers found.</p>"
            return
        }
        resultsContainer.innerHTML = ""
        items.forEach((item) => {
            const card = document.createElement("article")
            card.className = "hf-result"
            const title = document.createElement("div")
            title.className = "hf-result-title"
            title.textContent = item.title
            const author = document.createElement("div")
            author.className = "hf-result-author"
            author.textContent = item.author || "Unknown author"
            const desc = document.createElement("div")
            desc.className = "hf-result-desc"
            desc.textContent = item.description || "No description."
            const meta = document.createElement("div")
            meta.className = "hf-result-meta"
            meta.textContent = `arXiv ID: ${item.arxiv_id || "None"}`

            card.appendChild(title)
            card.appendChild(author)
            card.appendChild(desc)
            card.appendChild(meta)

            const importButton = document.createElement("button")
            importButton.type = "button"
            importButton.className = "primary-button btn-with-icon"
            const markImported = () => {
                item.already_imported = true
                card.classList.add("hf-result--imported")
                if (!card.querySelector(".hf-imported-badge")) {
                    const badge = document.createElement("div")
                    badge.className = "hf-imported-badge btn-with-icon"
                    badge.appendChild(icon("check_circle", "btn-icon"))
                    const badgeText = document.createElement("span")
                    badgeText.textContent = "Already in library"
                    badge.appendChild(badgeText)
                    card.insertBefore(badge, importButton)
                }
                importButton.disabled = true
                setButtonLabel(importButton, "check_circle", "Imported")
            }

            importButton.addEventListener("click", async () => {
                if (!item.arxiv_id || item.already_imported) return
                importButton.disabled = true
                setButtonLabel(importButton, "hourglass_empty", "Importing…")
                try {
                    await api.hfImport(item.arxiv_id)
                    markImported()
                    showStatus("Imported paper from Hugging Face.", "success")
                    loadLibrary(dom.$("#search-input").value.trim())
                } catch (err) {
                    showStatus(err.message || "Import failed.", "error")
                    importButton.disabled = false
                    setButtonLabel(importButton, "download", "Import")
                }
            })
            card.appendChild(importButton)

            if (item.already_imported) {
                markImported()
            } else {
                setButtonLabel(importButton, "download", "Import")
                importButton.disabled = !item.arxiv_id
            }
            resultsContainer.appendChild(card)
        })
    } catch (error) {
        resultsContainer.innerHTML = `<p class='empty-state'>${escapeHtml(error.message || "Search failed.")}</p>`
    }
}

async function initIndexPage() {
    document.addEventListener("click", (event) => {
        const popover = dom.$("#tag-editor-popover")
        if (!popover || popover.classList.contains("hidden")) return
        if (
            popover.contains(event.target) ||
            event.target.closest(".edit-tags-button") ||
            event.target.closest("#bulk-apply-tags")
        ) {
            return
        }
        closeTagEditor()
    })

    activateGlobalDrop()
    addKeyboardSearchShortcut()
    activateSearchFilterPanel()
    activateBulkActions()
    activateHfModal()

    dom.$("#search-input").addEventListener("input", (event) => {
        clearPaperSelection()
        loadLibrary(event.target.value.trim())
    })

    dom.$("#clear-filter").addEventListener("click", () => {
        dom.$("#search-input").value = ""
        dom.$("#filter-source-arxiv").checked = false
        dom.$("#filter-source-hf").checked = false
        indexState.sourceFilter = null
        indexState.currentTagFilter = null
        clearPaperSelection()
        loadLibrary()
    })

    loadLibrary()
}

/** Plan-09: render one or more normalized rects as highlight overlays. */
function createHighlightFragments(highlight, options = {}) {
    const wrapper = document.createElement("div")
    wrapper.className = "highlight-fragment-group"
    wrapper.dataset.highlightId = highlight.id

    const rects = getHighlightRects(highlight)
    rects.forEach((rect) => {
        const div = document.createElement("div")
        div.className = "highlight-overlay"
        div.style.left = `${rect.x * 100}%`
        div.style.top = `${rect.y * 100}%`
        div.style.width = `${rect.width * 100}%`
        div.style.height = `${rect.height * 100}%`
        div.style.backgroundColor = highlight.color
        wrapper.appendChild(div)
    })

    if (options.onClickDelete) {
        wrapper.title = "Click to delete this highlight"
        wrapper.addEventListener("click", () => options.onClickDelete(highlight))
    }
    return wrapper
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
    const colorPicker = dom.$("#highlight-color-picker")
    const manageToggle = dom.$("#toggle-highlight-manage")
    const listPanel = dom.$("#highlight-list-panel")
    const listEl = dom.$("#highlight-list")

    let pdfDoc = null
    let currentPage = 1
    const pageScale = 1.25
    let selectedBox = null
    let selectedHighlightColor = HIGHLIGHT_COLORS[0].value
    let manageHighlightsMode = false
    let allHighlights = []
    /** Cancelled when the user changes page (plan-08). */
    let activeTextLayerTask = null
    /** PDF.js text divs / items for the current page (plan-09). */
    let pageTextDivs = []
    let pageTextContentItemsStr = []
    let pageTextItems = []
    let isPageRendering = false
    let viewerHasRenderedPage = false

    const showViewerLoader = (message = "Loading PDF…") => {
        loader.textContent = message
        loader.classList.remove("hidden")
    }

    const hideViewerLoader = () => {
        loader.classList.add("hidden")
    }

    if (typeof pdfjsLib === "undefined") {
        loader.textContent =
            "PDF.js could not load (script missing or blocked). Check your network or try refreshing."
        return
    }

    // Worker must match the same pdfjs-dist version as pdf.min.js above.
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`
    const documentUrl = `/api/pdf/${window.PAPER_ID}`

    HIGHLIGHT_COLORS.forEach((entry, index) => {
        const swatch = document.createElement("button")
        swatch.type = "button"
        swatch.className = "highlight-swatch" + (index === 0 ? " active" : "")
        swatch.style.backgroundColor = entry.value.replace(/[\d.]+\)$/, "1)")
        swatch.title = entry.label
        swatch.addEventListener("click", () => {
            selectedHighlightColor = entry.value
            dom.$all(".highlight-swatch").forEach((el) => el.classList.remove("active"))
            swatch.classList.add("active")
            if (selectedBox) selectedBox.color = selectedHighlightColor
        })
        colorPicker.appendChild(swatch)
    })

    const renderHighlightList = () => {
        listEl.innerHTML = ""
        const onPage = allHighlights.filter((h) => h.page_number === currentPage)
        if (onPage.length === 0) {
            listEl.innerHTML = "<li class='empty-state'>No highlights on this page.</li>"
            return
        }
        onPage.forEach((highlight) => {
            const li = document.createElement("li")
            li.className = "highlight-list-item"
            const snippet = document.createElement("span")
            snippet.className = "snippet"
            snippet.textContent = highlight.selected_text || "(no text captured)"
            const del = document.createElement("button")
            del.type = "button"
            del.className = "secondary-button highlight-delete-btn btn-with-icon"
            setButtonLabel(del, "delete", "Delete")
            del.addEventListener("click", () => deleteHighlightById(highlight.id))
            li.appendChild(snippet)
            li.appendChild(del)
            listEl.appendChild(li)
        })
    }

    const deleteHighlightById = async (highlightId) => {
        try {
            await api.deleteHighlight(highlightId)
            showStatus("Highlight removed.", "success")
            await loadHighlights()
            renderHighlightList()
        } catch (error) {
            showStatus(error.message || "Could not delete highlight.", "error")
        }
    }

    const loadHighlights = async () => {
        highlightLayer.innerHTML = ""
        allHighlights = await api.getHighlights(window.PAPER_ID)
        allHighlights.forEach((highlight) => {
            if (highlight.page_number !== currentPage) return
            highlightLayer.appendChild(
                createHighlightFragments(highlight, {
                    onClickDelete: manageHighlightsMode ? () => deleteHighlightById(highlight.id) : null,
                }),
            )
        })
        if (!listPanel.classList.contains("hidden")) renderHighlightList()
    }

    const syncLayerDimensions = (viewport) => {
        const cssWidth = `${viewport.width}px`
        const cssHeight = `${viewport.height}px`
        pdfContainer.style.width = cssWidth
        pdfContainer.style.height = cssHeight
        textLayer.style.width = cssWidth
        textLayer.style.height = cssHeight
        highlightLayer.style.width = cssWidth
        highlightLayer.style.height = cssHeight
    }

    const renderPage = async (pageNumber) => {
        window.getSelection()?.removeAllRanges()
        selectedBox = null
        isPageRendering = true
        showViewerLoader(viewerHasRenderedPage ? "Loading page…" : "Loading PDF…")

        if (activeTextLayerTask?.cancel) {
            activeTextLayerTask.cancel()
            activeTextLayerTask = null
        }

        pageTextDivs = []
        pageTextContentItemsStr = []
        pageTextItems = []

        try {
            const page = await pdfDoc.getPage(pageNumber)
            const viewport = page.getViewport({ scale: pageScale })
            const outputRatio = getOutputRatio()
            const context = canvas.getContext("2d")

            // HiDPI canvas backing store; CSS size stays in viewport pixels (plan-09).
            canvas.width = Math.floor(viewport.width * outputRatio)
            canvas.height = Math.floor(viewport.height * outputRatio)
            canvas.style.width = `${viewport.width}px`
            canvas.style.height = `${viewport.height}px`

            const renderTransform =
                outputRatio !== 1 ? [outputRatio, 0, 0, outputRatio, 0, 0] : null

            await page.render({
                canvasContext: context,
                viewport,
                transform: renderTransform,
            }).promise

            syncLayerDimensions(viewport)

            textLayer.innerHTML = ""
            textLayer.className = "textLayer"
            textLayer.style.setProperty("--scale-factor", String(viewport.scale))

            const textContent = await page.getTextContent()
            pageTextItems = textContent.items || []

            if (typeof pdfjsLib.renderTextLayer !== "function") {
                showViewerLoader("PDF.js text layer API is unavailable.")
                return
            }

            pageTextDivs = []
            pageTextContentItemsStr = []
            activeTextLayerTask = pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayer,
                viewport,
                textDivs: pageTextDivs,
                textContentItemsStr: pageTextContentItemsStr,
            })
            await activeTextLayerTask.promise

            setPageInfo(pageInfo, pageNumber, pdfDoc.numPages)
            hideViewerLoader()
            viewerHasRenderedPage = true
            await loadHighlights()
        } finally {
            isPageRendering = false
        }
    }

    const captureSelection = () => {
        if (isPageRendering || !selectionAnchoredIn(textLayer)) {
            selectedBox = null
            return
        }

        const selection = window.getSelection()
        const range = selection.getRangeAt(0)
        const rects = captureNormalizedRects(range, textLayer)
        const bounds = unionNormalizedRects(rects)
        const text = extractSelectedText(
            range,
            pageTextDivs,
            pageTextContentItemsStr,
            pageTextItems,
        )

        if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !text || !rects.length) {
            selectedBox = null
            return
        }

        selectedBox = {
            ...bounds,
            rects,
            selected_text: text,
            page_number: currentPage,
            color: selectedHighlightColor,
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
            renderHighlightList()
            window.getSelection().removeAllRanges()
            selectedBox = null
        } catch (error) {
            showStatus(error.message || "Could not save highlight.", "error")
        }
    })

    manageToggle.addEventListener("click", () => {
        manageHighlightsMode = !manageHighlightsMode
        highlightLayer.classList.toggle("manage-mode", manageHighlightsMode)
        listPanel.classList.toggle("hidden", !manageHighlightsMode)
        setButtonLabel(
            manageToggle,
            manageHighlightsMode ? "done" : "checklist",
            manageHighlightsMode ? "Done managing" : "Manage highlights"
        )
        loadHighlights()
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

    // Keep selectedBox in sync when the user clicks Save without another mouseup (plan-08).
    let selectionChangeTimer = null
    document.addEventListener("selectionchange", () => {
        if (isPageRendering) return
        clearTimeout(selectionChangeTimer)
        selectionChangeTimer = setTimeout(captureSelection, 40)
    })

    try {
        pdfDoc = await pdfjsLib.getDocument(documentUrl).promise
        await renderPage(currentPage)
    } catch (error) {
        showViewerLoader("Could not load this PDF.")
    }
}

window.addEventListener("DOMContentLoaded", () => {
    if (dom.$("#drop-zone")) initIndexPage()
    if (dom.$("#pdf-canvas")) initViewerPage()
})
