# Savannah 16-Tone MFSK Acoustic Modem

An air-gapped **SMS-over-Sound** bridge for forwarding M-Pesa confirmation SMS messages from a mobile phone's speaker (e.g., Redmi Note 12) directly into a laptop microphone and the Savannah Till Receipt API (`/api/till/receipt`), with zero network dependency between the phone and laptop.

---

## 1. Acoustic Frame Protocol

Every acoustic transmission encapsulates a UTF-8 string inside a length-prefixed, CRC16-verified frame:

```text
+---------------+---------------+------------------+-------------------+------------------+---------------+
| SYNC_1 (120ms)| SYNC_2 (120ms)| LENGTH (2 Bytes) | UTF-8 PAYLOAD (N) | CRC16-CCITT (2B) | EOT (120ms)   |
|   1000 Hz     |   1350 Hz     | 4 Hex Nibbles    | 2*N Hex Nibbles   | 4 Hex Nibbles    |   5200 Hz     |
+---------------+---------------+------------------+-------------------+------------------+---------------+
```

- **Sample Rate**: `44,100 Hz` (16-bit signed mono PCM)
- **Preamble**:
  - `SYNC_1`: `1000 Hz` (`120 ms` tone + `30 ms` gap)
  - `SYNC_2`: `1350 Hz` (`120 ms` tone + `30 ms` gap)
- **Symbol Timing**:
  - Each byte is split into its **High Nibble** (`(byte >> 4) & 0x0F`) and **Low Nibble** (`byte & 0x0F`).
  - Each nibble is transmitted as a `45 ms` raised-cosine tapered sine wave followed by a `15 ms` silent guard interval so consecutive identical nibbles are cleanly separated.
- **Integrity Check**:
  - **CRC16-CCITT** (`poly=0x1021`, `init=0xFFFF`) computed over the raw UTF-8 payload bytes.
- **End-of-Transmission (`EOT`)**:
  - `5200 Hz` (`120 ms` tone).

---

## 2. 16-Tone MFSK Frequency Table

Formula: `F(nibble) = 1700 Hz + (nibble * 200 Hz)`

| Hex Nibble | Binary | Frequency (Hz) | Hex Nibble | Binary | Frequency (Hz) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`0x0`** | `0000` | `1700 Hz` | **`0x8`** | `1000` | `3300 Hz` |
| **`0x1`** | `0001` | `1900 Hz` | **`0x9`** | `1001` | `3500 Hz` |
| **`0x2`** | `0010` | `2100 Hz` | **`0xA`** | `1010` | `3700 Hz` |
| **`0x3`** | `0011` | `2300 Hz` | **`0xB`** | `1011` | `3900 Hz` |
| **`0x4`** | `0100` | `2500 Hz` | **`0xC`** | `1100` | `4100 Hz` |
| **`0x5`** | `0101` | `2700 Hz` | **`0xD`** | `1101` | `4300 Hz` |
| **`0x6`** | `0110` | `2900 Hz` | **`0xE`** | `1110` | `4500 Hz` |
| **`0x7`** | `0111` | `3100 Hz` | **`0xF`** | `1111` | `4700 Hz` |

---

## 3. Python CLI Usage (`acoustic_modem.py`)

`acoustic_modem.py` uses only the Python standard library (`wave`, `math`, `struct`, `json`, `urllib.request`, `winsound`) and works out of the box with zero external dependencies.

### Run End-to-End Demo
Encodes a sample M-Pesa SMS into `sample_mpesa_acoustic.wav`, plays it over the speaker on Windows, decodes the `.wav` via Goertzel spectral energy detection, verifies the `CRC16-CCITT` checksum and 100% byte match, and forwards the payload to `http://127.0.0.1:5174/api/till/receipt`:

```bash
python acoustic_modem.py demo
```

### Encode an M-Pesa SMS to `.wav`
```bash
python acoustic_modem.py encode "UK6DC1DCIM Confirmed. Ksh650.00 received from 254710720949 MERCY" --out sample_mpesa_acoustic.wav
```

### Decode a `.wav` File (and Optionally Forward to Till Server)
```bash
python acoustic_modem.py decode sample_mpesa_acoustic.wav --forward
```

---

## 4. Web Audio Transceiver (`acoustic_transceiver.html`)

Open `acoustic_transceiver.html` in any mobile browser (Redmi Note 12) or laptop browser:

1. **Phone Speaker (Transmitter Tab)**:
   - Paste or type the M-Pesa confirmation SMS.
   - Select **Standard Acoustic** (`45ms/15ms`) or **Room / Acoustic Echo Robust** (`85ms/30ms`).
   - Tap **Play Acoustic MFSK Frame** to emit the 16-tone audio frame through the phone's physical speaker while viewing the live spectrum and active hex nibble grid.
2. **Laptop Microphone (Receiver Tab)**:
   - Click **Start Microphone Decoder** to grant microphone access (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`).
   - Place the phone speaker within `5–30 cm` of the laptop microphone and transmit.
   - The receiver locks onto the `1000 Hz -> 1350 Hz` preamble, decodes each hex nibble in real time, verifies the `CRC16-CCITT` checksum, and automatically `POST`s the decoded SMS to `http://192.168.100.32:5174/api/till/receipt`.
