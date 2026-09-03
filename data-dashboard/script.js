// --- Navigation Tab Logic ---
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        // Remove active class from all tabs and pages
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
        
        // Add active class to selected
        tab.classList.add('active');
        const targetPage = document.getElementById(tab.dataset.target);
        targetPage.classList.add('active');

        // Force Chart.js to resize to prevent layout collapse when hidden
        if (tab.dataset.target === 'telemetry-page') {
            if(accelChart) accelChart.resize();
            if(gyroChart) gyroChart.resize();
        }
    });
});

// --- BLE Service & Characteristic UUIDs (Nordic UART Service) ---
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const RX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

let bluetoothDevice = null;
let robotControlCharacteristic = null;
let bleBuffer = ""; 

const MAX_POINTS = 30;
let timeLabels = Array(MAX_POINTS).fill('');
let ax = Array(MAX_POINTS).fill(0), ay = Array(MAX_POINTS).fill(0), az = Array(MAX_POINTS).fill(0);
let gx = Array(MAX_POINTS).fill(0), gy = Array(MAX_POINTS).fill(0), gz = Array(MAX_POINTS).fill(0);
let accelChart = null, gyroChart = null;

function logDebug(message) {
    const consoleElem = document.getElementById('debugLog');
    if (consoleElem) {
        consoleElem.textContent += `\n[${new Date().toLocaleTimeString()}] ${message}`;
        consoleElem.scrollTop = consoleElem.scrollHeight;
    }
    console.log(message);
}

function setRobotControlStatus(message, state = 'offline') {
    const status = document.getElementById('robotControlStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `robot-control-status ${state}`;
}

function setRobotControlsEnabled(enabled) {
    document.querySelectorAll('[data-robot-command], #jointSelect, #jointAngle, #jointAngleNumber, #sendJointBtn')
        .forEach(control => { control.disabled = !enabled; });
    setRobotControlStatus(enabled ? 'READY FOR COMMANDS' : 'CONNECT TO ENABLE', enabled ? 'ready' : 'offline');
}

async function sendRobotCommand(command, actionLabel) {
    if (!robotControlCharacteristic || !bluetoothDevice?.gatt?.connected) {
        logDebug('Robot command not sent: BLE is disconnected.');
        setRobotControlStatus('NOT CONNECTED', 'error');
        return;
    }
    try {
        setRobotControlStatus(`SENDING ${actionLabel.toUpperCase()}`, 'sending');
        const commandBytes = new TextEncoder().encode(command);
        if (typeof robotControlCharacteristic.writeValueWithoutResponse === 'function') {
            await robotControlCharacteristic.writeValueWithoutResponse(commandBytes);
        } else if (typeof robotControlCharacteristic.writeValueWithResponse === 'function') {
            await robotControlCharacteristic.writeValueWithResponse(commandBytes);
        } else {
            await robotControlCharacteristic.writeValue(commandBytes);
        }
        logDebug(`Robodog command sent: ${actionLabel} (${command})`);
        setRobotControlStatus(`SENT: ${actionLabel.toUpperCase()}`, 'ready');
    } catch (error) {
        logDebug(`Robot command error: ${error.message || error}`);
        setRobotControlStatus('COMMAND FAILED', 'error');
    }
}

function initCharts() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = '#272c36';

    const accelCtx = document.getElementById('accelChart')?.getContext('2d');
    if (accelCtx && !accelChart) {
        accelChart = new Chart(accelCtx, {
            type: 'line',
            data: {
                labels: timeLabels,
                datasets: [
                    { label: 'X', data: ax, borderColor: '#ef4444', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Y', data: ay, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Z', data: az, borderColor: '#0ea5e9', borderWidth: 2, pointRadius: 0, tension: 0.2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, animation: false }
        });
    }

    const gyroCtx = document.getElementById('gyroChart')?.getContext('2d');
    if (gyroCtx && !gyroChart) {
        gyroChart = new Chart(gyroCtx, {
            type: 'line',
            data: {
                labels: timeLabels,
                datasets: [
                    { label: 'Pitch', data: gx, borderColor: '#ef4444', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Roll', data: gy, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Yaw', data: gz, borderColor: '#0ea5e9', borderWidth: 2, pointRadius: 0, tension: 0.2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, animation: false }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initCharts();

    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const statusBadge = document.getElementById('statusBadge');
    
    // Joint logic
    const jointAngle = document.getElementById('jointAngle');
    const jointAngleNumber = document.getElementById('jointAngleNumber');
    const jointAngleValue = document.getElementById('jointAngleValue');
    const jointSelect = document.getElementById('jointSelect');
    const sendJointBtn = document.getElementById('sendJointBtn');

    const syncJointAngle = value => {
        const angle = Math.min(180, Math.max(0, Number.parseInt(value, 10) || 0));
        jointAngle.value = angle;
        jointAngleNumber.value = angle;
        if(jointAngleValue) jointAngleValue.textContent = `${angle} deg`;
    };

    jointAngle.addEventListener('input', event => syncJointAngle(event.target.value));
    jointAngleNumber.addEventListener('input', event => syncJointAngle(event.target.value));

    document.querySelectorAll('[data-robot-command]').forEach(button => {
        button.addEventListener('click', () => {
            sendRobotCommand(button.dataset.robotCommand, button.dataset.robotAction);
        });
    });

    sendJointBtn.addEventListener('click', () => {
        const angle = Math.min(180, Math.max(0, Number.parseInt(jointAngle.value, 10) || 0));
        const joint = jointSelect.value;
        sendRobotCommand(`${joint} ${angle}`, `${joint} to ${angle} degrees`);
    });

    setRobotControlsEnabled(false);

    if (!navigator.bluetooth) {
        logDebug("ERROR: Web Bluetooth API is not supported. Use Chrome or Edge.");
        return;
    }

    connectBtn.addEventListener('click', async () => {
        logDebug("Initiating BLE device scan...");
        try {
            try {
                bluetoothDevice = await navigator.bluetooth.requestDevice({
                    filters: [{ name: 'RoboDog_Hub' }, { services: [SERVICE_UUID] }],
                    optionalServices: [SERVICE_UUID]
                });
            } catch (filterErr) {
                bluetoothDevice = await navigator.bluetooth.requestDevice({
                    acceptAllDevices: true, optionalServices: [SERVICE_UUID]
                });
            }

            bluetoothDevice.addEventListener('gattserverdisconnected', () => {
                logDebug("Device disconnected!");
                statusBadge.textContent = "DISCONNECTED";
                statusBadge.className = "badge disconnected";
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
                robotControlCharacteristic = null;
                setRobotControlsEnabled(false);
            });

            const server = await bluetoothDevice.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            const telemetryCharacteristic = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);
            robotControlCharacteristic = await service.getCharacteristic(RX_CHARACTERISTIC_UUID);

            await telemetryCharacteristic.startNotifications();
            telemetryCharacteristic.addEventListener('characteristicvaluechanged', handleIncomingData);

            statusBadge.textContent = "CONNECTED";
            statusBadge.className = "badge connected";
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;
            setRobotControlsEnabled(true);
            logDebug(">> CONNECTED TO ROBODOG <<");

        } catch (error) {
            robotControlCharacteristic = null;
            setRobotControlsEnabled(false);
            logDebug(`BLE Error: ${error.message || error}`);
        }
    });

    disconnectBtn.addEventListener('click', () => {
        if (bluetoothDevice && bluetoothDevice.gatt.connected) {
            bluetoothDevice.gatt.disconnect();
        }
    });
});

function handleIncomingData(event) {
    const decoder = new TextDecoder('utf-8');
    const newChunk = decoder.decode(event.target.value);
    bleBuffer += newChunk;

    let newlineIndex;
    while ((newlineIndex = bleBuffer.indexOf('\n')) !== -1) {
        const line = bleBuffer.substring(0, newlineIndex).trim();
        bleBuffer = bleBuffer.substring(newlineIndex + 1);

        if (!line) continue;
        if (line.startsWith('<') && line.endsWith('>')) {
            parseAndDisplayPacket(line.slice(1, -1));
        } else {
            logDebug(`Hub: ${line}`);
        }
    }
}

function parseAndDisplayPacket(payload) {
    const sections = payload.split('|');
    const data = {};
    sections.forEach(sec => {
        const parts = sec.split(':');
        if (parts.length === 2) data[parts[0]] = parts[1].split(',').map(Number);
    });
    updateDashboard(data);
}

function updateDashboard(data) {
    if (data.T) {
        document.getElementById('val-temp').innerText = `${data.T[0].toFixed(1)} °C`;
        document.getElementById('bar-temp').style.width = `${Math.min(Math.max((data.T[0] / 50) * 100, 0), 100)}%`;
    }
    if (data.H) {
        document.getElementById('val-hum').innerText = `${data.H[0].toFixed(1)} %`;
        document.getElementById('bar-hum').style.width = `${data.H[0]}%`;
    }
    if (data.Gas) {
        const gasLvl = data.Gas[0];
        const GAS_THRESHOLD = 250; 
        const gasVal = document.getElementById('val-gas');
        const gasMsg = document.getElementById('val-gas-msg');
        const gasBar = document.getElementById('bar-gas');
        const gasCard = document.getElementById('gas-card');

        gasBar.style.width = `${Math.min((gasLvl / 1023) * 100, 100)}%`;
        gasVal.innerText = gasLvl;

        if (gasLvl > GAS_THRESHOLD) {
            gasMsg.innerText = "⚠️ Unwanted Gas Detected!";
            gasMsg.style.color = "#ef4444"; 
            gasVal.style.color = "#ef4444"; 
            gasBar.style.background = "#ef4444"; 
            gasCard.style.borderColor = "#ef4444"; 
        } else {
            gasMsg.innerText = "✅ Normal";
            gasMsg.style.color = "#10b981"; 
            gasVal.style.color = "#e2e8f0"; 
            gasBar.style.background = "#0ea5e9"; 
            gasCard.style.borderColor = "#272c36"; 
        }
    }
    if (data.Fire) {
        const flameLvl = data.Fire[0];
        const flameCard = document.getElementById('flame-card');
        document.getElementById('val-flame-raw').innerText = `Intensity: ${flameLvl}`;
        
        if (flameLvl ==0) {
            document.getElementById('val-flame').innerText = "🔥 WARNING";
            document.getElementById('val-flame').style.color = "#ef4444";
            flameCard.style.borderColor = "#ef4444";
        } else {
            document.getElementById('val-flame').innerText = "✅ SAFE";
            document.getElementById('val-flame').style.color = "#10b981";
            flameCard.style.borderColor = "#272c36";
        }
    }
    if (data.A && accelChart) updateArray(ax, ay, az, data.A, accelChart);
    if (data.G && gyroChart) updateArray(gx, gy, gz, data.G, gyroChart);
    if (data.P) document.getElementById('val-pres').innerText = `${data.P[0].toFixed(1)} kPa`;
    if (data.C && data.C.length === 3) {
        document.getElementById('val-color-box').style.backgroundColor = `rgb(${Math.min(data.C[0]*2, 255)}, ${Math.min(data.C[1]*2, 255)}, ${Math.min(data.C[2]*2, 255)})`;
        document.getElementById('val-rgb-text').innerText = `R:${data.C[0]} G:${data.C[1]} B:${data.C[2]}`;
    }
    if (data.M && data.M.length >= 2) {
        let heading = Math.atan2(data.M[1], data.M[0]) * (180 / Math.PI);
        if (heading < 0) heading += 360;
        document.getElementById('compass-dial').style.transform = `rotate(${heading}deg)`;
        document.getElementById('val-mag').innerText = `Heading: ${heading.toFixed(0)}°`;
    }
    if (data.N) {
        document.getElementById('vu-meter').style.height = `${Math.min((data.N[0] / 150) * 100, 100)}%`;
        document.getElementById('val-noise').innerText = `Amplitude: ${data.N[0]}`;
    }
}

function updateArray(arrX, arrY, arrZ, newValues, chartRef) {
    if (newValues.length < 3) return;
    arrX.push(newValues[0]); arrX.shift();
    arrY.push(newValues[1]); arrY.shift();
    arrZ.push(newValues[2]); arrZ.shift();
    chartRef.update();
}

// =============================================================================
// VOICE COMMAND ENGINE — Web Speech API + Keyword Mapping
// =============================================================================

/**
 * Keyword map: each command has an array of trigger words.
 * If ANY of those words appear in the recognised utterance, the command fires.
 * Words are checked case-insensitively against the transcript.
 */
const VOICE_COMMAND_MAP = [
    {
        command: '1',
        action:  'Stand',
        // Matches: "stand", "up", "rise", "upright", "straight", "get up"
        keywords: ['stand', 'up', 'rise', 'upright', 'straight', 'get up'],
    },
    {
        command: '5',
        action:  'Sit',
        // Matches: "sit", "down", "crouch", "squat", "lower"
        keywords: ['sit', 'down', 'crouch', 'squat', 'lower'],
    },
    {
        command: '3',
        action:  'Hello / High-five',
        // Matches: "hello", "hi", "wave", "greet", "high five", "high-five", "howdy", "hey"
        keywords: ['hello', ' hi ', 'wave', 'greet', 'high five', 'high-five', 'howdy', 'hey'],
    },
    {
        command: '2',
        action:  'Rest',
        // Matches: "rest", "relax", "stop", "sleep", "idle", "chill", "pause", "halt"
        keywords: ['rest', 'relax', 'stop', 'sleep', 'idle', 'chill', 'pause', 'halt'],
    },
    {
        command: '4',
        action:  'Dance',
        // Matches: "dance", "walk", "groove", "move", "boogie", "shuffle", "jive", "spin"
        keywords: ['dance', 'walk', 'groove', 'move', 'boogie', 'shuffle', 'jive', 'spin'],
    },
];

/**
 * Match a spoken transcript string against the command map.
 * Returns the first matching command entry, or null if none matched.
 */
function matchVoiceCommand(transcript) {
    const lower = ` ${transcript.toLowerCase()} `; // pad with spaces for word-boundary matching
    for (const entry of VOICE_COMMAND_MAP) {
        for (const kw of entry.keywords) {
            // Check as a substring in padded string
            if (lower.includes(kw.toLowerCase())) {
                return entry;
            }
        }
    }
    return null;
}

// --- Speech Recognition Initialisation ---
(function initVoiceEngine() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    const micBtn       = document.getElementById('voiceMicBtn');
    const transcriptEl = document.getElementById('voiceTranscript');
    const statusEl     = document.getElementById('voiceStatus');

    if (!SpeechRecognition) {
        if (micBtn) {
            micBtn.disabled = true;
            micBtn.title = 'Speech Recognition not supported in this browser. Use Chrome or Edge.';
        }
        if (statusEl) {
            statusEl.textContent = '⚠ Speech Recognition unavailable — use Chrome or Edge';
            statusEl.className   = 'voice-status-bar unmatched';
        }
        logDebug('Voice: Web Speech API not supported in this browser.');
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang         = 'en-US';
    recognition.interimResults = true;  // Show live partial results
    recognition.continuous   = false;   // Auto-stop after each phrase
    recognition.maxAlternatives = 3;

    let isListening = false;

    function startListening() {
        if (isListening) return;
        try {
            recognition.start();
        } catch (e) {
            // Already started — ignore duplicate starts
        }
    }

    function stopListening() {
        if (!isListening) return;
        try {
            recognition.stop();
        } catch (e) { /* ignore */ }
    }

    function setListeningUI(active) {
        isListening = active;
        if (!micBtn) return;
        if (active) {
            micBtn.classList.add('listening');
            micBtn.textContent = '🔴 LISTENING…';
        } else {
            micBtn.classList.remove('listening');
            micBtn.textContent = '🎤 SPEAK';
        }
    }

    // Mic button — tap to toggle
    micBtn.addEventListener('click', () => {
        if (isListening) {
            stopListening();
        } else {
            // Clear old status
            statusEl.textContent = '';
            statusEl.className   = 'voice-status-bar listening';
            transcriptEl.classList.add('active');
            transcriptEl.textContent = '🎙 Listening…';
            startListening();
        }
    });

    // ---- Recognition Events ----

    recognition.addEventListener('start', () => {
        setListeningUI(true);
        logDebug('Voice: Microphone opened — listening for commands…');
    });

    recognition.addEventListener('result', (event) => {
        let interimText = '';
        let finalText   = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result     = event.results[i];
            const transcript = result[0].transcript;
            if (result.isFinal) {
                finalText += transcript;
            } else {
                interimText += transcript;
            }
        }

        // Show live transcript
        const displayText = finalText || interimText;
        transcriptEl.textContent = `"${displayText}"`;

        if (finalText) {
            logDebug(`Voice: Heard → "${finalText.trim()}"`);
            const match = matchVoiceCommand(finalText);

            if (match) {
                statusEl.textContent = `✅ MATCHED: ${match.action.toUpperCase()}`;
                statusEl.className   = 'voice-status-bar matched';
                logDebug(`Voice: Command matched → ${match.action} (${match.command})`);

                // Fire the robot command — same path as button click
                sendRobotCommand(match.command, match.action);

                // Visual flash on the corresponding button
                const btn = document.querySelector(`[data-robot-command="${match.command}"]`);
                if (btn && !btn.disabled) {
                    btn.classList.add('voice-activated');
                    setTimeout(() => btn.classList.remove('voice-activated'), 800);
                }
            } else {
                statusEl.textContent = `❌ NO MATCH — try: stand, sit, hello, rest, dance`;
                statusEl.className   = 'voice-status-bar unmatched';
                logDebug(`Voice: No command matched for "${finalText.trim()}"`);
            }
        }
    });

    recognition.addEventListener('end', () => {
        setListeningUI(false);
        transcriptEl.classList.remove('active');
        logDebug('Voice: Microphone closed.');
    });

    recognition.addEventListener('error', (event) => {
        setListeningUI(false);
        transcriptEl.classList.remove('active');
        const errMsg = event.error === 'not-allowed'
            ? '⛔ Microphone access denied. Please allow mic permission.'
            : `⚠ Speech error: ${event.error}`;
        statusEl.textContent = errMsg;
        statusEl.className   = 'voice-status-bar unmatched';
        transcriptEl.textContent = 'Voice commands ready. Press SPEAK and talk to Daksh…';
        logDebug(`Voice error: ${event.error}`);
    });

    logDebug('Voice: Speech recognition engine initialised. Press SPEAK to activate.');
})();
