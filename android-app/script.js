// Static import — required so Vite/Capacitor correctly injects the native Android BLE bridge.
import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';

// Helper: encode a string to DataView (required by BleClient.write)
function stringToDataView(str) {
    const bytes = new TextEncoder().encode(str);
    return new DataView(bytes.buffer);
}

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
const SERVICE_UUID          = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // Arduino → App (notify)
const RX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // App → Arduino (write)

let connectedDeviceId = null;
let bleBuffer = "";
let bleInitialized = false;

async function initBle() {
    if (bleInitialized) return true;
    try {
        await BleClient.initialize({ androidNeverForLocation: false });
        bleInitialized = true;
        return true;
    } catch (e) {
        logDebug('BLE init error: ' + (e.message || e));
        return false;
    }
}

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
    if (!connectedDeviceId || !BleClient) {
        logDebug('Robot command not sent: BLE is disconnected.');
        setRobotControlStatus('NOT CONNECTED', 'error');
        return;
    }
    try {
        setRobotControlStatus(`SENDING ${actionLabel.toUpperCase()}`, 'sending');
        const commandBytes = new TextEncoder().encode(command);
        await BleClient.writeWithoutResponse(
            connectedDeviceId, SERVICE_UUID, RX_CHARACTERISTIC_UUID,
            stringToDataView(command));
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
                    { label: 'Roll',  data: gy, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Yaw',   data: gz, borderColor: '#0ea5e9', borderWidth: 2, pointRadius: 0, tension: 0.2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, animation: false }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initCharts();

    const connectBtn    = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const statusBadge   = document.getElementById('statusBadge');

    // Joint logic
    const jointAngle       = document.getElementById('jointAngle');
    const jointAngleNumber = document.getElementById('jointAngleNumber');
    const jointAngleValue  = document.getElementById('jointAngleValue');
    const jointSelect      = document.getElementById('jointSelect');
    const sendJointBtn     = document.getElementById('sendJointBtn');

    const syncJointAngle = value => {
        const angle = Math.min(180, Math.max(0, Number.parseInt(value, 10) || 0));
        jointAngle.value = angle;
        jointAngleNumber.value = angle;
        if (jointAngleValue) jointAngleValue.textContent = `${angle} deg`;
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

    // ── BLE Scan Modal helpers ────────────────────────────────────────────────
    const scanModal    = document.getElementById('bleScanModal');
    const deviceList   = document.getElementById('bleDeviceList');
    const noDevicesEl  = document.getElementById('bleNoDevices');
    const scanSpinner  = document.getElementById('bleScanSpinner');
    const scanTitle    = document.getElementById('bleScanTitle');
    const cancelBtn    = document.getElementById('bleCancelBtn');

    const discoveredDevices = new Map(); // deviceId → device info
    let scanActive = false;

    function openScanModal() {
        discoveredDevices.clear();
        deviceList.innerHTML = '';
        deviceList.appendChild(noDevicesEl);
        noDevicesEl.textContent = 'No devices found yet…';
        scanSpinner.classList.remove('stopped');
        scanTitle.textContent = 'Scanning for devices…';
        scanModal.style.display = 'flex';
    }

    function closeScanModal() {
        scanModal.style.display = 'none';
    }

    function addDeviceToList(device) {
        if (discoveredDevices.has(device.deviceId)) return; // already shown
        discoveredDevices.set(device.deviceId, device);

        // Hide the "no devices" placeholder
        if (noDevicesEl.parentNode === deviceList) {
            deviceList.removeChild(noDevicesEl);
        }

        const item = document.createElement('div');
        item.className = 'ble-device-item';
        item.innerHTML = `
            <div class="ble-device-info">
                <div class="ble-device-name">${device.name || '(Unknown Device)'}</div>
                <div class="ble-device-id">${device.deviceId}</div>
            </div>
            <div class="ble-connect-chip">CONNECT</div>
        `;
        item.addEventListener('click', () => connectToDevice(device.deviceId, device.name));
        deviceList.appendChild(item);
    }

    async function connectToDevice(deviceId, deviceName) {
        // Stop scanning first
        if (scanActive) {
            try { await BleClient.stopLEScan(); } catch(_) {}
            scanActive = false;
        }
        closeScanModal();

        logDebug(`Connecting to ${deviceName || deviceId}…`);
        try {
            await BleClient.connect(deviceId, () => {
                logDebug('Device disconnected!');
                statusBadge.textContent = 'DISCONNECTED';
                statusBadge.className   = 'badge disconnected';
                connectBtn.disabled     = false;
                disconnectBtn.disabled  = true;
                connectedDeviceId       = null;
                setRobotControlsEnabled(false);
            });

            connectedDeviceId = deviceId;

            await BleClient.startNotifications(
                connectedDeviceId,
                SERVICE_UUID,
                TX_CHARACTERISTIC_UUID,
                (value) => {
                    // value is a DataView on Android
                    const bytes = value instanceof DataView
                        ? new Uint8Array(value.buffer)
                        : new Uint8Array(value.buffer ?? value);
                    const chunk = new TextDecoder('utf-8').decode(bytes);
                    bleBuffer += chunk;
                    let idx;
                    while ((idx = bleBuffer.indexOf('\n')) !== -1) {
                        const line = bleBuffer.substring(0, idx).trim();
                        bleBuffer  = bleBuffer.substring(idx + 1);
                        if (!line) continue;
                        if (line.startsWith('<') && line.endsWith('>')) {
                            parseAndDisplayPacket(line.slice(1, -1));
                        } else {
                            logDebug(`Hub: ${line}`);
                        }
                    }
                }
            );

            statusBadge.textContent = 'CONNECTED';
            statusBadge.className   = 'badge connected';
            connectBtn.disabled     = true;
            disconnectBtn.disabled  = false;
            setRobotControlsEnabled(true);
            logDebug(`>> CONNECTED TO ${(deviceName || deviceId).toUpperCase()} <<`);

        } catch (error) {
            connectedDeviceId = null;
            setRobotControlsEnabled(false);
            logDebug(`BLE Connect Error: ${error.message || error}`);
        }
    }

    // ── CONNECT BUTTON ────────────────────────────────────────────────────────
    connectBtn.addEventListener('click', async () => {
        const ok = await initBle();
        if (!ok) {
            logDebug('ERROR: BLE init failed. Make sure you are running the native Android app.');
            return;
        }

        // Request BLE enable first (Android will prompt if off)
        try { await BleClient.requestEnable(); } catch (_) {}

        openScanModal();
        logDebug('Scanning for ALL nearby BLE devices…');

        try {
            scanActive = true;
            // requestLEScan with no filters → discovers every advertising BLE device
            await BleClient.requestLEScan({}, (result) => {
                addDeviceToList({
                    deviceId: result.device.deviceId,
                    name: result.device.name || result.localName || '',
                });
            });
        } catch (error) {
            scanActive = false;
            closeScanModal();
            logDebug(`BLE Scan Error: ${error.message || error}`);
        }
    });

    // Cancel button stops scan and closes modal
    cancelBtn.addEventListener('click', async () => {
        if (scanActive) {
            try { await BleClient.stopLEScan(); } catch (_) {}
            scanActive = false;
        }
        closeScanModal();
        logDebug('BLE scan cancelled.');
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    disconnectBtn.addEventListener('click', async () => {
        if (connectedDeviceId && BleClient) {
            try {
                await BleClient.disconnect(connectedDeviceId);
            } catch (e) {
                logDebug(`Disconnect error: ${e.message || e}`);
            }
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
        command: '7',
        action:  'Stop Walking',
        // Matches explicit walking stop requests before the more general rest command.
        keywords: ['stop walking', 'stop walk', 'halt walking', 'halt walk'],
    },
    {
        command: '2',
        action:  'Rest',
        // Matches: "rest", "relax", "stop", "sleep", "idle", "chill", "pause", "halt"
        keywords: ['rest', 'relax', 'stop', 'sleep', 'idle', 'chill', 'pause', 'halt'],
    },
    {
        command: '4',
        action:  'Continuous Walk',
        // Matches walking requests without the explicit stop phrase.
        keywords: ['walk', 'walking', 'groove', 'move', 'shuffle'],
    },
    {
        command: '6',
        action:  'Dance',
        // Matches: "dance", "boogie", "jive", "spin"
        keywords: ['dance', 'boogie', 'jive', 'spin'],
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
                statusEl.textContent = `❌ NO MATCH — try: stand, sit, hello, rest, walk, stop, dance`;
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
