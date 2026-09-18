// === Uno R4 Robodog Hub (with Corrected IK Trot Gait) ===
// Combines TWO roles on the SAME board over a SINGLE shared BLE connection:
//   1) Robodog servo controller  (stand/sit/hello + IK WALK + manual joint tweaking)
//   2) Sensor hub                (local DHT11/MQ-gas/flame sensors + relayed IMU/etc.)

#include "DHT.h"
#include <ArduinoBLE.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <math.h> 

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

BLEDevice central;

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
float currentTemp = 0.0, currentHumid = 0.0;
int currentGas = 0, currentFlame = 0;

unsigned long previousMillis = 0;
const long localSensorInterval = 2000; 

// --- Servo control state (robodog) ---
#define SERVOMIN 111   
#define SERVOMAX 491   

bool isStanding = false;
bool isSitting = false;
bool isWalking = false; 

// ==========================================
// INVERSE KINEMATICS & GAIT PARAMETERS
// ==========================================
// Physical Dimensions (mm)
const float L_COXA = 35.0;   // Length from Hip pivot to Shoulder pivot (Body to Coxa)
const float L_FEMUR = 110.0; // Length from Shoulder pivot to Knee pivot (Coxa to Femur)
const float L_TIBIA = 135.0; // Length from Knee pivot to Foot tip (Femur to Tibia)

// Gait Configuration
const float STAND_HEIGHT = 210.0; // Lowered so knees can bend safely (not fully stretched)
const float STRIDE_LENGTH = 40.0; // SET TO 10 FOR SAFE TESTING (Change to 60+ later)
const float STEP_HEIGHT = 40.0;   // Z-height the foot lifts during swing
const unsigned long CYCLE_TIME = 1000; // 3 Seconds per step (Slow-motion for debugging)

// Servo Center Offsets (Your specific tuned angles)
int offsetS[4] = {110, 60, 110, 100};  // FLS, FRS, RLS, RRS
int offsetH[4] = {85, 90, 145, 40};    // FLH, FRH, RLH, RRH
int offsetK[4] = {150, 50, 165, 50};   // FLK, FRK, RLK, RRK

// Servo Direction Multipliers
int dirS[4] = {1, -1, 1, -1}; // Flip these if the leg swings the wrong way when walking!
int dirH[4] = {1, -1, 1, -1};
int dirK[4] = {-1, 1, -1, 1};

// ==========================================
// LOGGING HELPERS
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
  Serial1.begin(115200); 

  pinMode(MQ_DIGITAL_PIN, INPUT);
  pinMode(FLAME_DIGITAL_PIN, INPUT_PULLUP);
  dht.begin();

  while (!Serial && millis() < 3000);

  Wire.begin();
  pca.begin();
  pca.setPWMFreq(50); 

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

  rest(); 

  logPrintln("=== Uno R4 Robodog Hub (IK Enabled) ===");
  logPrintln("1: STAND | 2: REST | 3: HELLO | 4: TOGGLE WALK | 5: SIT");
}

void loop() {
  BLE.poll();
  BLEDevice connectedCentral = BLE.central();
  if (connectedCentral) {
    if (!central || central.address() != connectedCentral.address()) {
      central = connectedCentral;
      Serial.println("BLE Connected");
    }
  } else if (central && !central.connected()) {
    central = BLEDevice();
  }

  // 1. COMMAND ROUTER
  String input = "";
  if (Serial.available()) input = Serial.readStringUntil('\n');
  else if (rxChar.written()) input = rxChar.value();

  input.trim();
  if (input.length() > 0) handleCommand(input);

  // 2. SENSOR HUB
  recvWithStartEndMarkers();
  if (newData) {
    parseData();
    newData = false;
    if (central && central.connected()) {
      char blePayload[256];
      snprintf(blePayload, sizeof(blePayload),
             "<A:%.2f,%.2f,%.2f|G:%.2f,%.2f,%.2f|M:%.2f,%.2f,%.2f|P:%.1f|C:%d,%d,%d|N:%d|T:%.1f|H:%.1f|Gas:%d|Fire:%d>",
             accelX, accelY, accelZ, gyroX, gyroY, gyroZ, magX, magY, magZ, baroPressure, colorR, colorG, colorB, noiseLevel,
             currentTemp, currentHumid, currentGas, currentFlame);
      txChar.writeValue(String(blePayload) + "\n");
    }
  }

  // 3. LOCAL SENSORS 
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= localSensorInterval) {
    previousMillis = currentMillis;
    currentGas = analogRead(MQ_ANALOG_PIN);
    currentFlame = digitalRead(FLAME_DIGITAL_PIN);
    float rawTemp = dht.readTemperature();
    float rawHumid = dht.readHumidity();
    if (!isnan(rawTemp) && !isnan(rawHumid)) { currentTemp = rawTemp; currentHumid = rawHumid; }
  }

  // 4. NON-BLOCKING WALKING GAIT
  if (isWalking) {
    updateWalkingGait();
  }
}

// ==========================================
// COMMAND ROUTER
// ==========================================
void handleCommand(String input) {
  if (input != "4") isWalking = false; 

  if (input == "1") standUp();
  else if (input == "2") rest();
  else if (input == "3") hello();
  else if (input == "4") {
    isWalking = !isWalking;
    if (isWalking) {
      standUp();
      logPrintln("Standing... Wait 1.5 seconds...");
      delay(1500); // Wait for stand to finish before stepping
      logPrintln("Started IK Walking. Send '4' again to stop.");
    } else {
      logPrintln("Stopped walking.");
      standUp(); 
    }
  }
  else if (input == "5") sit();
  else {
    int spaceIndex = input.indexOf(' ');
    if (spaceIndex > 0) {
      String keyword = input.substring(0, spaceIndex);
      keyword.toUpperCase();
      int angle = input.substring(spaceIndex + 1).toInt();
      int channel = getChannelFromKeyword(keyword);
      if (channel != -1) setServoAngle(channel, angle);
    }
  }
}

// ==========================================
// INVERSE KINEMATICS & GAIT LOGIC
// ==========================================

void applyIK(int legIndex, float x, float y, float z) {
  float L = sqrt(y*y + z*z);
  float theta1 = atan2(y, z); 
  float Z_prime = sqrt(L*L - L_COXA*L_COXA); 
  float D = sqrt(x*x + Z_prime*Z_prime);
  
  if (D > (L_FEMUR + L_TIBIA)) D = L_FEMUR + L_TIBIA - 0.1; 

  float cosTheta3 = (D*D - L_FEMUR*L_FEMUR - L_TIBIA*L_TIBIA) / (2 * L_FEMUR * L_TIBIA);
  float theta3 = acos(cosTheta3); 

  float alpha = atan2(x, Z_prime);
  float beta = acos((L_FEMUR*L_FEMUR + D*D - L_TIBIA*L_TIBIA) / (2 * L_FEMUR * D));
  float theta2 = alpha + beta; 

  // SWAPPED MATH TO MATCH YOUR PHYSICAL BUILD:
  // theta1 = Side-to-side spread (Routed to your physical Hip)
  // theta2 = Forward/backward swing (Routed to your physical Shoulder)
  float degH = theta1 * 180.0 / PI; 
  float degS = theta2 * 180.0 / PI; 
  float degK = theta3 * 180.0 / PI;

  int finalS = offsetS[legIndex] + (degS * dirS[legIndex]);
  int finalH = offsetH[legIndex] + (degH * dirH[legIndex]);
  int finalK = offsetK[legIndex] + (degK * dirK[legIndex]);

  int chS, chH, chK;
  if(legIndex == 0) { chS = 2; chH = 4; chK = 0; }        // FL
  else if(legIndex == 1) { chS = 3; chH = 5; chK = 1; }   // FR
  else if(legIndex == 2) { chS = 12; chH = 10; chK = 14; }// RL
  else { chS = 13; chH = 11; chK = 15; }                  // RR

  setServoAngle(chS, finalS);
  setServoAngle(chH, finalH);
  setServoAngle(chK, finalK);
}

void updateWalkingGait() {
  unsigned long timeStr = millis() % CYCLE_TIME;
  float phase = (float)timeStr / (float)CYCLE_TIME; 

  float phasePair1 = phase;
  float phasePair2 = phase + 0.5;
  if (phasePair2 >= 1.0) phasePair2 -= 1.0;

  float legPhases[4] = {phasePair1, phasePair2, phasePair2, phasePair1};

  for (int i = 0; i < 4; i++) {
    float x = 0;
    float z = STAND_HEIGHT;
    float y = 0; 
    float p = legPhases[i];
    
    if (p < 0.5) {
      float swingP = p * 2.0; 
      x = (STRIDE_LENGTH / 2.0) - (STRIDE_LENGTH * swingP); 
      z = STAND_HEIGHT - (STEP_HEIGHT * sin(swingP * PI));  
    } else {
      float stanceP = (p - 0.5) * 2.0;
      x = -(STRIDE_LENGTH / 2.0) + (STRIDE_LENGTH * stanceP); 
      z = STAND_HEIGHT; 
    }
    
    applyIK(i, x, y, z);
  }
}

// ==========================================
// UTILITY & RESTORED STUNTS 
// ==========================================
int getChannelFromKeyword(String keyword) {
  if (keyword == "FLS") return 2; if (keyword == "FLH") return 4; if (keyword == "FLK") return 0;
  if (keyword == "FRS") return 3; if (keyword == "FRH") return 5; if (keyword == "FRK") return 1;
  if (keyword == "RLS") return 12; if (keyword == "RLH") return 10; if (keyword == "RLK") return 14;
  if (keyword == "RRS") return 13; if (keyword == "RRH") return 11; if (keyword == "RRK") return 15;
  return -1;
}

void setServoAngle(uint8_t channel, int angle) {
  angle = constrain(angle, 0, 180);
  int pulse = map(angle, 0, 180, SERVOMIN, SERVOMAX);
  pca.setPWM(channel, 0, pulse);
}

void standUp() {
  if (isStanding) { logPrintln("Already standing."); return; }
  logPrintln("--- EXECUTING STUNT: STAND UP ---");
  if (isSitting) { setServoAngle(1, 180); setServoAngle(0, 25); }
  logPrintln("Phase 1: Adjusting Hips...");
  setServoAngle(10, 145); setServoAngle(11, 40); setServoAngle(4, 85); setServoAngle(5, 90); delay(1000);
  logPrintln("Phase 2: Adjusting Shoulders...");
  setServoAngle(2, 135); setServoAngle(3, 30); setServoAngle(12, 135); setServoAngle(13, 70); delay(1000);
  logPrintln("Phase 3: Adjusting Knee...");
  setServoAngle(14, 110); setServoAngle(15, 100); delay(500);
  setServoAngle(1, 105); setServoAngle(0, 100); delay(1000);
  isStanding = true; isSitting = false;
}

void rest() {
  logPrintln("--- EXECUTING STUNT: RESTING ---");
  logPrintln("Phase 1: Adjusting Knee...");
  setServoAngle(14, 35); setServoAngle(15, 175); setServoAngle(1, 180); setServoAngle(0, 25); delay(1000);
  logPrintln("Phase 2: Adjusting Shoulders...");
  setServoAngle(2, 180); setServoAngle(3, 0); setServoAngle(12, 180); setServoAngle(13, 35); delay(1000);
  logPrintln("Phase 3: Adjusting Hips...");
  setServoAngle(4, 25); setServoAngle(5, 140); setServoAngle(10, 85); setServoAngle(11, 90); delay(1000);
  isStanding = false; isSitting = false;
}

void hello() {
  logPrintln("--- EXECUTING STUNT: HELLO ---");
  if (!isSitting) { standUp(); delay(1000); }
  logPrintln("Adjusting the Front.");
  setServoAngle(2, 145); setServoAngle(3, 35); setServoAngle(1, 110); setServoAngle(0, 100); setServoAngle(4, 95); setServoAngle(5, 95); delay(1000);
  logPrintln("Adjusting the Back.");
  setServoAngle(12, 150); setServoAngle(13, 60); setServoAngle(14, 30); setServoAngle(15, 180); setServoAngle(10, 150); setServoAngle(11, 30); delay(1000);
  logPrintln("Doing High-five action.");
  setServoAngle(3, 150); delay(2000); setServoAngle(3, 20); delay(1000);
  logPrintln("Adjusting the Front.");
  setServoAngle(0, 25); setServoAngle(1, 180);
  isStanding = false; isSitting = false;
  sit();
}

void sit() {
  if (!isSitting) {
    logPrintln("Adjusting the Front.");
    setServoAngle(2, 145); setServoAngle(3, 10); setServoAngle(1, 110); setServoAngle(0, 100); setServoAngle(4, 80); setServoAngle(5, 95); delay(1000);
    logPrintln("Adjusting the Back.");
    setServoAngle(12, 140); setServoAngle(13, 55); setServoAngle(14, 30); setServoAngle(15, 175); setServoAngle(10, 150); setServoAngle(11, 30); delay(1000);
  } else { logPrintln("Already sitting."); }
  isStanding = false; isSitting = true;
}

void recvWithStartEndMarkers() {
  static boolean recvInProgress = false; static byte ndx = 0; char startMarker = '<'; char endMarker = '>'; char rc;
  while (Serial1.available() > 0 && newData == false) {
    rc = Serial1.read();
    if (recvInProgress == true) {
      if (rc != endMarker) { receivedChars[ndx++] = rc; if (ndx >= numChars) ndx = numChars - 1; } 
      else { receivedChars[ndx] = '\0'; recvInProgress = false; ndx = 0; newData = true; }
    } else if (rc == startMarker) { recvInProgress = true; }
  }
}

void parseData() {
  char tempBuffer[numChars]; strcpy(tempBuffer, receivedChars);
  char *strtokIndx = strtok(tempBuffer, ":|,");
  while (strtokIndx != NULL) {
    if (strcmp(strtokIndx, "A") == 0) { accelX = atof(strtok(NULL, ":|,")); accelY = atof(strtok(NULL, ":|,")); accelZ = atof(strtok(NULL, ":|,")); }
    else if (strcmp(strtokIndx, "G") == 0) { gyroX = atof(strtok(NULL, ":|,")); gyroY = atof(strtok(NULL, ":|,")); gyroZ = atof(strtok(NULL, ":|,")); }
    else if (strcmp(strtokIndx, "M") == 0) { magX = atof(strtok(NULL, ":|,")); magY = atof(strtok(NULL, ":|,")); magZ = atof(strtok(NULL, ":|,")); }
    else if (strcmp(strtokIndx, "P") == 0) baroPressure = atof(strtok(NULL, ":|,"));
    else if (strcmp(strtokIndx, "C") == 0) { colorR = atoi(strtok(NULL, ":|,")); colorG = atoi(strtok(NULL, ":|,")); colorB = atoi(strtok(NULL, ":|,")); }
    else if (strcmp(strtokIndx, "N") == 0) noiseLevel = atoi(strtok(NULL, ":|,"));
    strtokIndx = strtok(NULL, ":|,");
  }
}