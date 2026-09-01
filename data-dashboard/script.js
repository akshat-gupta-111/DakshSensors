// --- BLE Service & Characteristic UUIDs (Nordic UART Service) ---
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let bluetoothDevice = null;
let bleBuffer = ""; // Accumulator for fragmented BLE packets

// --- Chart Data Globals (Rolling Window of 30) ---
const MAX_POINTS = 30;
let timeLabels = Array(MAX_POINTS).fill('');

let ax = Array(MAX_POINTS).fill(0), ay = Array(MAX_POINTS).fill(0), az = Array(MAX_POINTS).fill(0);
let gx = Array(MAX_POINTS).fill(0), gy = Array(MAX_POINTS).fill(0), gz = Array(MAX_POINTS).fill(0);

let accelChart = null;
let gyroChart = null;

// --- Logger Helper ---
function logDebug(message) {
    const consoleElem = document.getElementById('debugLog');
    if (consoleElem) {
        consoleElem.textContent += `\n[${new Date().toLocaleTimeString()}] ${message}`;
        consoleElem.scrollTop = consoleElem.scrollHeight;
    }
    console.log(message);
}

// --- Initialize Charts Safely ---
function initCharts() {
    if (typeof Chart === 'undefined') {
        logDebug("Warning: Chart.js library not loaded yet.");
        return;
    }

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
                    { label: 'Pitch (X)', data: gx, borderColor: '#ef4444', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Roll (Y)', data: gy, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Yaw (Z)', data: gz, borderColor: '#0ea5e9', borderWidth: 2, pointRadius: 0, tension: 0.2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, animation: false }
        });
    }
}

// --- DOM Content Loaded Setup ---
document.addEventListener('DOMContentLoaded', () => {
    initCharts();

    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const statusBadge = document.getElementById('statusBadge');

    if (!navigator.bluetooth) {
        logDebug("ERROR: Web Bluetooth API is not supported in this browser. Use Chrome, Edge, or Opera.");
        alert("Web Bluetooth API is not supported in this browser. Please use Chrome, Edge, or Opera.");
        return;
    }

    // --- BLE Connection Logic ---
    connectBtn.addEventListener('click', async () => {
        logDebug("Initiating BLE device scan...");
        try {
            try {
                bluetoothDevice = await navigator.bluetooth.requestDevice({
                    filters: [
                        { name: 'RoboDog_Hub' },
                        { services: [SERVICE_UUID] }
                    ],
                    optionalServices: [SERVICE_UUID]
                });
            } catch (filterErr) {
                logDebug("Filtered scan failed or was cancelled. Retrying with acceptAllDevices...");
                bluetoothDevice = await navigator.bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: [SERVICE_UUID]
                });
            }

            logDebug(`Device selected: ${bluetoothDevice.name || 'Unnamed Device'}`);

            bluetoothDevice.addEventListener('gattserverdisconnected', () => {
                logDebug("Device disconnected!");
                statusBadge.textContent = "DISCONNECTED";
                statusBadge.className = "badge disconnected";
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
            });

            logDebug("Connecting to GATT Server...");
            const server = await bluetoothDevice.gatt.connect();

            logDebug("Retrieving Nordic UART Service...");
            const service = await server.getPrimaryService(SERVICE_UUID);

            logDebug("Retrieving TX Characteristic...");
            const characteristic = await service.getCharacteristic(TX_CHARACTERISTIC_UUID);

            logDebug("Subscribing to notifications...");
            await characteristic.startNotifications();
            characteristic.addEventListener('characteristicvaluechanged', handleIncomingData);

            logDebug(">> CONNECTED AND RECEIVING TELEMETRY <<");
            statusBadge.textContent = "CONNECTED";
            statusBadge.className = "badge connected";
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;

        } catch (error) {
            logDebug(`BLE Error: ${error.message || error}`);
            console.error("BLE Connection Error: ", error);
        }
    });

    disconnectBtn.addEventListener('click', () => {
        if (bluetoothDevice && bluetoothDevice.gatt.connected) {
            logDebug("Disconnecting user request...");
            bluetoothDevice.gatt.disconnect();
        }
    });
});

// --- Incoming Data Buffer & Reassembly ---
function handleIncomingData(event) {
    const decoder = new TextDecoder('utf-8');
    const newChunk = decoder.decode(event.target.value);
    
    bleBuffer += newChunk;

    const packetRegex = /<([^>]+)>/g;
    let match;

    while ((match = packetRegex.exec(bleBuffer)) !== null) {
        const payload = match[1];
        parseAndDisplayPacket(payload);
    }

    const lastIndex = bleBuffer.lastIndexOf('>');
    if (lastIndex !== -1) {
        bleBuffer = bleBuffer.substring(lastIndex + 1);
    }
}

// --- Data Parsing & UI Update ---
function parseAndDisplayPacket(payload) {
    // Expected payload: A:0.0,0.0,0.0|G:0.0,0.0,0.0|M:0.0,0.0,0.0|P:98.0|C:10,20,30|N:50
    const sections = payload.split('|');
    const data = {};

    sections.forEach(sec => {
        const parts = sec.split(':');
        if (parts.length === 2) {
            data[parts[0]] = parts[1].split(',').map(Number);
        }
    });

    updateDashboard(data);
}

function updateDashboard(data) {
    // Update Uno R4 Environmentals
    if (data.T) {
        document.getElementById('val-temp').innerText = `${data.T[0].toFixed(1)} °C`;
        const tempPct = Math.min(Math.max((data.T[0] / 50) * 100, 0), 100);
        document.getElementById('bar-temp').style.width = `${tempPct}%`;
    }
    if (data.H) {
        document.getElementById('val-hum').innerText = `${data.H[0].toFixed(1)} %`;
        document.getElementById('bar-hum').style.width = `${data.H[0]}%`;
    }

    // Update Uno R4 Gas & Flame
    // Update Uno R4 Gas & Flame
    if (data.Gas) {
        const gasLvl = data.Gas[0];
        
        // ---> SET YOUR CUSTOM THRESHOLD HERE <---
        const GAS_THRESHOLD = 250; 
        
        const gasVal = document.getElementById('val-gas');
        const gasMsg = document.getElementById('val-gas-msg');
        const gasBar = document.getElementById('bar-gas');
        const gasCard = document.getElementById('gas-card');

        // Map raw 0-1023 analog value to a 0-100 percentage for the progress bar
        const gasPct = Math.min((gasLvl / 1023) * 100, 100);
        gasBar.style.width = `${gasPct}%`;
        
        // Display the raw number
        gasVal.innerText = gasLvl;

        // Threshold Logic
        if (gasLvl > GAS_THRESHOLD) {
            gasMsg.innerText = "⚠️ Unwanted Gas Detected!";
            gasMsg.style.color = "#ef4444"; // Red text
            gasVal.style.color = "#ef4444"; 
            gasBar.style.background = "#ef4444"; // Red bar
            gasCard.style.borderColor = "#ef4444"; // Highlight the card border
        } else {
            gasMsg.innerText = "✅ Normal";
            gasMsg.style.color = "#10b981"; // Green text
            gasVal.style.color = "#e2e8f0"; // Default white text
            gasBar.style.background = "#0ea5e9"; // Default blue bar
            gasCard.style.borderColor = "#272c36"; // Default border
        }
    }

    if (data.Fire) {
        const flameLvl = data.Fire[0];
        const flameCard = document.getElementById('flame-card');
        document.getElementById('val-flame-raw').innerText = `Intensity: ${flameLvl}`;
        
        if (flameLvl > 700) {
            document.getElementById('val-flame').innerText = "🔥 WARNING";
            document.getElementById('val-flame').style.color = "#ef4444";
            flameCard.style.borderColor = "#ef4444";
        } else {
            document.getElementById('val-flame').innerText = "✅ SAFE";
            document.getElementById('val-flame').style.color = "#10b981";
            flameCard.style.borderColor = "#272c36";
        }
    }
    // 1. Update rolling charts (Accel & Gyro)
    if (data.A && accelChart) updateArray(ax, ay, az, data.A, accelChart);
    if (data.G && gyroChart) updateArray(gx, gy, gz, data.G, gyroChart);

    // 2. Update Pressure
    if (data.P && !isNaN(data.P[0])) {
        document.getElementById('val-pres').innerText = `${data.P[0].toFixed(1)} kPa`;
    }

    // 3. Update RGB
    if (data.C && data.C.length === 3) {
        const [r, g, b] = data.C;
        const cssR = Math.min(r * 2, 255); 
        const cssG = Math.min(g * 2, 255);
        const cssB = Math.min(b * 2, 255);
        document.getElementById('val-color-box').style.backgroundColor = `rgb(${cssR}, ${cssG}, ${cssB})`;
        document.getElementById('val-rgb-text').innerText = `R:${r} G:${g} B:${b}`;
    }

    // 4. Update Compass (Magnetometer)
    if (data.M && data.M.length >= 2) {
        let heading = Math.atan2(data.M[1], data.M[0]) * (180 / Math.PI);
        if (heading < 0) heading += 360;
        
        const dial = document.getElementById('compass-dial');
        if (dial) dial.style.transform = `rotate(${heading}deg)`;
        document.getElementById('val-mag').innerText = `Heading: ${heading.toFixed(0)}°`;
    }

    // 5. Update Audio VU Meter
    if (data.N && !isNaN(data.N[0])) {
        const noiseLvl = data.N[0];
        const heightPct = Math.min((noiseLvl / 150) * 100, 100);
        const vuMeter = document.getElementById('vu-meter');
        if (vuMeter) vuMeter.style.height = `${heightPct}%`;
        document.getElementById('val-noise').innerText = `Amplitude: ${noiseLvl}`;
    }
}

// Helper: Push new xyz values into arrays, remove oldest, and update chart
function updateArray(arrX, arrY, arrZ, newValues, chartRef) {
    if (newValues.length < 3) return;
    arrX.push(newValues[0]); arrX.shift();
    arrY.push(newValues[1]); arrY.shift();
    arrZ.push(newValues[2]); arrZ.shift();
    chartRef.update();
}