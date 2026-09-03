// === Uno R4 Robodog Hub ===
// Combines TWO roles on the SAME board over a SINGLE shared BLE connection:
//   1) Robodog servo controller  (stand/sit/hello/walk + manual joint tweaking)
//   2) Sensor hub                (local DHT11/MQ-gas/flame sensors + relayed IMU/etc.
//                                  data streamed in from a Nano over Serial1/UART)
//
// Both roles share ONE Nordic UART Service (NUS):
//   - rxChar  (write)  : commands coming IN from a phone/BLE terminal -> robot control
//   - txChar  (notify) : log messages AND sensor telemetry going OUT to the phone
//
// IMPORTANT: only one BLE service with these UUIDs may exist on the board - if you
// previously flashed the sensor-hub-only or robodog-only sketch separately, that's fine,
// this single sketch now replaces both.

#include "DHT.h"
#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// --- Hardware Pin Layout (sensor hub) ---
#define DHTPIN 3
#define DHTTYPE DHT11
#define MQ_ANALOG_PIN A0
#define MQ_DIGITAL_PIN 2
#define FLAME_DIGITAL_PIN 5

DHT dht(DHTPIN, DHTTYPE);
Adafruit_PWMServoDriver pca = Adafruit_PWMServoDriver();

// --- Shared BLE UART (Nordic UART Service) ---
BLEService uartService("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
BLEStringCharacteristic txChar("6E400003-B5A3-F393-E0A9-E50E24DCCA9E", BLERead | BLENotify, 256);
BLEStringCharacteristic rxChar("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", BLEWrite | BLEWriteWithoutResponse, 200);

BLEDevice central; // currently connected phone/tablet, if any

// --- Binary Payload Structure (for local USB serial debugging) ---
struct __attribute__((__packed__)) SensorPayload {
  uint8_t  header;
  uint16_t mqAnalog;
  uint8_t  mqDigital;
  int16_t  temperature;
  uint16_t humidity;
  uint16_t flameAnalog;
  uint8_t  checksum;
};

// --- Data relayed in from the Nano over Serial1 ---
float accelX = 0, accelY = 0, accelZ = 0;
float gyroX = 0, gyroY = 0, gyroZ = 0;
float magX = 0, magY = 0, magZ = 0;
float baroPressure = 0;
int colorR = 0, colorG = 0, colorB = 0;
int noiseLevel = 0;

const byte numChars = 200;
char receivedChars[numChars];
boolean newData = false;

// --- Uno R4 local sensor state ---
float currentTemp = 0.0;
float currentHumid = 0.0;
int currentGas = 0;
int currentFlame = 0;

// --- Timing control for local sensor polling ---
unsigned long previousMillis = 0;
const long localSensorInterval = 2000; // 2 seconds

// --- Servo control state (robodog) ---
// Safe limits matched to Arduino Uno's Servo.h (544us to 2400us)
#define SERVOMIN 111   // Safe pulse length for 0°
#define SERVOMAX 491   // Safe pulse length for 180°

bool isStanding = false;
bool isSitting = false;

// ==========================================
// LOGGING HELPERS (shared txChar: robot logs + telemetry)
// ==========================================
void bleNotify(const String &msg) {
  if (!central || !central.connected()) return;
  txChar.writeValue(msg);
}

void logPrintln(String msg) {
  Serial.println(msg);
  bleNotify(msg + "\n");
}

void logPrint(String msg) {
  Serial.print(msg);
  bleNotify(msg);
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200); // UART from Nano (RX Pin 0)

  pinMode(MQ_DIGITAL_PIN, INPUT);
  pinMode(FLAME_DIGITAL_PIN, INPUT_PULLUP);
  dht.begin();

  while (!Serial && millis() < 3000);

  Serial.println("\n--- Initiating Uno R4 Robodog Hub ---");

  // Initialize I2C for the PCA9685 servo driver (default I2C pins on Uno R4)
  Wire.begin();
  pca.begin();
  pca.setPWMFreq(50); // Standard analog servo frequency

  // --- Start BLE ---
  if (!BLE.begin()) {
    Serial.println("BLE Hardware: FAILED!");
    while (1);
  }

  BLE.setLocalName("RoboDog_Hub");
  BLE.setAdvertisedService(uartService);
  uartService.addCharacteristic(txChar);
  uartService.addCharacteristic(rxChar);
  BLE.addService(uartService);
  BLE.advertise();

  Serial.println("System Ready. Broadcasting as 'RoboDog_Hub'");

  rest(); // put the robodog in a known resting position on boot

  logPrintln("=== Uno R4 Robodog Hub Initialized ===");
  logPrintln("COMMAND OPTIONS:");
  logPrintln("1. Type '1' to execute STAND sequence.");
  logPrintln("2. Type '<KEYWORD> <ANGLE>' to tweak a joint (e.g., 'FRK 90').");
  logPrintln("Keywords: FLS, FLH, FLK, FRS, FRH, FRK, RLS, RLH, RLK, RRS, RRH, RRK");
}

void loop() {
  // Service the BLE stack: handles connect/disconnect events and delivers characteristic writes.
  BLE.poll();

  // Track the current central connection (used by bleNotify to know where to send output).
  BLEDevice connectedCentral = BLE.central();
  if (connectedCentral) {
    if (!central || central.address() != connectedCentral.address()) {
      central = connectedCentral;
      Serial.print("BLE Connected: ");
      Serial.println(central.address());
    }
  } else if (central && !central.connected()) {
    Serial.println("BLE Disconnected");
    central = BLEDevice();
  }

  // ---------------------------------------------
  // 1. ROBOT CONTROL: read commands from USB or BLE
  // ---------------------------------------------
  String input = "";
  bool inputReady = false;

  if (Serial.available()) {
    input = Serial.readStringUntil('\n');
    inputReady = true;
  } else if (rxChar.written()) {
    input = rxChar.value();
    inputReady = true;
  }

  input.trim();

  if (inputReady && input.length() > 0) {
    handleCommand(input);
  }

  // ---------------------------------------------
  // 2. SENSOR HUB: read incoming UART stream from Nano
  // ---------------------------------------------
  recvWithStartEndMarkers();

  if (newData == true) {
    parseData();
    newData = false;

    if (central && central.connected()) {
      char blePayload[256];
      // Append the Uno's local readings (T, H, Gas, Fire) to the Nano's payload
      snprintf(blePayload, sizeof(blePayload),
             "<A:%.2f,%.2f,%.2f|G:%.2f,%.2f,%.2f|M:%.2f,%.2f,%.2f|P:%.1f|C:%d,%d,%d|N:%d|T:%.1f|H:%.1f|Gas:%d|Fire:%d>",
             accelX, accelY, accelZ, gyroX, gyroY, gyroZ, magX, magY, magZ, baroPressure, colorR, colorG, colorB, noiseLevel,
             currentTemp, currentHumid, currentGas, currentFlame);

      txChar.writeValue(String(blePayload) + "\n");
    }
  }

  // ---------------------------------------------
  // 3. Evaluate local sensors (DHT, MQ, Flame) every 2 seconds
  // ---------------------------------------------
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= localSensorInterval) {
    previousMillis = currentMillis;

    currentGas = analogRead(MQ_ANALOG_PIN);
    currentFlame = digitalRead(FLAME_DIGITAL_PIN);

    float rawTemp = dht.readTemperature();
    float rawHumid = dht.readHumidity();

    if (!isnan(rawTemp) && !isnan(rawHumid)) {
      currentTemp = rawTemp;
      currentHumid = rawHumid;
    }

    SensorPayload packet;
    packet.header = 0xAA;
    packet.mqAnalog = currentGas;
    packet.mqDigital = (digitalRead(MQ_DIGITAL_PIN) == HIGH) ? 1 : 0;
    packet.flameAnalog = currentFlame;
    packet.temperature = (int16_t)(currentTemp * 100.0f);
    packet.humidity = (uint16_t)(currentHumid * 100.0f);

    uint8_t *bytePointer = (uint8_t*)&packet;
    uint8_t calculatedXor = 0;
    for (size_t i = 0; i < sizeof(SensorPayload) - 1; i++) calculatedXor ^= bytePointer[i];
    packet.checksum = calculatedXor;

    printDataInHumanReadable(packet);
  }
}

// ==========================================
// COMMAND ROUTER (robodog)
// ==========================================
void handleCommand(String input) {
  // === STUNT MODE ===
  if (input == "1") {
    standUp();
  }
  // === RESTING MODE ===
  else if (input == "2") {
    rest();
  }
  // === HELLO MODE ===
  else if (input == "3") {
    hello();
  }
  // === WALKING MODE ===
  else if (input == "4") {
    standUp();
    for (int i = 0; i < 4; i++) {
      walk();
    }
    standUp();
  }
  // === SITTING MODE ===
  else if (input == "5") {
    sit();
  }
  // === CALIBRATION MODE ===
  else {
    int spaceIndex = input.indexOf(' ');

    if (spaceIndex > 0) {
      String keyword = input.substring(0, spaceIndex);
      keyword.toUpperCase();

      int angle = input.substring(spaceIndex + 1).toInt();
      int channel = getChannelFromKeyword(keyword);

      if (channel != -1) {
        if (angle >= 0 && angle <= 180) {
          setServoAngle(channel, angle);
          logPrint("SUCCESS: Moved ");
          logPrint(keyword);
          logPrint(" (Ch ");
          logPrint(String(channel));
          logPrint(") to ");
          logPrint(String(angle));
          logPrintln(" degrees.");
        } else {
          logPrintln("ERROR: Angle must be between 0 and 180.");
        }
      } else {
        logPrintln("ERROR: Unknown keyword. Check your spelling (e.g., FRK).");
      }
    } else {
      logPrintln("ERROR: Invalid format. Use '1' to stand, or 'FRK 90' to tweak.");
    }

    isStanding = false; // Reset standing state after any manual adjustment
  }
}

// Helper function to map keywords to PCA9685 channels
int getChannelFromKeyword(String keyword) {
  // Front Left
  if (keyword == "FLS") return 2;
  if (keyword == "FLH") return 4;
  if (keyword == "FLK") return 0;

  // Front Right
  if (keyword == "FRS") return 3;
  if (keyword == "FRH") return 5;
  if (keyword == "FRK") return 1;

  // Rear Left
  if (keyword == "RLS") return 12;
  if (keyword == "RLH") return 10;
  if (keyword == "RLK") return 14;

  // Rear Right
  if (keyword == "RRS") return 13;
  if (keyword == "RRH") return 11;
  if (keyword == "RRK") return 15;

  return -1;
}

// Helper function to send the PWM pulse to the servo safely
void setServoAngle(uint8_t channel, int angle) {
  angle = constrain(angle, 0, 180);
  int pulse = map(angle, 0, 180, SERVOMIN, SERVOMAX);
  pca.setPWM(channel, 0, pulse);
}

// ==========================================
// STUNT FUNCTIONS (robodog)
// ==========================================

void standUp() {
  if (isStanding) {
    logPrintln("Already in a standing Position");
    return;
  }

  logPrintln("--- EXECUTING STUNT: STAND UP ---");

  if (isSitting) {
    setServoAngle(1, 180);  // FRK
    setServoAngle(0, 25);   // FLK
  }

  logPrintln("Phase 1: Adjusting Hips...");
  setServoAngle(10, 145); // RLH
  setServoAngle(11, 40);  // RRH
  setServoAngle(4, 85);   // FLH
  setServoAngle(5, 90);   // FRH
  delay(1000);

  logPrintln("Phase 2: Adjusting Shoulders...");
  setServoAngle(2, 135);  // FLS
  setServoAngle(3, 30);   // FRS
  setServoAngle(12, 135); // RLS
  setServoAngle(13, 70);  // RRS
  delay(1000);

  logPrintln("Phase 3: Adjusting Knee...");
  setServoAngle(14, 110); // RLK
  setServoAngle(15, 100); // RRK
  delay(500);
  setServoAngle(1, 105);  // FRK
  setServoAngle(0, 100);  // FLK
  delay(1000);

  isStanding = true;
  isSitting = false;

  logPrintln("--- STUNT COMPLETE: DOG IS STANDING ---");
  logPrintln("You can now enter '<KEYWORD> <ANGLE>' to tweak positions.");
}

void rest() {
  logPrintln("--- EXECUTING STUNT: RESTING ---");

  logPrintln("Phase 1: Adjusting Knee...");
  setServoAngle(14, 35);  // RLK
  setServoAngle(15, 175); // RRK
  setServoAngle(1, 180);  // FRK
  setServoAngle(0, 25);   // FLK
  delay(1000);

  logPrintln("Phase 2: Adjusting Shoulders...");
  setServoAngle(2, 180);  // FLS
  setServoAngle(3, 0);    // FRS
  setServoAngle(12, 180); // RLS
  setServoAngle(13, 35);  // RRS
  delay(1000);

  logPrintln("Phase 3: Adjusting Hips...");
  setServoAngle(4, 25);   // FLH
  setServoAngle(5, 140);  // FRH
  setServoAngle(10, 85);  // RLH
  setServoAngle(11, 90);  // RRH
  delay(1000);

  isStanding = false;
  isSitting = false;

  logPrintln("--- STUNT COMPLETE: DOG IS RESTING ---");
  logPrintln("You can now enter '<KEYWORD> <ANGLE>' to tweak positions.");
}

void hello() {
  logPrintln("--- EXECUTING STUNT: HELLO ---");
  if (!isSitting) {
    standUp();
    delay(1000);
  }

  logPrintln("Adjusting the Front.");
  setServoAngle(2, 145);  // FLS
  setServoAngle(3, 35);   // FRS
  setServoAngle(1, 110);  // FRK
  setServoAngle(0, 100);  // FLK
  setServoAngle(4, 95);   // FLH
  setServoAngle(5, 95);   // FRH
  delay(1000);

  logPrintln("Adjusting the Back.");
  setServoAngle(12, 150); // RLS
  setServoAngle(13, 60);  // RRS
  setServoAngle(14, 30);  // RLK
  setServoAngle(15, 180); // RRK
  setServoAngle(10, 150); // RLH
  setServoAngle(11, 30);  // RRH
  delay(1000);

  logPrintln("Doing High-five action.");
  setServoAngle(3, 150);  // FRS
  delay(2000);
  setServoAngle(3, 20);   // FRS
  delay(1000);

  logPrintln("Adjusting the Front.");
  setServoAngle(0, 25);   // FLK
  setServoAngle(1, 180);  // FRK

  isStanding = false;
  isSitting = false;

  sit();
}

void walk() {
  setServoAngle(0, 70);   // FLK
  setServoAngle(15, 130); // RRK

  delay(200);

  setServoAngle(3, 10);   // FRS
  setServoAngle(12, 160); // RLS

  setServoAngle(0, 100);  // FLK
  setServoAngle(15, 100); // RRK
  setServoAngle(2, 140);  // FLS
  setServoAngle(13, 70);  // RRS

  delay(200);

  setServoAngle(14, 80);  // RLK
  setServoAngle(1, 135);  // FRK

  delay(200);

  setServoAngle(2, 160);  // FLS
  setServoAngle(13, 50);  // RRS

  setServoAngle(3, 30);   // FRS
  setServoAngle(12, 140); // RLS
  setServoAngle(1, 105);  // FRK
  setServoAngle(14, 110); // RLK

  delay(200);

  isStanding = false;
  isSitting = false;
}

void sit() {
  if (!isSitting) {
    logPrintln("Adjusting the Front.");
    setServoAngle(2, 145);  // FLS
    setServoAngle(3, 10);   // FRS
    setServoAngle(1, 110);  // FRK
    setServoAngle(0, 100);  // FLK
    setServoAngle(4, 80);   // FLH
    setServoAngle(5, 95);   // FRH
    delay(1000);

    logPrintln("Adjusting the Back.");
    setServoAngle(12, 140); // RLS
    setServoAngle(13, 55);  // RRS
    setServoAngle(14, 30);  // RLK
    setServoAngle(15, 175); // RRK
    setServoAngle(10, 150); // RLH
    setServoAngle(11, 30);  // RRH
    delay(1000);
  } else {
    logPrintln("Already sitting.");
  }

  isStanding = false;
  isSitting = true;
}

// ==========================================
// UART READING & PARSING (sensor hub, from Nano)
// ==========================================
void recvWithStartEndMarkers() {
  static boolean recvInProgress = false;
  static byte ndx = 0;
  char startMarker = '<';
  char endMarker = '>';
  char rc;

  while (Serial1.available() > 0 && newData == false) {
    rc = Serial1.read();
    if (recvInProgress == true) {
      if (rc != endMarker) {
        receivedChars[ndx++] = rc;
        if (ndx >= numChars) ndx = numChars - 1;
      } else {
        receivedChars[ndx] = '\0';
        recvInProgress = false;
        ndx = 0;
        newData = true;
      }
    } else if (rc == startMarker) {
      recvInProgress = true;
    }
  }
}

void parseData() {
  char tempBuffer[numChars];
  strcpy(tempBuffer, receivedChars);
  char *strtokIndx = strtok(tempBuffer, ":|,");

  while (strtokIndx != NULL) {
    if (strcmp(strtokIndx, "A") == 0) {
      accelX = atof(strtok(NULL, ":|,")); accelY = atof(strtok(NULL, ":|,")); accelZ = atof(strtok(NULL, ":|,"));
    }
    else if (strcmp(strtokIndx, "G") == 0) {
      gyroX = atof(strtok(NULL, ":|,")); gyroY = atof(strtok(NULL, ":|,")); gyroZ = atof(strtok(NULL, ":|,"));
    }
    else if (strcmp(strtokIndx, "M") == 0) {
      magX = atof(strtok(NULL, ":|,")); magY = atof(strtok(NULL, ":|,")); magZ = atof(strtok(NULL, ":|,"));
    }
    else if (strcmp(strtokIndx, "P") == 0) baroPressure = atof(strtok(NULL, ":|,"));
    else if (strcmp(strtokIndx, "C") == 0) {
      colorR = atoi(strtok(NULL, ":|,")); colorG = atoi(strtok(NULL, ":|,")); colorB = atoi(strtok(NULL, ":|,"));
    }
    else if (strcmp(strtokIndx, "N") == 0) noiseLevel = atoi(strtok(NULL, ":|,"));
    strtokIndx = strtok(NULL, ":|,");
  }
}

void printDataInHumanReadable(SensorPayload p) {
  Serial.println("\n[ UNO R4 HUB TELEMETRY STREAM ]");
  Serial.print("DHT Temp: "); Serial.print(currentTemp); Serial.print(" °C | ");
  Serial.print("DHT Humid: "); Serial.print(currentHumid); Serial.println(" %");
  Serial.print("Gas Level: "); Serial.print(p.mqAnalog);
  Serial.print("Flame Sensor DO: "); Serial.print(p.flameAnalog);
  Serial.println(p.flameAnalog == LOW ? " [FLAME DETECTED!]" : " [Safe]");
}
