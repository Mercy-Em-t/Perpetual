#!/usr/bin/env python3
import time
import serial

def send_at(ser, cmd, wait=0.5):
    ser.reset_input_buffer()
    ser.write((cmd + "\r").encode("ascii"))
    ser.flush()
    time.sleep(wait)
    n = ser.in_waiting
    raw = ser.read(n if n > 0 else 1024).decode("utf-8", errors="replace")
    clean = " | ".join([line.strip() for line in raw.splitlines() if line.strip()])
    print(f"  [COM6] {cmd:<24} => {clean}")
    return clean

ser = serial.Serial("COM6", 115200, timeout=0.6, write_timeout=2.0)
ser.dtr = True
ser.rts = True
time.sleep(0.2)
for c in [
    "AT",
    "ATE0",
    "AT+CSQ",
    "AT+CGATT?",
    "AT+CGDCONT?",
    "AT+COPS?",
    "AT+GSN",
    "AT+CIMI",
    "AT+CCID",
    "AT^USSDMODE?",
    "AT+SPACTCARD=0",
    "AT+SPACTCARD=1"
]:
    send_at(ser, c)
ser.close()
