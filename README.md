# Multi-Sensor Central IoT Hub (RoboDog Telemetry)

A robust, multi-rate data collection and streaming system designed to link an **Arduino Nano 33 BLE Sense** and an **Arduino Uno R4 WiFi** into a unified industrial sensor hub. 

The system tracks motion, environmental conditions, ambient sound levels, and emergency safety hazards (gas/fire leaks) in real-time, streaming the combined data over **Bluetooth Low Energy (BLE)** directly to a responsive web application dashboard.

## 🚀 Purpose of the Repository
The purpose of this repository is to decouple high-frequency edge sensing from communication tasks, maximizing processing stability across complex microcontrollers. 

Instead of forcing a single board to manage dozens of demanding sensor cycles alongside a wireless radio stack, this architecture creates a reliable two-stage sensor pipeline:
* **The Nano 33 BLE Sense** acts exclusively as a high-speed sensor pod, capturing embedded physics readings and piping them down a dedicated hardware UART bus.
* **The Uno R4 WiFi** acts as the Central Gatekeeper. It manages slower hazard-detection sensors (Gas, Climate, Flame), non-blockingly captures the incoming stream from the Nano, builds a unified zero-corruption payload structure, and handles the live BLE dashboard pipeline.
* **The Web Dashboard** catches this custom character stream on the client side using the standard browser Web Bluetooth API, parsing and visually rendering the complete telemetric landscape.

---

## 📂 Repository Contents

This repository contains all the production-ready source code files required to build, flash, and launch this project:

1. **`Nano_33_Sensor_Pod.ino`**: The streamlined firmware for the Nano 33 BLE Sense that strips away heavy radio processes to capture pure IMU, barometric pressure, color spectra, and microphone arrays at a throttled 5Hz frequency.
2. **`Uno_R4_Central_Hub.ino`**: The core non-blocking master program for the Uno R4 WiFi. It reads the directly attached external hazard sensors, synchronizes incoming wire packets from the Nano, filters out data corruptions automatically, and serves the BLE broadcast layer.
3. **`index.html`**: A fully functional, responsive HTML5/CSS3/JavaScript web application dashboard. It uses native browser Bluetooth hooks to discover, connect to, parse, and live-render the complete sensor payload stream.

---

## 🛠️ System Hardware Architecture

The microcontrollers communicate safely across a one-way high-speed serial data link:
* **Nano 33 BLE Sense `TX1`** ──► **Arduino Uno R4 WiFi `Pin 0 (RX1)`**
* **Nano 33 BLE Sense `GND`** ──► **Arduino Uno R4 WiFi `GND`** *(Common Ground Required)*

### External Sensors Mounted Directly to the Uno R4:
* **MQ Gas Sensor:** `A0` (Analog Data Stream), `D2` (Digital High Threshold Alert)
* **Flame Photodiode:** `A1` (Wired using a 10kΩ pull-down voltage divider circuit)
* **DHT11 Sensor:** `D3` (Single-bus digital temperature and humidity data)

---

## 📦 Data Payload Structure
Data is broadcast across Bluetooth at a stable **5Hz (every 200ms)** rate using a strict structural wrapper format to guarantee absolute packet alignment:

```text
<[AX],[AY],[AZ]|[GX],[GY],[GZ]|[MX],[MY],[MZ]|[PRES]|[R],[G],[B]|[MIC]|EXT:[MQ_A],[MQ_D],[FLAME],[TEMP],[HUMID]>
```

| Data Block | Parameter Breakdown |
| :--- | :--- |
| **IMU / Physics** | Accelerometer (X,Y,Z), Gyroscope (X,Y,Z), Magnetometer (X,Y,Z) |
| **Environment** | Barometric Pressure, Sound Noise Level, Ambient Color (R,G,B) |
| **EXT / Hazards** | MQ Analog Gas Level, MQ Digital Alarm flag, Flame Infrared Value, DHT11 Temperature, DHT11 Humidity |

---

## ⚙️ Quickstart Deployment
1. Open and flash `Nano_33_Sensor_Pod.ino` to your edge pod board.
2. Open and flash `Uno_R4_Central_Hub.ino` to your master Uno R4 board.
3. Wire the boards together according to the hardware layout and apply power.
4. Launch `index.html` inside any modern web browser (Google Chrome or Microsoft Edge).
5. Click **CONNECT VIA BLE**, select your `RoboDog_R4_Hub` node from the popup pairing modal window, and watch your telemetry dashboard come to life.
