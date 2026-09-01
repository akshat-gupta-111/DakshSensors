#include "DHT.h"
#include <ArduinoBLE.h>

// --- Hardware Pin Layout ---
#define DHTPIN 3          
#define DHTTYPE DHT11     
#define MQ_ANALOG_PIN A0  
#define MQ_DIGITAL_PIN 2  
#define FLAME_ANALOG_PIN A1 

DHT dht(DHTPIN, DHTTYPE);

// --- BLE Settings (Nordic UART Service) ---
BLEService uartService("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"); 
BLEStringCharacteristic txChar("6E400003-B5A3-F393-E0A9-E50E24DCCA9E", BLERead | BLENotify, 256);
BLEStringCharacteristic rxChar("6E400002-B5A3-F393-E0A9-E50E24DCCA9E", BLEWrite | BLEWriteWithoutResponse, 256);

// --- Binary Payload Structure (For Local Serial Debugging) ---
struct __attribute__((__packed__)) SensorPayload {
  uint8_t  header;       
  uint16_t mqAnalog;     
  uint8_t  mqDigital;    
  int16_t  temperature;  
  uint16_t humidity;     
  uint16_t flameAnalog;  
  uint8_t  checksum;     
};

// --- Nano 33 BLE UART Variables ---
float accelX = 0, accelY = 0, accelZ = 0;
float gyroX = 0, gyroY = 0, gyroZ = 0;
float magX = 0, magY = 0, magZ = 0;
float baroPressure = 0;
int colorR = 0, colorG = 0, colorB = 0;
int noiseLevel = 0;

const byte numChars = 200;
char receivedChars[numChars];
boolean newData = false;

// --- Uno R4 Local Sensor State ---
float currentTemp = 0.0;
float currentHumid = 0.0;
int currentGas = 0;
int currentFlame = 0;

// --- Timing Control ---
unsigned long previousMillis = 0;
const long localSensorInterval = 2000; // 2 seconds

void setup() {
  Serial.begin(115200);  
  Serial1.begin(115200); // UART from Nano (RX Pin 0)
  
  pinMode(MQ_DIGITAL_PIN, INPUT);
  dht.begin();
  
  while (!Serial && millis() < 3000); 

  Serial.println("\n--- Initiating Uno R4 BLE Hub ---");

  if (!BLE.begin()) {
    Serial.println("BLE Hardware: FAILED!");
    while (1);
  }

  BLE.setLocalName("RoboDog_Hub"); // The new name for the Web Dashboard to find
  BLE.setAdvertisedService(uartService);
  uartService.addCharacteristic(txChar);
  uartService.addCharacteristic(rxChar);
  BLE.addService(uartService);
  BLE.advertise();

  Serial.println("System Ready. Broadcasting as 'RoboDog_Hub'");
}

void loop() {
  BLE.poll();

  // 1. Constantly read the incoming UART stream
  recvWithStartEndMarkers();
  
  // 2. If a packet arrives from the Nano, parse it AND broadcast the combined data via BLE
  if (newData == true) {
    parseData();
    newData = false;

    if (BLE.central()) {
      char blePayload[256];
      // We append the Uno's local readings (T, H, Gas, Fire) to the Nano's payload
      snprintf(blePayload, sizeof(blePayload), 
             "<A:%.2f,%.2f,%.2f|G:%.2f,%.2f,%.2f|M:%.2f,%.2f,%.2f|P:%.1f|C:%d,%d,%d|N:%d|T:%.1f|H:%.1f|Gas:%d|Fire:%d>", 
             accelX, accelY, accelZ, gyroX, gyroY, gyroZ, magX, magY, magZ, baroPressure, colorR, colorG, colorB, noiseLevel,
             currentTemp, currentHumid, currentGas, currentFlame);
      
      txChar.writeValue(String(blePayload) + "\n");
    }
  }

  // 3. Evaluate Local Sensors (DHT, MQ, Flame) every 2 seconds
  unsigned long currentMillis = millis();
  if (currentMillis - previousMillis >= localSensorInterval) {
    previousMillis = currentMillis;
    
    currentGas = analogRead(MQ_ANALOG_PIN);
    currentFlame = analogRead(FLAME_ANALOG_PIN);
    
    float rawTemp = dht.readTemperature();
    float rawHumid = dht.readHumidity();

    if (!isnan(rawTemp) && !isnan(rawHumid)) {
      currentTemp = rawTemp;
      currentHumid = rawHumid;
    }

    // Prepare and print the secure serial packet (your original logic)
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

// -----------------------------------------------------
// UART Reading & Parsing Functions
// -----------------------------------------------------
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
  Serial.print(" | Flame Intensity: "); Serial.print(p.flameAnalog);
  Serial.println(p.flameAnalog > 700 ? " [🔥 FLAME DETECTED!]" : " [✅ Safe]");
}