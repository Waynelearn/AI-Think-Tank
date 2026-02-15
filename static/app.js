// ── DOM refs ──
const chatArea = document.getElementById("chat-area");
const topicInput = document.getElementById("topic-input");
const submitBtn = document.getElementById("submit-btn");
const agentsBar = document.getElementById("agents-bar");
const fileUpload = document.getElementById("file-upload");
const fileStatus = document.getElementById("file-status");
const downloadBtn = document.getElementById("download-btn");
const loadBtn = document.getElementById("load-btn");
const loadInput = document.getElementById("load-input");
const queuePanel = document.getElementById("queue-panel");
const queueList = document.getElementById("queue-list");
const queueRound = document.getElementById("queue-round");
const addAgentSelect = document.getElementById("add-agent-select");
const btnPlay = document.getElementById("btn-play");
const btnNext = document.getElementById("btn-next");
const btnNewRound = document.getElementById("btn-new-round");
const btnEnd = document.getElementById("btn-end");
const btnAddAgent = document.getElementById("btn-add-agent");

// ── State ──
let ws = null;
let currentMessageEl = null;
let allAgents = [];           // from /api/agents
let selectedAgents = new Set();
let sessionId = "";
let lastExport = null;
let priorDiscussion = null;
let isReady = false;          // backend ready for next command
let autoRunning = false;      // auto-play mode
let sessionActive = false;    // WebSocket session is live
let queue = [];               // [{key, name, avatar, color}]
let currentRound = 1;

// Drag state
let dragSrcIndex = null;

// ── Agents ──

async function loadAgents() {
    try {
        const res = await fetch("/api/agents");
        allAgents = await res.json();
        selectedAgents = new Set(allAgents.map((a) => a.key));
        renderAgentChips();
        populateAddSelect();
    } catch (e) {
        console.error("Failed to load agents:", e);
    }
}

function renderAgentChips() {
    agentsBar.innerHTML = allAgents
        .map((a) => {
            const sel = selectedAgents.has(a.key);
            return `<div class="agent-chip ${sel ? "selected" : ""}"
                         id="chip-${a.name.replace(/\s+/g, "-")}"
                         data-key="${a.key}"
                         style="border-color: ${sel ? a.color : "#333"}">
                        <span class="agent-avatar">${a.avatar}</span>
                        <span style="color: ${sel ? a.color : "#666"}">${a.name}</span>
                    </div>`;
        })
        .join("");

    document.querySelectorAll(".agent-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            const key = chip.dataset.key;
            if (selectedAgents.has(key)) {
                if (selectedAgents.size <= 1) return;
                selectedAgents.delete(key);
            } else {
                selectedAgents.add(key);
            }
            renderAgentChips();
            // If session isn't active, rebuild queue from selection
            if (!sessionActive) buildQueueFromSelection();
        });
    });
}

function setChipSpeaking(name, on) {
    const chip = document.getElementById("chip-" + name.replace(/\s+/g, "-"));
    if (chip) chip.classList.toggle("speaking", on);
}

function clearAllSpeaking() {
    document.querySelectorAll(".agent-chip.speaking").forEach((el) => el.classList.remove("speaking"));
}

function populateAddSelect() {
    addAgentSelect.innerHTML = '<option value="">+ Add agent...</option>';
    allAgents.forEach((a) => {
        addAgentSelect.innerHTML += `<option value="${a.key}">${a.avatar} ${a.name}</option>`;
    });
}

// ── Queue ──

function buildQueueFromSelection() {
    // Mediator last
    const keys = Array.from(selectedAgents);
    const mediatorKey = keys.find((k) => {
        const a = allAgents.find((x) => x.key === k);
        return a && a.name === "The Mediator";
    });
    const others = keys.filter((k) => k !== mediatorKey);
    const ordered = mediatorKey ? [...others, mediatorKey] : others;

    queue = ordered.map((k) => {
        const a = allAgents.find((x) => x.key === k);
        return { key: a.key, name: a.name, avatar: a.avatar, color: a.color };
    });
    renderQueue();
}

function renderQueue() {
    queueList.innerHTML = "";
    queue.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "queue-item";
        el.draggable = true;
        el.dataset.index = i;
        el.style.setProperty("--q-color", item.color);
        el.innerHTML = `
            <span class="q-handle" title="Drag to reorder">&#9776;</span>
            <span class="q-avatar">${item.avatar}</span>
            <span class="q-name">${item.name}</span>
            <span class="q-arrows">
                <button class="q-arrow" data-dir="up" data-i="${i}" title="Move up">&uarr;</button>
                <button class="q-arrow" data-dir="down" data-i="${i}" title="Move down">&darr;</button>
            </span>
            <button class="q-remove" data-i="${i}" title="Remove from queue">&times;</button>
        `;

        // Drag events
        el.addEventListener("dragstart", onDragStart);
        el.addEventListener("dragover", onDragOver);
        el.addEventListener("drop", onDrop);
        el.addEventListener("dragend", onDragEnd);

        queueList.appendChild(el);
    });

    // Arrow and remove buttons
    queueList.querySelectorAll(".q-arrow").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.i);
            const dir = btn.dataset.dir;
            if (dir === "up" && idx > 0) swapQueue(idx, idx - 1);
            if (dir === "down" && idx < queue.length - 1) swapQueue(idx, idx + 1);
        });
    });
    queueList.querySelectorAll(".q-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            queue.splice(parseInt(btn.dataset.i), 1);
            renderQueue();
        });
    });
}

function swapQueue(a, b) {
    [queue[a], queue[b]] = [queue[b], queue[a]];
    renderQueue();
}

// Drag & drop
function onDragStart(e) {
    dragSrcIndex = parseInt(e.currentTarget.dataset.index);
    e.currentTarget.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
}
function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("drag-over");
}
function onDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove("drag-over");
    const dest = parseInt(e.currentTarget.dataset.index);
    if (dragSrcIndex !== null && dragSrcIndex !== dest) {
        const item = queue.splice(dragSrcIndex, 1)[0];
        queue.splice(dest, 0, item);
        renderQueue();
    }
}
function onDragEnd(e) {
    e.currentTarget.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    dragSrcIndex = null;
}

// ── WebSocket Session ──

function startSession() {
    const topic = topicInput.value.trim();
    if (!topic) return;
    if (sessionActive) return;

    if (!priorDiscussion) {
        chatArea.innerHTML = "";
    }

    buildQueueFromSelection();
    currentRound = 1;
    queueRound.textContent = "Round 1";

    submitBtn.disabled = true;
    topicInput.disabled = true;
    downloadBtn.disabled = true;
    queuePanel.classList.add("active");

    addDivider(`Topic: "${topic}"`);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/discuss`);

    ws.onopen = () => {
        const payload = {
            topic,
            agents: Array.from(selectedAgents),
            session_id: sessionId,
        };
        if (priorDiscussion) {
            payload.prior_discussion = priorDiscussion;
            priorDiscussion = null;
        }
        ws.send(JSON.stringify(payload));
        sessionActive = true;
    };

    ws.onmessage = (event) => handleMessage(JSON.parse(event.data));

    ws.onclose = () => {
        clearAllSpeaking();
        sessionActive = false;
        autoRunning = false;
        isReady = false;
        ws = null;
        resetInputMode();
    };

    ws.onerror = () => {
        showError("Connection error. Please try again.");
        sessionActive = false;
        ws = null;
        resetInputMode();
    };
}

function sendCmd(cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(cmd));
    }
}

// ── Message Handling ──

function handleMessage(data) {
    switch (data.type) {
        case "ready":
            isReady = true;
            currentRound = data.round || currentRound;
            queueRound.textContent = `Round ${currentRound}`;
            updateControls();
            if (autoRunning) autoNext();
            break;

        case "round_start":
            currentRound = data.round;
            queueRound.textContent = `Round ${currentRound}`;
            addDivider(`Round ${data.round}`);
            break;

        case "agent_start":
            isReady = false;
            updateControls();
            currentMessageEl = addAgentMessage(data.agent, data.color, data.avatar);
            setChipSpeaking(data.agent, true);
            // Remove this agent from the front of the queue display
            if (queue.length && queue[0].name === data.agent) {
                queue.shift();
                renderQueue();
            }
            break;

        case "agent_chunk":
            appendChunk(data.chunk);
            break;

        case "agent_done":
            finishMessage();
            setChipSpeaking(data.agent, false);
            break;

        case "user_message":
            addUserMessageToChat(data.content);
            break;

        case "discussion_end":
            clearAllSpeaking();
            lastExport = data.export || null;
            downloadBtn.disabled = !lastExport;
            sessionActive = false;
            autoRunning = false;
            isReady = false;
            queuePanel.classList.remove("active");
            resetInputMode();
            break;

        case "export_data":
            lastExport = data.export || null;
            downloadBtn.disabled = !lastExport;
            break;

        case "error":
            showError(data.message);
            break;
    }
}

// ── Controls ──

function updateControls() {
    const canAct = sessionActive && isReady;
    btnPlay.disabled = !canAct || queue.length === 0;
    btnNext.disabled = !canAct || queue.length === 0;
    btnNewRound.disabled = !canAct;
    btnEnd.disabled = !sessionActive;
    btnAddAgent.disabled = !sessionActive;

    if (autoRunning) {
        btnPlay.textContent = "\u23F8 Pause";
        btnPlay.title = "Pause auto-run";
    } else {
        btnPlay.textContent = "\u25B6 Play All";
        btnPlay.title = "Auto-run all in queue";
    }
}

function autoNext() {
    if (!autoRunning || !isReady || !sessionActive) return;
    if (queue.length === 0) {
        autoRunning = false;
        updateControls();
        return;
    }
    isReady = false;
    updateControls();
    sendCmd({ action: "run_agent", agent_key: queue[0].key });
}

btnPlay.addEventListener("click", () => {
    if (autoRunning) {
        autoRunning = false;
        updateControls();
    } else {
        autoRunning = true;
        updateControls();
        if (isReady) autoNext();
    }
});

btnNext.addEventListener("click", () => {
    if (!isReady || queue.length === 0) return;
    autoRunning = false;
    isReady = false;
    updateControls();
    sendCmd({ action: "run_agent", agent_key: queue[0].key });
});

btnNewRound.addEventListener("click", () => {
    if (!isReady) return;
    isReady = false;
    // Rebuild queue for the new round
    buildQueueFromSelection();
    sendCmd({ action: "new_round" });
});

btnEnd.addEventListener("click", () => {
    autoRunning = false;
    updateControls();
});

document.getElementById("btn-clear").addEventListener("click", () => {
    autoRunning = false;
    queue = [];
    renderQueue();
    updateControls();
});

btnAddAgent.addEventListener("click", () => {
    const key = addAgentSelect.value;
    if (!key) return;
    const a = allAgents.find((x) => x.key === key);
    if (!a) return;
    queue.push({ key: a.key, name: a.name, avatar: a.avatar, color: a.color });
    renderQueue();
    addAgentSelect.value = "";
    updateControls();
});

// ── User Interjection (input box sends user_message during session) ──

function sendUserMessage() {
    const msg = topicInput.value.trim();
    if (!msg || !sessionActive || !isReady) return;
    isReady = false;
    updateControls();
    sendCmd({ action: "user_message", message: msg });
    topicInput.value = "";
}

// ── Input Mode ──

function resetInputMode() {
    topicInput.disabled = false;
    submitBtn.disabled = false;
    topicInput.placeholder = "Enter a topic for discussion...";
    submitBtn.textContent = "Start";
    queuePanel.classList.remove("active");
}

// ── File Upload ──

fileUpload.addEventListener("change", async () => {
    const files = fileUpload.files;
    if (!files.length) return;
    fileStatus.textContent = "Uploading...";
    const formData = new FormData();
    for (const f of files) formData.append("files", f);
    try {
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        const data = await res.json();
        sessionId = data.session_id;
        fileStatus.textContent = `${data.filenames.length} file(s) attached`;
    } catch (e) {
        fileStatus.textContent = "Upload failed";
    }
});

// ── Save / Load ──

downloadBtn.addEventListener("click", () => {
    if (!lastExport) return;
    // If session active, request fresh export first
    if (sessionActive) {
        sendCmd({ action: "get_export" });
        // Download will happen when export_data arrives — set a flag
        const handler = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "export_data") {
                ws.removeEventListener("message", handler);
                doDownload(data.export);
            }
        };
        ws.addEventListener("message", handler);
        return;
    }
    doDownload(lastExport);
});

function doDownload(exportData) {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thinktank_${exportData.topic.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

loadBtn.addEventListener("click", () => loadInput.click());

loadInput.addEventListener("change", () => {
    const file = loadInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.topic || !data.messages) { alert("Invalid file."); return; }
            priorDiscussion = data;
            topicInput.value = data.topic;
            if (data.agent_keys && data.agent_keys.length) {
                selectedAgents = new Set(data.agent_keys);
                renderAgentChips();
            }
            chatArea.innerHTML = "";
            addDivider(`Loaded: "${data.topic}"`);
            let curRound = 0;
            for (const msg of data.messages) {
                if (msg.round_num !== curRound) { curRound = msg.round_num; addDivider(`Round ${curRound}`); }
                if (msg.agent_name === "user") {
                    addUserMessageToChat(msg.content);
                } else {
                    const ag = allAgents.find((a) => a.name === msg.agent_name);
                    const el = addAgentMessage(msg.agent_name, ag ? ag.color : "#888", ag ? ag.avatar : "?");
                    el.querySelector(".message-content").innerHTML = renderMarkdown(msg.content);
                }
            }
            addDivider("Continue the discussion — click Start");
            scrollToBottom();
        } catch (err) { alert("Failed to parse file."); }
    };
    reader.readAsText(file);
    loadInput.value = "";
});

// ── DOM Helpers ──

function scrollToBottom() { chatArea.scrollTop = chatArea.scrollHeight; }

function addDivider(text) {
    const el = document.createElement("div");
    el.className = "round-divider";
    el.textContent = text;
    chatArea.appendChild(el);
    scrollToBottom();
}

function addAgentMessage(name, color, avatar) {
    const el = document.createElement("div");
    el.className = "message";
    el.style.setProperty("--agent-color", color);
    el.innerHTML = `
        <div class="message-avatar">${avatar}</div>
        <div class="message-body">
            <div class="message-name">${name}</div>
            <div class="message-content"><span class="cursor"></span></div>
        </div>`;
    chatArea.appendChild(el);
    scrollToBottom();
    return el;
}

function addUserMessageToChat(content) {
    const el = document.createElement("div");
    el.className = "message user-message";
    el.style.setProperty("--agent-color", "#6cb4ee");
    el.innerHTML = `
        <div class="message-avatar">&#128100;</div>
        <div class="message-body">
            <div class="message-name">You</div>
            <div class="message-content">${escapeHtml(content)}</div>
        </div>`;
    chatArea.appendChild(el);
    scrollToBottom();
}

function appendChunk(chunk) {
    if (!currentMessageEl) return;
    const content = currentMessageEl.querySelector(".message-content");
    const cursor = content.querySelector(".cursor");
    if (cursor) cursor.remove();
    content.textContent += chunk;
    const c = document.createElement("span");
    c.className = "cursor";
    content.appendChild(c);
    scrollToBottom();
}

function finishMessage() {
    if (!currentMessageEl) return;
    const cursor = currentMessageEl.querySelector(".cursor");
    if (cursor) cursor.remove();
    // Render markdown (images, links, bold, italic) in the finished message
    const content = currentMessageEl.querySelector(".message-content");
    content.innerHTML = renderMarkdown(content.textContent);
    currentMessageEl = null;
}

function renderMarkdown(text) {
    // Escape HTML first
    let html = escapeHtml(text);
    // Images: ![alt](url) — on error, replace with a clickable link
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
        '<img src="$2" alt="$1" class="msg-image" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<a href=&quot;\'+this.src+\'&quot; target=&quot;_blank&quot; class=&quot;msg-link&quot;>[Image: \'+this.alt+\']</a>\'">');
    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
    // Bold: **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Bare URLs (not already in a tag)
    html = html.replace(/(?<!="|">)(https?:\/\/[^\s<)"]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
    return html;
}

function showError(msg) {
    const el = document.createElement("div");
    el.className = "error-message";
    el.textContent = msg;
    chatArea.appendChild(el);
    scrollToBottom();
}

function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

// ── Main Event Listeners ──

submitBtn.addEventListener("click", () => {
    if (sessionActive && isReady) {
        sendUserMessage();
    } else if (!sessionActive) {
        startSession();
    }
});

topicInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        if (sessionActive && isReady) {
            sendUserMessage();
        } else if (!sessionActive && !submitBtn.disabled) {
            startSession();
        }
    }
});

// ── Init ──
loadAgents();
buildQueueFromSelection();
updateControls();
