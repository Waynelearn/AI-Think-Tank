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
const btnHistory = document.getElementById("btn-history");
const errorRegion = document.getElementById("error-region");

// Sentiment refs
const sentimentStrip = document.getElementById("sentiment-strip");
const sentimentStripTrack = document.getElementById("sentiment-strip-track");
const sentimentLabelLeft = document.getElementById("sentiment-label-left");
const sentimentLabelRight = document.getElementById("sentiment-label-right");
const sentimentChartContainer = document.getElementById("sentiment-chart-container");
const sentimentCanvas = document.getElementById("sentiment-canvas");
const sentimentLegend = document.getElementById("sentiment-legend");
const sentimentChartClose = document.getElementById("sentiment-chart-close");

// Settings refs
const settingsToggle = document.getElementById("settings-toggle");
const settingsBody = document.getElementById("settings-body");
const settingsArrow = document.getElementById("settings-arrow");
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");
const apiKeyProvider = document.getElementById("api-key-provider");
const apiKeyBrave = document.getElementById("api-key-brave");
const wordLimitInput = document.getElementById("word-limit");
const settingsSave = document.getElementById("settings-save");
const settingsClear = document.getElementById("settings-clear");
const settingsNotice = document.getElementById("settings-notice");

// Theme / font refs
const btnTheme = document.getElementById("btn-theme");
const themeIcon = document.getElementById("theme-icon");
const btnFontDec = document.getElementById("btn-font-dec");
const btnFontInc = document.getElementById("btn-font-inc");

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

// Client identity (per-browser, for session privacy)
function getClientId() {
    let id = localStorage.getItem("thinktank_client_id");
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("thinktank_client_id", id);
    }
    return id;
}
const clientId = getClientId();

// Session limit
const MAX_SESSIONS = 10;

// Usage tracking
let totalInputTokens = 0;
let totalOutputTokens = 0;

// Wake Lock
let wakeLock = null;

// Heartbeat
let heartbeatInterval = null;

// Drag state
let dragSrcIndex = null;

// Agent response timing
let agentStartTime = null;

// Currently speaking agent (null when idle) — for incomplete response detection
let currentSpeakingAgent = null; // {key, name, avatar, color}

// Save debounce timer
let saveDebounceTimer = null;

// Sentiment tracking
let sentimentHistory = [];     // [{round, viewpoints, scores}, ...]
let sentimentChartOpen = false;

// Font size scale (px) — only affects chat content, not UI chrome
const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
const FONT_SIZE_DEFAULT_IDX = 2; // 14px

// ── Theme & Font Size ──

function initTheme() {
    const saved = localStorage.getItem("thinktank_theme");
    const prefer = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    applyTheme(saved || prefer);
}

function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("thinktank_theme", theme);
    if (themeIcon) {
        themeIcon.innerHTML = theme === "light" ? "&#9728;" : "&#9790;";
    }
    if (btnTheme) {
        btnTheme.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
    if (sentimentChartOpen && sentimentHistory.length > 0) {
        renderSentimentChart();
    }
}

function initFontSize() {
    const saved = localStorage.getItem("thinktank_font_size_idx");
    const idx = saved !== null ? parseInt(saved) : FONT_SIZE_DEFAULT_IDX;
    applyFontSize(idx);
}

function applyFontSize(idx) {
    const clamped = Math.max(0, Math.min(FONT_SIZES.length - 1, idx));
    document.documentElement.style.setProperty("--font-size-chat", FONT_SIZES[clamped] + "px");
    localStorage.setItem("thinktank_font_size_idx", clamped);
}

function changeFontSize(delta) {
    const current = parseInt(localStorage.getItem("thinktank_font_size_idx") || FONT_SIZE_DEFAULT_IDX);
    applyFontSize(current + delta);
}

// Initialize theme and font immediately
initTheme();
initFontSize();

if (btnTheme) btnTheme.addEventListener("click", toggleTheme);
if (btnFontDec) btnFontDec.addEventListener("click", () => changeFontSize(-1));
if (btnFontInc) btnFontInc.addEventListener("click", () => changeFontSize(1));

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

// formatTokens() is in utils.js

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
    const prefix = provider.key_prefix || "";
    apiKeyProvider.placeholder = prefix ? `${prefix}...` : "API key...";
    const savedKey = localStorage.getItem(`thinktank_api_key_${providerKey}`) || "";
    apiKeyProvider.value = savedKey;
}

providerSelect.addEventListener("change", () => {
    populateModelSelect();
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
                         role="button"
                         tabindex="0"
                         aria-pressed="${sel}"
                         style="border-color: ${sel ? a.color : "var(--border-muted)"}">
                        <span class="agent-avatar">${a.avatar}</span>
                        <span style="color: ${sel ? a.color : "var(--text-faint)"}">${a.name}</span>
                    </div>`;
        })
        .join("");
}

function updateChip(key) {
    const a = allAgents.find((x) => x.key === key);
    if (!a) return;
    const chip = document.querySelector(`.agent-chip[data-key="${key}"]`);
    if (!chip) return;
    const sel = selectedAgents.has(key);
    chip.classList.toggle("selected", sel);
    chip.setAttribute("aria-pressed", sel);
    chip.style.borderColor = sel ? a.color : "var(--border-muted)";
    const nameSpan = chip.querySelector("span:last-child");
    if (nameSpan) nameSpan.style.color = sel ? a.color : "var(--text-faint)";
}

function toggleAgent(key) {
    if (selectedAgents.has(key)) {
        if (selectedAgents.size <= 1) return;
        selectedAgents.delete(key);
    } else {
        selectedAgents.add(key);
    }
    updateChip(key);
    if (!sessionActive) buildQueueFromSelection();
}

// Event delegation for agent chips
agentsBar.addEventListener("click", (e) => {
    const chip = e.target.closest(".agent-chip");
    if (!chip) return;
    toggleAgent(chip.dataset.key);
});

agentsBar.addEventListener("keydown", (e) => {
    const chip = e.target.closest(".agent-chip");
    if (!chip) return;
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleAgent(chip.dataset.key);
    }
});

function setChipSpeaking(name, on) {
    const chip = document.getElementById("chip-" + name.replace(/\s+/g, "-"));
    if (chip) chip.classList.toggle("speaking", on);
}

function clearAllSpeaking() {
    document.querySelectorAll(".agent-chip.speaking").forEach((el) => el.classList.remove("speaking"));
}

function populateAddSelect() {
    addAgentSelect.innerHTML = '<option value="">+ Add agent...</option>';
    addAgentSelect.innerHTML += '<option value="__user_prompt__">&#128100; Your Prompt</option>';
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
    const judgeKey = keys.find((k) => {
        const a = allAgents.find((x) => x.key === k);
        return a && a.name === "The Judge";
    });
    const others = keys.filter((k) => k !== mediatorKey && k !== judgeKey);

    // Shuffle non-mediator/non-judge agents randomly
    for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
    }

    // Order: shuffled agents → Mediator → Judge (both at the end)
    const ordered = [...others];
    if (mediatorKey) ordered.push(mediatorKey);
    if (judgeKey) ordered.push(judgeKey);

    queue = ordered.map((k) => {
        const a = allAgents.find((x) => x.key === k);
        return { key: a.key, name: a.name, avatar: a.avatar, color: a.color };
    });
    renderQueue();
}

function shuffleQueue() {
    // Separate pinned-to-end agents (Mediator, Judge) from others
    const pinned = [];
    const others = [];
    for (const q of queue) {
        if (q.name === "The Mediator" || q.name === "The Judge") {
            pinned.push(q);
        } else {
            others.push(q);
        }
    }

    // Fisher-Yates shuffle the non-pinned items
    for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
    }

    // Mediator before Judge in pinned
    pinned.sort((a, b) => {
        if (a.name === "The Mediator") return -1;
        if (b.name === "The Mediator") return 1;
        return 0;
    });

    queue = [...others, ...pinned];
    renderQueue();
}

function renderQueue() {
    queueList.innerHTML = "";
    queue.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "queue-item" + (item.type === "user_prompt" ? " queue-item-user" : "");
        el.draggable = true;
        el.dataset.index = i;
        el.style.setProperty("--q-color", item.color);

        const isUserPrompt = item.type === "user_prompt";
        const preview = isUserPrompt
            ? escapeHtml(item.message.length > 25 ? item.message.slice(0, 25) + "..." : item.message)
            : "";

        el.innerHTML = `
            <span class="q-handle" title="Drag to reorder">&#9776;</span>
            <span class="q-avatar">${item.avatar}</span>
            <span class="q-name${isUserPrompt ? " q-name-prompt" : ""}" ${isUserPrompt ? `title="${escapeHtml(item.message)}"` : ""}>${isUserPrompt ? preview : item.name}</span>
            <span class="q-arrows">
                <button class="q-arrow" data-dir="up" data-i="${i}" title="Move up">&uarr;</button>
                <button class="q-arrow" data-dir="down" data-i="${i}" title="Move down">&darr;</button>
            </span>
            ${isUserPrompt ? `<button class="q-edit" data-i="${i}" title="Edit prompt">&#9998;</button>` : ""}
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
    queueList.querySelectorAll(".q-edit").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.i);
            const item = queue[idx];
            if (!item || item.type !== "user_prompt") return;
            const newMsg = prompt("Edit your queued message:", item.message);
            if (newMsg !== null && newMsg.trim()) {
                item.message = newMsg.trim();
                renderQueue();
            }
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
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
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
    }, 1000);
}

function loadSessionMessages(sid) {
    try {
        const raw = localStorage.getItem(`thinktank_messages_${sid}`);
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

// ── Session History ──

async function loadSessionHistory() {
    try {
        const res = await fetch(`/api/sessions?client_id=${encodeURIComponent(clientId)}`);
        const data = await res.json();
        const sessions = data.sessions || [];
        const totalCount = data.count || 0;

        // Remove old history/resume panels
        const oldPanel = document.getElementById("history-panel");
        if (oldPanel) oldPanel.remove();
        const oldBanner = document.getElementById("resume-banner");
        if (oldBanner) oldBanner.remove();

        if (sessions.length === 0) return;

        const panel = document.createElement("div");
        panel.id = "history-panel";
        panel.className = "history-panel";

        let html = `
            <div class="history-title">
                <span>Recent Chats</span>
                <span class="history-count">${totalCount} / ${MAX_SESSIONS}</span>
            </div>`;

        if (totalCount >= MAX_SESSIONS) {
            html += `<div class="history-limit-msg">Session limit reached (${MAX_SESSIONS}). Delete a chat to start a new one.</div>`;
        }

        html += `<div class="history-list">`;
        for (const s of sessions) {
            const topicPreview = s.topic.length > 50
                ? s.topic.substring(0, 50) + "..."
                : s.topic;
            const date = new Date(s.updated_at).toLocaleDateString();
            const isCurrent = s.id === persistentSessionId;
            const borderColor = isCurrent ? "#27AE60" : "#4A90D9";
            html += `
                <div class="history-item" data-sid="${s.id}" style="border-left-color: ${borderColor}">
                    <div class="history-item-body" data-sid="${s.id}" data-action="resume">
                        <div class="history-item-topic">${isCurrent ? "&#9654; " : ""}${escapeHtml(topicPreview)}</div>
                        <div class="history-item-meta">Round ${s.current_round} &middot; ${date}${isCurrent ? " &middot; current" : ""}</div>
                    </div>
                    <button class="history-item-delete" data-sid="${s.id}" data-action="delete" title="Delete this chat">&times;</button>
                </div>`;
        }
        html += `</div>`;
        panel.innerHTML = html;

        // Insert before chat area
        chatArea.parentNode.insertBefore(panel, chatArea);

        // Wire up clicks
        panel.querySelectorAll("[data-action='resume']").forEach((el) => {
            el.addEventListener("click", () => {
                const sid = el.dataset.sid;
                resumeSessionById(sid);
            });
        });

        panel.querySelectorAll("[data-action='delete']").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const sid = btn.dataset.sid;
                if (!confirm("Delete this chat permanently?")) return;
                await deleteSessionById(sid);
            });
        });
    } catch (e) {
        console.error("Failed to load session history:", e);
    }
}

async function resumeSessionById(sid) {
    try {
        const res = await fetch(`/api/sessions/${sid}`);
        const session = await res.json();
        if (session.error) {
            showError("Session not found.");
            loadSessionHistory();
            return;
        }
        // Remove history panel
        const panel = document.getElementById("history-panel");
        if (panel) panel.remove();

        // Set as current session
        persistentSessionId = sid;
        localStorage.setItem("thinktank_session_id", sid);

        resumeSession(session);
    } catch (e) {
        showError("Failed to load session.");
    }
}

async function deleteSessionById(sid) {
    try {
        await fetch(`/api/sessions/${sid}`, { method: "DELETE" });
        // If deleting the current session, clear it
        if (sid === persistentSessionId) {
            clearPersistedSession();
        }
        // Also remove localStorage messages for this session
        localStorage.removeItem(`thinktank_messages_${sid}`);
        // Refresh history
        loadSessionHistory();
    } catch (e) {
        showError("Failed to delete session.");
    }
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
    // Just close the WS — don't send "end" so session stays resumable in DB
    if (ws) {
        ws.close();
        ws = null;
    }

    // Clear current persistent session from localStorage (but keep it in DB)
    localStorage.removeItem("thinktank_session_id");
    persistentSessionId = "";

    // Reset all state
    sessionActive = false;
    autoRunning = false;
    isReady = false;
    currentMessageEl = null;
    currentSpeakingAgent = null;
    lastExport = null;
    priorDiscussion = null;
    localMessages = [];
    currentTopic = "";
    currentRound = 1;
    fileSessionId = "";
    totalInputTokens = 0;
    totalOutputTokens = 0;
    sentimentHistory = [];
    sentimentChartOpen = false;

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
    sentimentStrip.style.display = "none";
    sentimentChartContainer.style.display = "none";
    sentimentStripTrack.innerHTML = "";

    // Remove history/resume panels
    const panel = document.getElementById("history-panel");
    if (panel) panel.remove();
    const banner = document.getElementById("resume-banner");
    if (banner) banner.remove();

    // Re-select all agents
    selectedAgents = new Set(allAgents.map((a) => a.key));
    renderAgentChips();
    buildQueueFromSelection();
    updateControls();

    // Show updated history
    loadSessionHistory();
}

// ── WebSocket Session ──

async function startSession(isResume = false) {
    const topic = isResume ? currentTopic : topicInput.value.trim();
    if (!topic) return;
    if (sessionActive) return;

    const keys = getApiKeys();
    if (!keys.api_key) {
        showError("Please add your API key in the settings panel above before starting.");
        return;
    }

    // Check session limit before creating new session
    if (!isResume && !persistentSessionId) {
        try {
            const res = await fetch(`/api/sessions?client_id=${encodeURIComponent(clientId)}`);
            const data = await res.json();
            if (data.count >= MAX_SESSIONS) {
                showError(`Session limit reached (${MAX_SESSIONS}). Please delete an old chat before starting a new one.`);
                loadSessionHistory();
                return;
            }
        } catch (e) {
            // If check fails, proceed anyway
        }
    }

    // Remove history panel when starting
    const panel = document.getElementById("history-panel");
    if (panel) panel.remove();

    if (!isResume && !priorDiscussion) {
        chatArea.innerHTML = "";
    }

    if (!isResume) {
        totalInputTokens = 0;
        totalOutputTokens = 0;
        updateUsageDisplay();

        buildQueueFromSelection();
        currentRound = 1;
        queueRound.textContent = "Round 1";

        currentTopic = topic;
        addDivider(`Topic: "${topic}"`);
    } else {
        // On resume: only rebuild queue if it's empty (preserve re-queued agents from interruptions)
        if (queue.length === 0) buildQueueFromSelection();
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
            client_id: clientId,
        };
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
        handleIncompleteResponse();
        clearAllSpeaking();
        sessionActive = false;
        autoRunning = false;
        isReady = false;
        ws = null;
        stopHeartbeat();
        releaseWakeLock();

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
        handleIncompleteResponse();
        showError("Connection error. Please try again.");
        clearAllSpeaking();
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

// ── Incomplete Response Detection ──

function handleIncompleteResponse() {
    if (!currentSpeakingAgent) return;

    const agent = currentSpeakingAgent;
    currentSpeakingAgent = null;

    // Mark the partial message visually
    if (currentMessageEl) {
        const cursor = currentMessageEl.querySelector(".cursor");
        if (cursor) cursor.remove();
        const content = currentMessageEl.querySelector(".message-content");
        const rawText = content.textContent;

        // Add truncated marker
        const marker = document.createElement("span");
        marker.className = "incomplete-marker";
        marker.textContent = " [response interrupted]";
        content.appendChild(marker);

        // Still save the partial response
        localMessages.push({
            agent_name: agent.name,
            content: rawText + " [response interrupted]",
            round_num: currentRound,
            timestamp: new Date().toISOString(),
        });
        saveSessionMessages();
        currentMessageEl = null;
    }

    setChipSpeaking(agent.name, false);
    agentStartTime = null;

    // Re-queue the agent at the front so they retry on reconnect
    const agentKey = agent.key || allAgents.find(a => a.name === agent.name)?.key || "";
    if (agentKey) {
        // Remove any existing entry for this agent to avoid duplicates
        queue = queue.filter(q => q.key !== agentKey);
        queue.unshift({
            key: agentKey,
            name: agent.name,
            avatar: agent.avatar || allAgents.find(a => a.key === agentKey)?.avatar || "?",
            color: agent.color || allAgents.find(a => a.key === agentKey)?.color || "#888",
            continue_from: "their interrupted response",
        });
        renderQueue();
    }
}

// ── Message Handling ──

function handleMessage(data) {
    switch (data.type) {
        case "pong":
            break;

        case "session_created":
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
            agentStartTime = Date.now();
            currentSpeakingAgent = {
                key: data.agent_key || allAgents.find(a => a.name === data.agent)?.key || "",
                name: data.agent,
                avatar: data.avatar,
                color: data.color,
            };
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
            currentSpeakingAgent = null;
            finishMessage(data.agent);
            setChipSpeaking(data.agent, false);
            if (data.usage) {
                totalInputTokens += data.usage.input_tokens || 0;
                totalOutputTokens += data.usage.output_tokens || 0;
                updateUsageDisplay();
            }
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
            currentSpeakingAgent = null;
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
            // Don't clear persistent session — it stays in DB for history
            resetInputMode();
            break;

        case "export_data":
            lastExport = data.export || null;
            if (lastExport) {
                localMessages = lastExport.messages || localMessages;
            }
            break;

        case "sentiment_update":
            handleSentimentUpdate(data);
            break;

        case "curator_requeue":
            handleCuratorRequeue(data);
            break;

        case "error":
            handleIncompleteResponse();
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
    btnAddAgent.disabled = false; // always enabled — users can queue prompts anytime

    if (autoRunning) {
        btnPlay.textContent = "\u23F8 Pause";
        btnPlay.title = "Pause auto-run";
    } else {
        btnPlay.textContent = "\u25B6 Play All";
        btnPlay.title = "Auto-run all in queue";
    }
}

function processNextInQueue() {
    if (queue.length === 0) return false;
    const next = queue[0];
    if (next.type === "user_prompt") {
        // Send the queued user message, then remove from queue
        queue.shift();
        renderQueue();
        sendCmd({ action: "user_message", message: next.message });
        return true;
    } else {
        // Regular agent
        isReady = false;
        updateControls();
        const cmd = { action: "run_agent", agent_key: next.key };
        if (next.continue_from) cmd.continue_from = next.continue_from;
        sendCmd(cmd);
        return true;
    }
}

function autoNext() {
    if (!autoRunning || !isReady || !sessionActive) return;
    if (queue.length === 0) {
        autoRunning = false;
        updateControls();
        return;
    }
    processNextInQueue();
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
    processNextInQueue();
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

const btnShuffle = document.getElementById("btn-shuffle");
btnShuffle.addEventListener("click", () => {
    console.log("[shuffle] clicked, queue.length =", queue.length);
    if (queue.length <= 1) return;
    shuffleQueue();
    console.log("[shuffle] new order:", queue.map(q => q.name));
    // Brief flash to confirm click
    btnShuffle.style.background = "#F39C12";
    btnShuffle.style.color = "#000";
    setTimeout(() => { btnShuffle.style.background = ""; btnShuffle.style.color = ""; }, 200);
});

function addSelectedToQueue() {
    const key = addAgentSelect.value;
    if (!key) return;

    if (key === "__user_prompt__") {
        const msg = prompt("Enter your message to queue:");
        if (!msg || !msg.trim()) { addAgentSelect.value = ""; return; }
        queue.push({
            type: "user_prompt",
            message: msg.trim(),
            name: "You",
            avatar: "\u{1F464}",
            color: "#6cb4ee",
        });
        renderQueue();
        addAgentSelect.value = "";
        updateControls();
        return;
    }

    const a = allAgents.find((x) => x.key === key);
    if (!a) return;
    queue.push({ key: a.key, name: a.name, avatar: a.avatar, color: a.color });
    renderQueue();
    addAgentSelect.value = "";
    updateControls();
}

btnAddAgent.addEventListener("click", addSelectedToQueue);

// Auto-trigger when "Your Prompt" is selected in the dropdown
addAgentSelect.addEventListener("change", () => {
    if (addAgentSelect.value === "__user_prompt__") {
        addSelectedToQueue();
    }
});

// ── New Chat ──

btnNewChat.addEventListener("click", () => {
    newChat();
});

// ── History Toggle ──

btnHistory.addEventListener("click", () => {
    const existing = document.getElementById("history-panel");
    if (existing) {
        existing.remove();
    } else {
        loadSessionHistory();
    }
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

// Only auto-scroll if user is already near the bottom (within 150px)
function isNearBottom() {
    return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 150;
}

function scrollToBottom(force = false) {
    if (force || isNearBottom()) {
        chatArea.scrollTop = chatArea.scrollHeight;
    }
}

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
    scrollToBottom(true);
}

function appendChunk(chunk) {
    if (!currentMessageEl) return;
    const content = currentMessageEl.querySelector(".message-content");
    const cursor = content.querySelector(".cursor");
    // Find or create the text node before the cursor
    let textNode = null;
    if (cursor && cursor.previousSibling && cursor.previousSibling.nodeType === Node.TEXT_NODE) {
        textNode = cursor.previousSibling;
    }
    if (textNode) {
        textNode.appendData(chunk);
    } else {
        if (cursor) cursor.remove();
        content.appendChild(document.createTextNode(chunk));
        const c = document.createElement("span");
        c.className = "cursor";
        content.appendChild(c);
    }
    scrollToBottom();
}

function finishMessage(agentNameFromEvent) {
    if (!currentMessageEl) return;
    const cursor = currentMessageEl.querySelector(".cursor");
    if (cursor) cursor.remove();
    const content = currentMessageEl.querySelector(".message-content");
    const rawText = content.textContent;
    content.innerHTML = renderMarkdown(rawText);

    // Show response time
    if (agentStartTime) {
        const elapsed = ((Date.now() - agentStartTime) / 1000).toFixed(1);
        const nameEl = currentMessageEl.querySelector(".message-name");
        if (nameEl) {
            const timeSpan = document.createElement("span");
            timeSpan.className = "message-time";
            timeSpan.textContent = ` \u00b7 ${elapsed}s`;
            nameEl.appendChild(timeSpan);
        }
        agentStartTime = null;
    }

    const agentName = agentNameFromEvent || currentMessageEl.querySelector(".message-name")?.textContent || "";
    localMessages.push({
        agent_name: agentName,
        content: rawText,
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
    // Announce to screen readers via alert region
    if (errorRegion) errorRegion.textContent = msg;
}

// escapeHtml() is in utils.js

// ── Main Event Listeners ──

submitBtn.addEventListener("click", () => {
    if (sessionActive) {
        sendUserMessage();
    } else if (submitBtn.textContent === "Reconnect" && persistentSessionId) {
        submitBtn.textContent = "Connecting...";
        submitBtn.disabled = true;
        resumeSessionById(persistentSessionId).then(() => {
            if (!sessionActive) {
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
    const savedProvider = localStorage.getItem(STORAGE_KEY_PROVIDER);
    if (savedProvider && allProviders.some((p) => p.key === savedProvider)) {
        providerSelect.value = savedProvider;
    }
    populateModelSelect();

    const savedModel = localStorage.getItem(`thinktank_model_${providerSelect.value}`);
    if (savedModel) {
        modelSelect.value = savedModel;
    }

    const savedBrave = localStorage.getItem(STORAGE_KEY_BRAVE) || "";
    apiKeyBrave.value = savedBrave;

    const savedWordLimit = localStorage.getItem("thinktank_word_limit") || "";
    wordLimitInput.value = savedWordLimit;

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

    const wl = parseInt(wordLimitInput.value) || 0;
    if (wl > 0) localStorage.setItem("thinktank_word_limit", wl);
    else localStorage.removeItem("thinktank_word_limit");

    settingsNotice.textContent = "Settings saved to this browser.";
    settingsNotice.className = "settings-notice ok";
    updateSearchBanner();
    setTimeout(() => { settingsNotice.textContent = ""; settingsNotice.className = "settings-notice"; }, 3000);
}

function clearSettings() {
    const providerKey = providerSelect.value;
    localStorage.removeItem(`thinktank_api_key_${providerKey}`);
    localStorage.removeItem(STORAGE_KEY_BRAVE);
    localStorage.removeItem("thinktank_word_limit");
    apiKeyProvider.value = "";
    apiKeyBrave.value = "";
    wordLimitInput.value = "";
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
        word_limit: parseInt(wordLimitInput.value) || 0,
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
    settingsToggle.setAttribute("aria-expanded", open);
    if (settingsArrow) settingsArrow.innerHTML = open ? "&#9650;" : "&#9660;";
});

settingsSave.addEventListener("click", saveSettings);
settingsClear.addEventListener("click", clearSettings);

// ── Mobile Queue Toggle ──
const queueToggle = document.getElementById("queue-toggle");
queueToggle.addEventListener("click", () => {
    const isOpen = queuePanel.classList.toggle("mobile-open");
    queueToggle.setAttribute("aria-expanded", isOpen);
    queueToggle.innerHTML = isOpen
        ? "Speaker Queue &#9650;"
        : "Speaker Queue &#9660;";
});

// ── Global Keyboard Shortcuts ──
document.addEventListener("keydown", (e) => {
    // Ctrl+Enter: submit from anywhere
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (sessionActive) {
            sendUserMessage();
        } else if (!submitBtn.disabled) {
            submitBtn.click();
        }
        return;
    }
    // Escape: pause auto-play or close settings
    if (e.key === "Escape") {
        if (autoRunning) {
            autoRunning = false;
            updateControls();
            return;
        }
        if (settingsBody.classList.contains("open")) {
            settingsBody.classList.remove("open");
            settingsToggle.setAttribute("aria-expanded", false);
            if (settingsArrow) settingsArrow.innerHTML = "&#9660;";
            return;
        }
    }
});

// ── Sentiment Analyst ──

function handleSentimentUpdate(data) {
    const entry = {
        round: data.round,
        viewpoints: data.data.viewpoints || [],
        scores: data.data.scores || {},
    };
    sentimentHistory.push(entry);
    renderSentimentStrip(entry);
    if (sentimentChartOpen) {
        renderSentimentChart();
    }
}

function renderSentimentStrip(latestEntry) {
    if (!latestEntry || !latestEntry.viewpoints.length) return;

    sentimentStrip.style.display = "block";

    const vps = latestEntry.viewpoints;
    sentimentLabelRight.textContent = vps[0]?.label || "Viewpoint A";
    sentimentLabelLeft.textContent = vps.length > 1 ? vps[1].label : "";

    sentimentStripTrack.innerHTML = "";

    const scores = latestEntry.scores;
    for (const [agentName, score] of Object.entries(scores)) {
        if (typeof score !== "number") continue;
        const agent = allAgents.find(a => a.name === agentName);

        const dot = document.createElement("div");
        dot.className = "sentiment-dot";
        dot.style.backgroundColor = agent ? agent.color : "#888";

        // Map score (-1 to +1) to percentage (0% to 100%)
        const pct = ((score + 1) / 2) * 100;
        dot.style.left = `${Math.max(2, Math.min(98, pct))}%`;

        const tooltip = document.createElement("span");
        tooltip.className = "sentiment-dot-tooltip";
        const avatar = agent ? agent.avatar : "?";
        tooltip.textContent = `${avatar} ${agentName}: ${score > 0 ? "+" : ""}${score.toFixed(1)}`;
        dot.appendChild(tooltip);

        sentimentStripTrack.appendChild(dot);
    }
}

function renderSentimentChart() {
    if (sentimentHistory.length === 0) return;

    const canvas = sentimentCanvas;
    const ctx = canvas.getContext("2d");

    // Handle HiDPI
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const PAD_LEFT = 50;
    const PAD_RIGHT = 20;
    const PAD_TOP = 25;
    const PAD_BOTTOM = 30;
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;

    // Clear
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    ctx.fillStyle = isDark ? "#151821" : "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // Collect all agent names across all rounds
    const allAgentNames = new Set();
    sentimentHistory.forEach(entry => {
        Object.keys(entry.scores).forEach(name => {
            if (typeof entry.scores[name] === "number") allAgentNames.add(name);
        });
    });

    const rounds = sentimentHistory.map(e => e.round);
    const minRound = Math.min(...rounds);
    const maxRound = Math.max(...rounds);
    const roundRange = maxRound - minRound || 1;

    const xPos = (round) => PAD_LEFT + ((round - minRound) / roundRange) * plotW;
    const yPos = (score) => PAD_TOP + ((1 - score) / 2) * plotH;

    // Horizontal gridlines at -1, -0.5, 0, 0.5, 1
    [-1, -0.5, 0, 0.5, 1].forEach(val => {
        const y = yPos(val);
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(W - PAD_RIGHT, y);
        if (val === 0) {
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = isDark ? "#555" : "#aaa";
            ctx.lineWidth = 1;
        } else {
            ctx.setLineDash([]);
            ctx.strokeStyle = isDark ? "#333" : "#ddd";
            ctx.lineWidth = 0.5;
        }
        ctx.stroke();
        ctx.setLineDash([]);
    });

    // Y-axis labels
    ctx.fillStyle = isDark ? "#888" : "#666";
    ctx.font = "11px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    [-1, -0.5, 0, 0.5, 1].forEach(val => {
        ctx.fillText(val.toFixed(1), PAD_LEFT - 6, yPos(val));
    });

    // X-axis labels (round numbers)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    rounds.forEach(r => {
        ctx.fillText(`R${r}`, xPos(r), H - PAD_BOTTOM + 6);
    });

    // Viewpoint labels at top
    const latestEntry = sentimentHistory[sentimentHistory.length - 1];
    if (latestEntry.viewpoints.length >= 1) {
        ctx.fillStyle = isDark ? "#27AE60" : "#1a8a45";
        ctx.textAlign = "right";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillText(latestEntry.viewpoints[0].label + " (+1)", W - PAD_RIGHT, 4);
    }
    if (latestEntry.viewpoints.length >= 2) {
        ctx.fillStyle = isDark ? "#E74C3C" : "#c0392b";
        ctx.textAlign = "left";
        ctx.fillText(latestEntry.viewpoints[1].label + " (-1)", PAD_LEFT, 4);
    }

    // Draw lines per agent
    allAgentNames.forEach(agentName => {
        const agent = allAgents.find(a => a.name === agentName);
        const color = agent ? agent.color : "#888";

        const points = [];
        sentimentHistory.forEach(entry => {
            if (typeof entry.scores[agentName] === "number") {
                points.push({ round: entry.round, score: entry.scores[agentName] });
            }
        });

        if (points.length === 0) return;

        // Draw line
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        points.forEach((p, i) => {
            const x = xPos(p.round);
            const y = yPos(p.score);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Draw dots
        points.forEach(p => {
            const x = xPos(p.round);
            const y = yPos(p.score);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = isDark ? "#0f1117" : "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
    });

    // Update legend
    sentimentLegend.innerHTML = "";
    allAgentNames.forEach(agentName => {
        const agent = allAgents.find(a => a.name === agentName);
        const color = agent ? agent.color : "#888";
        const item = document.createElement("span");
        item.className = "sentiment-legend-item";
        item.innerHTML = `<span class="sentiment-legend-swatch" style="background:${color}"></span>${escapeHtml(agentName)}`;
        sentimentLegend.appendChild(item);
    });
}

// Strip click toggles chart
sentimentStrip.addEventListener("click", () => {
    sentimentChartOpen = !sentimentChartOpen;
    if (sentimentChartOpen) {
        sentimentChartContainer.style.display = "block";
        renderSentimentChart();
    } else {
        sentimentChartContainer.style.display = "none";
    }
});

sentimentStrip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        sentimentStrip.click();
    }
});

sentimentChartClose.addEventListener("click", (e) => {
    e.stopPropagation();
    sentimentChartOpen = false;
    sentimentChartContainer.style.display = "none";
});

window.addEventListener("resize", () => {
    if (sentimentChartOpen && sentimentHistory.length > 0) {
        renderSentimentChart();
    }
});

// ── Curator: incomplete response re-queuing ──

function handleCuratorRequeue(data) {
    const agentKey = data.agent_key;
    const agentName = data.agent_name;
    const lastTopic = data.last_topic || "their previous point";

    // Add a notice in chat
    const notice = document.createElement("div");
    notice.className = "curator-notice";
    notice.textContent = `\u{1F50D} Curator detected incomplete response from ${agentName} — re-queuing to continue from: "${lastTopic}"`;
    chatArea.appendChild(notice);
    scrollToBottom();

    // Add to front of queue (dedupe first)
    queue = queue.filter(q => q.key !== agentKey);
    queue.unshift({
        key: agentKey,
        name: agentName,
        avatar: data.avatar || "?",
        color: data.color || "#888",
        continue_from: lastTopic,
    });
    renderQueue();
    updateControls();
}

// ── Init ──
loadProviders();
loadAgents().then(() => {
    buildQueueFromSelection();
    updateControls();
    loadSessionHistory();
});
