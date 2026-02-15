const chatArea = document.getElementById("chat-area");
const topicInput = document.getElementById("topic-input");
const submitBtn = document.getElementById("submit-btn");
const roundsSelect = document.getElementById("rounds");
const agentsBar = document.getElementById("agents-bar");

let ws = null;
let currentMessageEl = null;

// Load agent chips on page load
async function loadAgents() {
    try {
        const res = await fetch("/api/agents");
        const agents = await res.json();
        agentsBar.innerHTML = agents
            .map(
                (a) =>
                    `<div class="agent-chip" id="chip-${a.name.replace(/\s+/g, "-")}" style="border-color: ${a.color}">
                        <span class="agent-avatar">${a.avatar}</span>
                        <span style="color: ${a.color}">${a.name}</span>
                    </div>`
            )
            .join("");
    } catch (e) {
        console.error("Failed to load agents:", e);
    }
}

function setChipSpeaking(agentName, speaking) {
    const chipId = "chip-" + agentName.replace(/\s+/g, "-");
    const chip = document.getElementById(chipId);
    if (chip) {
        if (speaking) {
            chip.classList.add("speaking");
        } else {
            chip.classList.remove("speaking");
        }
    }
}

function clearAllSpeaking() {
    document.querySelectorAll(".agent-chip.speaking").forEach((el) => el.classList.remove("speaking"));
}

function scrollToBottom() {
    chatArea.scrollTop = chatArea.scrollHeight;
}

function startDiscussion() {
    const topic = topicInput.value.trim();
    if (!topic) return;

    // Clear previous discussion
    chatArea.innerHTML = "";
    submitBtn.disabled = true;
    topicInput.disabled = true;

    // Add topic header
    const topicEl = document.createElement("div");
    topicEl.className = "round-divider";
    topicEl.textContent = `Topic: "${topic}"`;
    chatArea.appendChild(topicEl);

    const rounds = roundsSelect.value;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/discuss`);

    ws.onopen = () => {
        ws.send(JSON.stringify({ topic, rounds: parseInt(rounds) }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };

    ws.onclose = () => {
        clearAllSpeaking();
        submitBtn.disabled = false;
        topicInput.disabled = false;
    };

    ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        showError("Connection error. Please try again.");
        submitBtn.disabled = false;
        topicInput.disabled = false;
    };
}

function handleMessage(data) {
    switch (data.type) {
        case "round_start":
            addRoundDivider(data.round, data.total_rounds);
            break;

        case "agent_start":
            currentMessageEl = addAgentMessage(data.agent, data.color, data.avatar);
            setChipSpeaking(data.agent, true);
            break;

        case "agent_chunk":
            appendChunk(data.chunk);
            break;

        case "agent_done":
            finishMessage();
            setChipSpeaking(data.agent, false);
            break;

        case "discussion_end":
            clearAllSpeaking();
            break;

        case "error":
            showError(data.message);
            break;
    }
}

function addRoundDivider(round, totalRounds) {
    const el = document.createElement("div");
    el.className = "round-divider";
    el.textContent = `Round ${round} of ${totalRounds}`;
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
        </div>
    `;
    chatArea.appendChild(el);
    scrollToBottom();
    return el;
}

function appendChunk(chunk) {
    if (!currentMessageEl) return;
    const content = currentMessageEl.querySelector(".message-content");
    // Remove cursor, append text, re-add cursor
    const cursor = content.querySelector(".cursor");
    if (cursor) cursor.remove();

    content.textContent += chunk;

    const newCursor = document.createElement("span");
    newCursor.className = "cursor";
    content.appendChild(newCursor);

    scrollToBottom();
}

function finishMessage() {
    if (!currentMessageEl) return;
    const cursor = currentMessageEl.querySelector(".cursor");
    if (cursor) cursor.remove();
    currentMessageEl = null;
}

function showError(message) {
    const el = document.createElement("div");
    el.className = "error-message";
    el.textContent = message;
    chatArea.appendChild(el);
    scrollToBottom();
}

// Event listeners
submitBtn.addEventListener("click", startDiscussion);
topicInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !submitBtn.disabled) {
        startDiscussion();
    }
});

// Initialize
loadAgents();
