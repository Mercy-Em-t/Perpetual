// ============================================================================
// Savannah Smart Pump Controller — Arduino / ESP32 Implementation
// Architecture: 4x1 Multiplexer Decision Engine + Physical Sensors + Safety Guards
// Target Hardware: Arduino Uno / Nano / Mega / ESP32
// ============================================================================

#include <Arduino.h>

// ---------------------------------------------------------------------------
// 1. PIN DEFINITIONS (Configurable to your board wiring)
// ---------------------------------------------------------------------------
const int PIN_PUMP_RELAY       = 8;   // Digital Output to Pump Relay Module (Active LOW or HIGH)
const int PIN_STATUS_LED       = 13;  // Onboard LED indicator

// Sensor Input Pins
const int PIN_SOIL_MOISTURE    = A0;  // Analogue pin: Capacitive / Resistive Soil Sensor
const int PIN_WATER_LEVEL      = A1;  // Analogue pin: Ultrasonic Echo / Float / Hydrostatic Sensor
const int PIN_LDR_LIGHT        = A2;  // Analogue pin: Photoresistor / Solar Cell (Day vs Night)
const int PIN_TEMP_SENSOR      = A3;  // Analogue pin: LM35 / NTC Thermistor / DHT Pin

// Physical Push-Button / Toggle Overrides
const int PIN_OVERRIDE_OFF     = 2;   // Emergency Physical Kill-Switch (Pull-up)
const int PIN_OVERRIDE_ON      = 3;   // Manual Physical Force-Run Button (Pull-up)

// Relay Logic Configuration
// Most Arduino 5V relay modules trigger on LOW (0V). Set false if your relay is Active HIGH.
const bool RELAY_ACTIVE_LOW    = true; 

// ---------------------------------------------------------------------------
// 2. SAFETY & CALIBRATION THRESHOLDS
// ---------------------------------------------------------------------------
const int THRESHOLD_DAY_LIGHT       = 450;  // LDR reading >= 450 means Daytime
const int THRESHOLD_TANK_CRITICAL   = 250;  // Water level reading < 250 means Tank Critical Emergency
const int THRESHOLD_TEMP_HOT        = 580;  // Reading representing > 28°C on analogue sensor
const int THRESHOLD_SOIL_DRY        = 600;  // Reading representing dry soil (needs water)

// Motor Burnout Protection Constants (Milliseconds)
const unsigned long MAX_RUN_TIME_MS = 25UL * 60UL * 1000UL; // Max 25 mins continuous run
const unsigned long MIN_REST_TIME_MS = 10UL * 60UL * 1000UL; // Min 10 mins cool-down rest
const unsigned long SENSOR_POLL_MS  = 2000UL;               // Read sensors every 2 seconds

// ---------------------------------------------------------------------------
// 3. SYSTEM STATE VARIABLES
// ---------------------------------------------------------------------------
bool pumpIsRunning = false;
unsigned long pumpStartTime = 0;
unsigned long pumpStopTime  = 0;
unsigned long lastSensorPoll = 0;

enum SystemOverrideMode {
  MODE_AUTO,
  MODE_FORCE_OFF,
  MODE_FORCE_ON
};
SystemOverrideMode currentOverride = MODE_AUTO;

// ---------------------------------------------------------------------------
// 4. LOW-LEVEL RELAY DRIVER
// ---------------------------------------------------------------------------
void setRelay(bool turnOn) {
  if (turnOn) {
    digitalWrite(PIN_PUMP_RELAY, RELAY_ACTIVE_LOW ? LOW : HIGH);
    digitalWrite(PIN_STATUS_LED, HIGH);
    pumpIsRunning = true;
  } else {
    digitalWrite(PIN_PUMP_RELAY, RELAY_ACTIVE_LOW ? HIGH : LOW);
    digitalWrite(PIN_STATUS_LED, LOW);
    pumpIsRunning = false;
  }
}

void startPump() {
  if (!pumpIsRunning) {
    pumpStartTime = millis();
    setRelay(true);
    Serial.println(F("[PUMP ACTION] >>> PUMP STARTED <<<"));
  }
}

void stopPump(const char* reason) {
  if (pumpIsRunning) {
    setRelay(false);
    pumpStopTime = millis();
    Serial.print(F("[PUMP ACTION] --- PUMP STOPPED --- Reason: "));
    Serial.println(reason);
  }
}

// ---------------------------------------------------------------------------
// 5. 4x1 MULTIPLEXER DIGITAL LOGIC ENGINE
// ---------------------------------------------------------------------------
// Inputs:
//   A (s1): 1 = Daytime, 0 = Night-time
//   B (s0): 1 = Water Tank Critical, 0 = Normal Water Level
//   C     : 1 = Hot Sun / High Temperature, 0 = Mild/Cool
//   D     : 1 = Soil is Dry, 0 = Soil has Enough Water
bool evaluateMuxDecision(int A, int B, int C, int D) {
  // Data Lines per Lab Design Rules:
  // D0 (AB = 00): Night + Normal Tank -> D0 = 0 (Never run at night)
  int D0 = 0;

  // D1 (AB = 01): Night + Critical Tank -> D1 = D (Run only if demand D=1)
  int D1 = D;

  // D2 (AB = 10): Daytime + Normal Tank -> D2 = (C && D) (Hot Sun + Dry Soil)
  int D2 = (C & D);

  // D3 (AB = 11): Daytime + Critical Emergency -> D3 = 1 (Immediate priority run)
  int D3 = 1;

  // 4x1 MUX Internal Gate Synthesis (Figure 2d: 2 NOTs + 4x 3-input ANDs + 1x 4-input OR)
  int notA = !A;
  int notB = !B;

  int g0 = D0 & notA & notB; // Channel D0 selected
  int g1 = D1 & notA & B;    // Channel D1 selected
  int g2 = D2 & A    & notB; // Channel D2 selected
  int g3 = D3 & A    & B;    // Channel D3 selected

  int outputY = g0 | g1 | g2 | g3;

  // Debug Diagnostics
  Serial.print(F("MUX [s1(A)=")); Serial.print(A);
  Serial.print(F(" s0(B)="));     Serial.print(B);
  Serial.print(F("] -> Active Line: D"));
  Serial.print((A << 1) | B);
  Serial.print(F(" | Inputs: C=")); Serial.print(C);
  Serial.print(F(" D=")); Serial.print(D);
  Serial.print(F(" | Decision Output Y="));
  Serial.println(outputY);

  return (outputY == 1);
}

// ---------------------------------------------------------------------------
// 6. SETUP
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 3000); // Wait for USB Serial monitor on native USB boards

  pinMode(PIN_PUMP_RELAY, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);
  setRelay(false); // Ensure pump is strictly OFF at boot

  pinMode(PIN_OVERRIDE_OFF, INPUT_PULLUP);
  pinMode(PIN_OVERRIDE_ON,  INPUT_PULLUP);

  Serial.println(F("=================================================="));
  Serial.println(F("  SAVANNAH ATELIER SMART PUMP CONTROLLER (4x1 MUX)"));
  Serial.println(F("=================================================="));
  Serial.println(F("Commands via Serial: '0' (FORCE OFF), '1' (FORCE ON), 'A' (AUTO)"));
}

// ---------------------------------------------------------------------------
// 7. MAIN CONTROL LOOP
// ---------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

  // 7A. Read Physical Push Buttons (Active LOW with internal pull-up)
  if (digitalRead(PIN_OVERRIDE_OFF) == LOW) {
    currentOverride = MODE_FORCE_OFF;
  } else if (digitalRead(PIN_OVERRIDE_ON) == LOW) {
    currentOverride = MODE_FORCE_ON;
  }

  // 7B. Read Serial Terminal Overrides
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == '0') {
      currentOverride = MODE_FORCE_OFF;
      Serial.println(F("[OVERRIDE] Switched to FORCE_OFF (Kill Switch)"));
    } else if (cmd == '1') {
      currentOverride = MODE_FORCE_ON;
      Serial.println(F("[OVERRIDE] Switched to FORCE_ON (Manual Run)"));
    } else if (cmd == 'A' || cmd == 'a') {
      currentOverride = MODE_AUTO;
      Serial.println(F("[OVERRIDE] Switched to AUTO (4x1 MUX Sensor Logic)"));
    }
  }

  // 7C. Handle Manual Overrides
  if (currentOverride == MODE_FORCE_OFF) {
    stopPump("PHYSICAL_OVERRIDE_KILL_SWITCH");
    delay(200);
    return;
  }

  if (currentOverride == MODE_FORCE_ON) {
    startPump();
    delay(200);
    return;
  }

  // 7D. Motor Burnout Safety Guards
  if (pumpIsRunning) {
    if (now - pumpStartTime >= MAX_RUN_TIME_MS) {
      stopPump("MAX_RUNTIME_LIMIT_REACHED (Cooling down)");
      return;
    }
  } else if (pumpStopTime > 0) {
    if (now - pumpStopTime < MIN_REST_TIME_MS) {
      // Still in compulsory cool-down period
      return;
    }
  }

  // 7E. Periodic Sensor Polling & 4x1 MUX Decision Evaluation
  if (now - lastSensorPoll >= SENSOR_POLL_MS) {
    lastSensorPoll = now;

    int rawLight = analogRead(PIN_LDR_LIGHT);
    int rawWater = analogRead(PIN_WATER_LEVEL);
    int rawTemp  = analogRead(PIN_TEMP_SENSOR);
    int rawSoil  = analogRead(PIN_SOIL_MOISTURE);

    // Convert raw analogue sensor readings to Boolean bits (0 or 1)
    int A = (rawLight >= THRESHOLD_DAY_LIGHT) ? 1 : 0;     // 1 = Day, 0 = Night
    int B = (rawWater <  THRESHOLD_TANK_CRITICAL) ? 1 : 0; // 1 = Critical, 0 = Normal
    int C = (rawTemp  >= THRESHOLD_TEMP_HOT) ? 1 : 0;      // 1 = Hot Sun/High Temp
    int D = (rawSoil  >= THRESHOLD_SOIL_DRY) ? 1 : 0;      // 1 = Dry Soil (needs water)

    bool shouldRun = evaluateMuxDecision(A, B, C, D);

    if (shouldRun) {
      startPump();
    } else {
      stopPump("MUX_LOGIC_CONDITIONS_SATISFIED");
    }
  }
}
