// ── DOM refs ──
const chatArea = document.getElementById("chat-area");
const topicInput = document.getElementById("topic-input");
const submitBtn = document.getElementById("submit-btn");
const agentsBar = document.getElementById("agents-bar");
const fileUpload = document.getElementById("file-upload");
const fileStatus = document.getElementById("file-status");
const downloadBtn = document.getElementById("download-btn");
const saveFormat = document.getElementById("save-format");
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
const btnNewChat = document.getElementById("btn-new-chat");

// Settings refs
const settingsToggle = document.getElementById("settings-toggle");
const settingsBody = document.getElementById("settings-body");
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");
const apiKeyProvider = document.getElementById("api-key-provider");
const apiKeyBrave = document.getElementById("api-key-brave");
const settingsSave = document.getElementById("settings-save");
const settingsClear = document.getElementById("settings-clear");
const settingsNotice = document.getElementById("settings-notice");

// Usage refs
const usageBar = document.getElementById("usage-bar");
const usageText = document.getElementById("usage-text");
const usageCost = document.getElementById("usage-cost");

// ── State ──
let ws = null;
let currentMessageEl = null;
let allAgents = [];           // from /api/agents
let allProviders = [];        // from /api/providers
let selectedAgents = new Set();
let fileSessionId = "";       // from file upload (separate from persistent session)
let lastExport = null;
let priorDiscussion = null;
let isReady = false;          // backend ready for next command
let autoRunning = false;      // auto-play mode
let sessionActive = false;    // WebSocket session is live
let queue = [];               // [{key, name, avatar, color}]
let currentRound = 1;
let currentTopic = "";
let localMessages = [];

// Persistent session
let persistentSessionId = localStorage.getItem("thinktank_session_id") || "";

// Usage tracking
let totalInputTokens = 0;
let totalOutputTokens = 0;

// Wake Lock
let wakeLock = null;

// Heartbeat
let heartbeatInterval = null;

// Drag state
let dragSrcIndex = null;

// ── Pricing table (per million tokens) ──
const PRICING = {
    "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
    "claude-haiku-4-5-20251001": { input: 0.80, output: 4 },
    "gpt-4o": { input: 2.50, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.60 },
    "o3-mini": { input: 1.10, output: 4.40 },
    "deepseek-chat": { input: 0.27, output: 1.10 },
    "deepseek-reasoner": { input: 0.55, output: 2.19 },
    "gemini-2.0-flash": { input: 0.10, output: 0.40 },
    "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10 },
    "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
};

function getSelectedModel() {
    return modelSelect.value || "claude-sonnet-4-5-20250929";
}

function calculateCost(inputTokens, outputTokens) {
    const model = getSelectedModel();
    const price = PRICING[model] || { input: 3, output: 15 };
    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

function formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return n.toString();
}

function updateUsageDisplay() {
    if (totalInputTokens === 0 && totalOutputTokens === 0) {
        usageBar.style.display = "none";
        return;
    }
    usageBar.style.display = "flex";
    usageText.textContent = `Tokens: ${formatTokens(totalInputTokens)} in / ${formatTokens(totalOutputTokens)} out`;
    const cost = calculateCost(totalInputTokens, totalOutputTokens);
    usageCost.textContent = `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

// ── Providers ──

async function loadProviders() {
    try {
        const res = await fetch("/api/providers");
        allProviders = await res.json();
        populateProviderSelect();
        loadSavedSettings();
    } catch (e) {
        console.error("Failed to load providers:", e);
    }
}

function populateProviderSelect() {
    providerSelect.innerHTML = "";
    allProviders.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.key;
        opt.textContent = p.name;
        providerSelect.appendChild(opt);
    });
    populateModelSelect();
}

function populateModelSelect() {
    const providerKey = providerSelect.value;
    const provider = allProviders.find((p) => p.key === providerKey);
    modelSelect.innerHTML = "";
    if (!provider) return;
    provider.models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
    });
    // Update placeholder hint for API key
    const prefix = provider.key_prefix || "";
    apiKeyProvider.placeholder = prefix ? `${prefix}...` : "API key...";
    // Load saved key for this provider
    const savedKey = localStorage.getItem(`thinktank_api_key_${providerKey}`) || "";
    apiKeyProvider.value = savedKey;
}

providerSelect.addEventListener("change", () => {
    populateModelSelect();
    // Restore saved model for this provider
    const savedModel = localStorage.getItem(`thinktank_model_${providerSelect.value}`);
    if (savedModel) {
        modelSelect.value = savedModel;
    }
});

modelSelect.addEventListener("change", () => {
    localStorage.setItem(`thinktank_model_${providerSelect.value}`, modelSelect.value);
});

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

        el.addEventListener("dragstart", onDragStart);
        el.addEventListener("dragover", onDragOver);
        el.addEventListener("drop", onDrop);
        el.addEventListener("dragend", onDragEnd);

        queueList.appendChild(el);
    });

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

// ── Wake Lock ──

async function acquireWakeLock() {
    try {
        if ("wakeLock" in navigator) {
            wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener("release", () => { wakeLock = null; });
        }
    } catch (e) {
        // Wake Lock not supported or denied — non-critical
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// Re-acquire wake lock when tab becomes visible again
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && sessionActive) {
        acquireWakeLock();
    }
});

// ── Heartbeat ──

function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        sendCmd({ action: "ping" });
    }, 20000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ── Persistent Session Helpers ──

function saveSessionMessages() {
    if (persistentSessionId && localMessages.length) {
        try {
            localStorage.setItem(
                `thinktank_messages_${persistentSessionId}`,
                JSON.stringify(localMessages)
            );
        } catch (e) {
            // localStorage full — non-critical
        }
    }
}

function loadSessionMessages(sessionId) {
    try {
        const raw = localStorage.getItem(`thinktank_messages_${sessionId}`);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function clearPersistedSession() {
    if (persistentSessionId) {
        localStorage.removeItem(`thinktank_messages_${persistentSessionId}`);
    }
    localStorage.removeItem("thinktank_session_id");
    persistentSessionId = "";
}

async function checkExistingSession() {
    if (!persistentSessionId) return;
    try {
        const res = await fetch(`/api/sessions/${persistentSessionId}`);
        const session = await res.json();
        if (session.error) {
            clearPersistedSession();
            return;
        }
        showResumeBanner(session);
    } catch (e) {
        clearPersistedSession();
    }
}

function showResumeBanner(session) {
    // Remove existing banner if any
    const existing = document.getElementById("resume-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "resume-banner";
    banner.className = "resume-banner";

    const topicPreview = session.topic.length > 60
        ? session.topic.substring(0, 60) + "..."
        : session.topic;

    banner.innerHTML = `
        <span class="resume-text">Resume: "${escapeHtml(topicPreview)}"? (Round ${session.current_round})</span>
        <div class="resume-actions">
            <button class="resume-btn" id="btn-resume">Resume</button>
            <button class="newchat-btn" id="btn-resume-new">New Chat</button>
        </div>
    `;

    chatArea.parentNode.insertBefore(banner, chatArea);

    document.getElementById("btn-resume").addEventListener("click", () => {
        banner.remove();
        resumeSession(session);
    });

    document.getElementById("btn-resume-new").addEventListener("click", () => {
        banner.remove();
        newChat();
    });
}

function resumeSession(session) {
    // Restore topic and agents
    currentTopic = session.topic;
    topicInput.value = "";

    if (session.agent_keys && session.agent_keys.length) {
        selectedAgents = new Set(session.agent_keys);
        renderAgentChips();
    }

    // Restore local messages from localStorage
    const savedMessages = loadSessionMessages(persistentSessionId);
    if (savedMessages.length) {
        localMessages = savedMessages;
        chatArea.innerHTML = "";
        addDivider(`Resumed: "${session.topic}"`);
        let curRound = 0;
        for (const msg of savedMessages) {
            if (msg.round_num !== curRound) {
                curRound = msg.round_num;
                addDivider(`Round ${curRound}`);
            }
            if (msg.agent_name === "user") {
                addUserMessageToChat(msg.content);
            } else {
                const ag = allAgents.find((a) => a.name === msg.agent_name);
                const el = addAgentMessage(msg.agent_name, ag ? ag.color : "#888", ag ? ag.avatar : "?");
                el.querySelector(".message-content").innerHTML = renderMarkdown(msg.content);
            }
        }
        scrollToBottom();
    } else {
        chatArea.innerHTML = "";
        addDivider(`Resumed: "${session.topic}"`);
    }

    currentRound = session.current_round || 1;

    // Start WS with existing session_id to resume server-side
    startSession(true);
}

function newChat() {
    // End current WS if active
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendCmd({ action: "end" });
    }
    if (ws) {
        ws.close();
        ws = null;
    }

    // Clear persistent session
    clearPersistedSession();

    // Reset all state
    sessionActive = false;
    autoRunning = false;
    isReady = false;
    currentMessageEl = null;
    lastExport = null;
    priorDiscussion = null;
    localMessages = [];
    currentTopic = "";
    currentRound = 1;
    fileSessionId = "";
    totalInputTokens = 0;
    totalOutputTokens = 0;

    // Reset UI
    chatArea.innerHTML = `
        <div class="welcome-message">
            <p>Select agents above, enter a topic, and control the discussion with the queue panel.</p>
            <p class="welcome-sub">Click agents to toggle. Drag queue items to reorder. Interject anytime.</p>
        </div>`;
    resetInputMode();
    updateUsageDisplay();
    fileStatus.textContent = "";
    downloadBtn.disabled = true;
    stopHeartbeat();
    releaseWakeLock();

    // Remove resume banner if present
    const banner = document.getElementById("resume-banner");
    if (banner) banner.remove();

    // Re-select all agents
    selectedAgents = new Set(allAgents.map((a) => a.key));
    renderAgentChips();
    buildQueueFromSelection();
    updateControls();
}

// ── WebSocket Session ──

function startSession(isResume = false) {
    const topic = isResume ? currentTopic : topicInput.value.trim();
    if (!topic) return;
    if (sessionActive) return;

    const keys = getApiKeys();
    if (!keys.api_key) {
        showError("Please add your API key in the settings panel above before starting.");
        return;
    }

    if (!isResume && !priorDiscussion) {
        chatArea.innerHTML = "";
    }

    if (!isResume) {
        // Reset usage for new session
        totalInputTokens = 0;
        totalOutputTokens = 0;
        updateUsageDisplay();

        buildQueueFromSelection();
        currentRound = 1;
        queueRound.textContent = "Round 1";

        currentTopic = topic;
        addDivider(`Topic: "${topic}"`);
    } else {
        buildQueueFromSelection();
        queueRound.textContent = `Round ${currentRound}`;
    }

    submitBtn.disabled = false;
    topicInput.disabled = false;
    topicInput.value = "";
    topicInput.style.height = "auto";
    topicInput.placeholder = "Type your message to interject...";
    submitBtn.textContent = "Send";
    downloadBtn.disabled = false;
    queuePanel.classList.add("active");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/discuss`);

    ws.onopen = () => {
        const payload = {
            topic,
            agents: Array.from(selectedAgents),
            file_session_id: fileSessionId,
            api_keys: keys,
        };
        // For resume, send persistent session_id so backend loads state from DB
        if (isResume && persistentSessionId) {
            payload.session_id = persistentSessionId;
        }
        if (priorDiscussion) {
            payload.prior_discussion = priorDiscussion;
            priorDiscussion = null;
        }
        ws.send(JSON.stringify(payload));
        sessionActive = true;
        acquireWakeLock();
        startHeartbeat();
    };

    ws.onmessage = (event) => handleMessage(JSON.parse(event.data));

    ws.onclose = () => {
        clearAllSpeaking();
        sessionActive = false;
        autoRunning = false;
        isReady = false;
        ws = null;
        stopHeartbeat();
        releaseWakeLock();

        // If we have a persistent session, show reconnect state instead of full reset
        if (persistentSessionId) {
            topicInput.disabled = false;
            submitBtn.disabled = false;
            topicInput.placeholder = "Session disconnected — click Reconnect or New Chat";
            submitBtn.textContent = "Reconnect";
            queuePanel.classList.remove("active");
        } else {
            resetInputMode();
        }
    };

    ws.onerror = () => {
        showError("Connection error. Please try again.");
        sessionActive = false;
        ws = null;
        stopHeartbeat();
        releaseWakeLock();
        if (persistentSessionId) {
            submitBtn.textContent = "Reconnect";
        } else {
            resetInputMode();
        }
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
        case "pong":
            // Heartbeat acknowledged — connection is alive
            break;

        case "session_created":
            // Save persistent session_id
            persistentSessionId = data.session_id;
            localStorage.setItem("thinktank_session_id", persistentSessionId);
            break;

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
            // Update usage
            if (data.usage) {
                totalInputTokens += data.usage.input_tokens || 0;
                totalOutputTokens += data.usage.output_tokens || 0;
                updateUsageDisplay();
            }
            // Persist messages to localStorage
            saveSessionMessages();
            break;

        case "user_message":
            addUserMessageToChat(data.content);
            localMessages.push({
                agent_name: "user",
                content: data.content,
                round_num: data.round || currentRound,
                timestamp: new Date().toISOString(),
            });
            saveSessionMessages();
            break;

        case "discussion_end":
            clearAllSpeaking();
            lastExport = data.export || null;
            if (lastExport) {
                localMessages = lastExport.messages || localMessages;
            }
            sessionActive = false;
            autoRunning = false;
            isReady = false;
            queuePanel.classList.remove("active");
            stopHeartbeat();
            releaseWakeLock();
            clearPersistedSession();
            resetInputMode();
            break;

        case "export_data":
            lastExport = data.export || null;
            if (lastExport) {
                localMessages = lastExport.messages || localMessages;
            }
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

// ── New Chat ──

btnNewChat.addEventListener("click", () => {
    newChat();
});

// ── User Interjection ──

function sendUserMessage() {
    const msg = topicInput.value.trim();
    if (!msg || !sessionActive) return;
    if (isReady) {
        isReady = false;
        updateControls();
    }
    sendCmd({ action: "user_message", message: msg });
    topicInput.value = "";
    topicInput.style.height = "auto";
}

// ── Input Mode ──

function resetInputMode() {
    topicInput.disabled = false;
    submitBtn.disabled = false;
    topicInput.placeholder = "Enter a topic for discussion...";
    submitBtn.textContent = "Start";
    queuePanel.classList.remove("active");
    currentTopic = "";
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
        fileSessionId = data.file_session_id;
        fileStatus.textContent = `${data.filenames.length} file(s) attached`;
    } catch (e) {
        fileStatus.textContent = "Upload failed";
    }
});

// ── Save / Load ──

downloadBtn.addEventListener("click", () => {
    const format = saveFormat?.value || "html";
    if (sessionActive) {
        sendCmd({ action: "get_export" });
        const handler = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "export_data") {
                ws.removeEventListener("message", handler);
                lastExport = data.export || null;
                const snapshot = getSnapshotExport();
                if (format === "json") {
                    doDownloadJson(snapshot);
                } else {
                    doDownloadHtml(snapshot);
                }
            }
        };
        ws.addEventListener("message", handler);
        return;
    }
    const snapshot = getSnapshotExport();
    if (format === "json") {
        doDownloadJson(snapshot);
    } else {
        doDownloadHtml(snapshot);
    }
});

function doDownloadJson(exportData) {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thinktank_${exportData.topic.replace(/[^a-z0-9]/gi, "_").slice(0, 40)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function getSnapshotExport() {
    const base = lastExport || {
        topic: currentTopic || "Untitled",
        total_rounds: currentRound,
        agent_keys: Array.from(selectedAgents),
        file_context: "",
        messages: [],
    };

    return {
        ...base,
        topic: currentTopic || base.topic,
        agent_keys: base.agent_keys?.length ? base.agent_keys : Array.from(selectedAgents),
        messages: localMessages.length ? localMessages : base.messages,
    };
}

const EXPORT_CSS = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e0e0e0; padding: 1.5rem; }
    h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
    .subtitle { color: #888; margin-bottom: 1rem; font-size: 0.85rem; }
    .chat-area { display: flex; flex-direction: column; gap: 0.6rem; }
    .round-divider { text-align: center; color: #555; font-size: 0.75rem; padding: 0.5rem 0; text-transform: uppercase; letter-spacing: 0.1em; }
    .message { display: flex; gap: 0.6rem; padding: 0.6rem; border-radius: 10px; background: #1a1d27; border-left: 3px solid var(--agent-color, #4A90D9); }
    .message.user-message { background: #1b2333; border-left-color: #6cb4ee; }
    .message-avatar { font-size: 1.3rem; flex-shrink: 0; width: 1.8rem; text-align: center; }
    .message-body { flex: 1; min-width: 0; }
    .message-name { font-weight: 600; font-size: 0.8rem; margin-bottom: 0.2rem; color: var(--agent-color, #4A90D9); }
    .message-content { font-size: 0.9rem; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; }
    .msg-image { display: block; max-width: 100%; max-height: 350px; border-radius: 8px; margin: 0.5rem 0; border: 1px solid #333; object-fit: contain; }
    .msg-link { color: #6cb4ee; text-decoration: none; word-break: break-all; }
    .msg-link:hover { text-decoration: underline; }
`;

function buildExportHtml() {
    return buildExportHtmlWithData(lastExport);
}

function buildExportHtmlWithData(exportData) {
    const clone = chatArea.cloneNode(true);
    clone.querySelectorAll(".cursor").forEach((el) => el.remove());
    const title = escapeHtml(
        exportData?.topic || currentTopic || topicInput.value.trim() || "AI Think Tank Discussion"
    );
    const payload = exportData ? JSON.stringify(exportData).replace(/</g, "\\u003c") : "";
    const payloadBlock = payload
        ? `<script id="thinktank-export" type="application/json">${payload}</script>`
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="subtitle">Saved from AI Think Tank</div>
  <div class="chat-area">${clone.innerHTML}</div>
  ${payloadBlock}
</body>
</html>`;
}

function doDownloadHtml(exportData) {
    const html = buildExportHtmlWithData(exportData);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const baseName = (exportData?.topic || currentTopic || "thinktank_discussion")
        .replace(/[^a-z0-9]/gi, "_")
        .slice(0, 40);
    a.href = url;
    a.download = `thinktank_${baseName}.html`;
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
            const text = e.target.result;
            if (file.name.toLowerCase().endsWith(".html")) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "text/html");
                const payloadEl = doc.getElementById("thinktank-export");
                if (!payloadEl) { alert("No embedded discussion data found."); return; }
                const data = JSON.parse(payloadEl.textContent);
                loadExportData(data);
            } else {
                const data = JSON.parse(text);
                loadExportData(data);
            }
        } catch (err) { alert("Failed to parse file."); }
    };
    reader.readAsText(file);
    loadInput.value = "";
});

function loadExportData(data) {
    if (!data.topic || !data.messages) { alert("Invalid file."); return; }
    priorDiscussion = data;
    lastExport = data;
    localMessages = data.messages || [];
    topicInput.value = data.topic;
    currentTopic = data.topic;
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
    downloadBtn.disabled = false;
}

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
    const content = currentMessageEl.querySelector(".message-content");
    content.innerHTML = renderMarkdown(content.textContent);
    const agentName = currentMessageEl.querySelector(".message-name")?.textContent || "";
    localMessages.push({
        agent_name: agentName,
        content: content.textContent,
        round_num: currentRound,
        timestamp: new Date().toISOString(),
    });
    currentMessageEl = null;
}

function renderMarkdown(text) {
    let html = escapeHtml(text);
    const proxy = (url) => {
        const cleaned = url.replace(/^https?:\/\//i, "");
        return `https://images.weserv.nl/?url=${encodeURIComponent(cleaned)}`;
    };
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
        '<img src="' + proxy("$2") + '" data-original="$2" alt="$1" class="msg-image" loading="lazy" crossorigin="anonymous" onerror="if(this.dataset.original){this.src=this.dataset.original;this.removeAttribute(\'data-original\');}else{this.outerHTML=\'<a href=&quot;\'+this.src+\'&quot; target=&quot;_blank&quot; class=&quot;msg-link&quot;>[Image: \'+this.alt+\']</a>\';}">');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
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
    if (sessionActive) {
        sendUserMessage();
    } else if (submitBtn.textContent === "Reconnect" && persistentSessionId) {
        // Reconnect to existing session
        submitBtn.textContent = "Connecting...";
        submitBtn.disabled = true;
        checkExistingSession().then(() => {
            // If no banner was shown (session ended), just reset
            if (!document.getElementById("resume-banner")) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Start";
            }
        });
    } else {
        startSession();
    }
});

topicInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (sessionActive) {
            sendUserMessage();
        } else if (!sessionActive && !submitBtn.disabled) {
            if (submitBtn.textContent === "Reconnect" && persistentSessionId) {
                submitBtn.click();
            } else {
                startSession();
            }
        }
    }
});

// Auto-resize textarea as user types
topicInput.addEventListener("input", () => {
    topicInput.style.height = "auto";
    topicInput.style.height = Math.min(topicInput.scrollHeight, 150) + "px";
});

// ── Settings / API Keys ──

const STORAGE_KEY_BRAVE = "thinktank_api_key_brave";
const STORAGE_KEY_PROVIDER = "thinktank_provider";

function loadSavedSettings() {
    // Restore provider selection
    const savedProvider = localStorage.getItem(STORAGE_KEY_PROVIDER);
    if (savedProvider && allProviders.some((p) => p.key === savedProvider)) {
        providerSelect.value = savedProvider;
    }
    populateModelSelect();

    // Restore model selection
    const savedModel = localStorage.getItem(`thinktank_model_${providerSelect.value}`);
    if (savedModel) {
        modelSelect.value = savedModel;
    }

    // Restore Brave key
    const savedBrave = localStorage.getItem(STORAGE_KEY_BRAVE) || "";
    apiKeyBrave.value = savedBrave;

    updateSearchBanner();
}

function saveSettings() {
    const providerKey = providerSelect.value;
    const ak = apiKeyProvider.value.trim();
    const bk = apiKeyBrave.value.trim();

    localStorage.setItem(STORAGE_KEY_PROVIDER, providerKey);
    localStorage.setItem(`thinktank_model_${providerKey}`, modelSelect.value);

    if (ak) localStorage.setItem(`thinktank_api_key_${providerKey}`, ak);
    else localStorage.removeItem(`thinktank_api_key_${providerKey}`);

    if (bk) localStorage.setItem(STORAGE_KEY_BRAVE, bk);
    else localStorage.removeItem(STORAGE_KEY_BRAVE);

    settingsNotice.textContent = "Settings saved to this browser.";
    settingsNotice.className = "settings-notice ok";
    updateSearchBanner();
    setTimeout(() => { settingsNotice.textContent = ""; settingsNotice.className = "settings-notice"; }, 3000);
}

function clearSettings() {
    const providerKey = providerSelect.value;
    localStorage.removeItem(`thinktank_api_key_${providerKey}`);
    localStorage.removeItem(STORAGE_KEY_BRAVE);
    apiKeyProvider.value = "";
    apiKeyBrave.value = "";
    settingsNotice.textContent = "Keys cleared for " + (allProviders.find((p) => p.key === providerKey)?.name || providerKey) + ".";
    settingsNotice.className = "settings-notice warn";
    updateSearchBanner();
    setTimeout(() => { settingsNotice.textContent = ""; settingsNotice.className = "settings-notice"; }, 3000);
}

function getApiKeys() {
    return {
        provider: providerSelect.value,
        model: modelSelect.value,
        api_key: apiKeyProvider.value.trim(),
        brave_api_key: apiKeyBrave.value.trim(),
    };
}

function updateSearchBanner() {
    let banner = document.getElementById("search-disabled-banner");
    const hasBrave = apiKeyBrave.value.trim().length > 0;
    if (!hasBrave) {
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "search-disabled-banner";
            banner.className = "search-disabled-banner";
            banner.textContent = "Online search is disabled — add a Brave Search API key in settings above to enable it.";
            agentsBar.parentNode.insertBefore(banner, agentsBar);
        }
    } else if (banner) {
        banner.remove();
    }
}

settingsToggle.addEventListener("click", () => {
    const open = settingsBody.classList.toggle("open");
    settingsToggle.innerHTML = open ? "&#9881; Settings &#9650;" : "&#9881; Settings &#9660;";
});

settingsSave.addEventListener("click", saveSettings);
settingsClear.addEventListener("click", clearSettings);

// ── Mobile Queue Toggle ──
const queueToggle = document.getElementById("queue-toggle");
queueToggle.addEventListener("click", () => {
    queuePanel.classList.toggle("mobile-open");
    queueToggle.innerHTML = queuePanel.classList.contains("mobile-open")
        ? "Speaker Queue &#9650;"
        : "Speaker Queue &#9660;";
});

// ── Init ──
loadProviders();
loadAgents().then(() => {
    buildQueueFromSelection();
    updateControls();
    // Check for existing session after agents are loaded
    checkExistingSession();
});
