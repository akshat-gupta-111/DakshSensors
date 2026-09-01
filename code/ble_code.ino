#include <Arduino_LSM9DS1.h>       // IMU
#include <Arduino_LPS22HB.h>       // Pressure
#include <Arduino_APDS9960.h>      // Color
#include <PDM.h>                   // Microphone

// Microphone Buffer
short sampleBuffer[256];
volatile int samplesRead;
int micLevel = 0;

// Multi-Rate Timers
unsigned long previousMillisFast = 0;
unsigned long previousMillisSlow = 0;
const long fastInterval = 50;   // 20Hz (Motion)
const long slowInterval = 1000; // 1Hz (Environmentals)

float pres = 0;
int r = 0, g = 0, b = 0, c = 0;
float ax = 0, ay = 0, az = 0;
float gx = 0, gy = 0, gz = 0;
float mx = 0, my = 0, mz = 0;

void onPDMdata() {
  int bytesAvailable = PDM.available();
  PDM.read(sampleBuffer, bytesAvailable);
  samplesRead = bytesAvailable / 2;
}

void setup() {
  Serial1.begin(115200); // Hardware UART to Uno R4
  
  IMU.begin();
  BARO.begin();
  APDS.begin();
  
  PDM.onReceive(onPDMdata);
  PDM.begin(1, 16000);
}

void loop() {
  unsigned long currentMillis = millis();
  
  // SLOW LOOP (Pressure & Color)
  if (currentMillis - previousMillisSlow >= slowInterval) {
    previousMillisSlow = currentMillis;
    pres = BARO.readPressure();
    if (APDS.colorAvailable()) APDS.readColor(r, g, b, c);
  }

  // FAST LOOP (Motion & Audio)
  if (currentMillis - previousMillisFast >= fastInterval) {
    previousMillisFast = currentMillis;
    
    if (IMU.accelerationAvailable()) IMU.readAcceleration(ax, ay, az);
    if (IMU.gyroscopeAvailable()) IMU.readGyroscope(gx, gy, gz);
    if (IMU.magneticFieldAvailable()) IMU.readMagneticField(mx, my, mz);
    
    if (samplesRead) {
      long sum = 0;
      for (int i = 0; i < samplesRead; i++) sum += abs(sampleBuffer[i]);
      micLevel = sum / samplesRead;
      samplesRead = 0;
    }

    // Package and Send
    char payload[200];
    snprintf(payload, sizeof(payload), 
             "<A:%.2f,%.2f,%.2f|G:%.2f,%.2f,%.2f|M:%.2f,%.2f,%.2f|P:%.1f|C:%d,%d,%d|N:%d>", 
             ax, ay, az, gx, gy, gz, mx, my, mz, pres, r, g, b, micLevel);
    
    Serial1.println(payload); 
  }
}