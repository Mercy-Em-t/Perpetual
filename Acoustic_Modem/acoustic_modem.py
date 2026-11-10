#!/usr/bin/env python3
"""
Savannah 16-Tone MFSK Acoustic Modem (Air-Gapped SMS-over-Sound Bridge)
======================================================================
Encodes and decodes arbitrary UTF-8 payloads (e.g., M-Pesa confirmation SMS)
into audible 16-tone Multiple Frequency-Shift Keying (MFSK) acoustic frames.

Zero external dependencies required (uses Python standard library `wave`,
`math`, `struct`, `zlib`, `json`, `urllib.request`, `winsound`).

Frame Protocol:
  [SYNC_1: 1000 Hz] -> [SYNC_2: 1350 Hz] -> [DATA NIBBLES + GUARD] -> [EOT: 5200 Hz]
  Payload envelope: [LENGTH (2 bytes, big-endian)] + [UTF-8 PAYLOAD] + [CRC16-CCITT (2 bytes, big-endian)]
  Each byte is transmitted as High Nibble (4 bits) then Low Nibble (4 bits).
  Nibble k in 0x0..0xF maps to F(k) = 1700 + k * 200 Hz (1700 Hz to 4700 Hz).
"""

import argparse
import json
import math
import os
import struct
import sys
import time
import urllib.request
import urllib.error
import wave

# Acoustic Modem Protocol Constants
SAMPLE_RATE = 44100
AMPLITUDE = 0.75          # 75% full-scale to prevent speaker clipping
SYNC1_FREQ = 1000.0       # Start-of-frame tone 1 (Hz)
SYNC2_FREQ = 1350.0       # Start-of-frame tone 2 (Hz)
EOT_FREQ = 5200.0         # End-of-transmission tone (Hz)
BASE_FREQ = 1700.0        # Nibble 0x0 frequency (Hz)
FREQ_STEP = 200.0         # Spacing between consecutive nibble tones (Hz)

SYNC_DURATION = 0.120     # 120 ms per sync tone
SYNC_GAP = 0.030          # 30 ms silence after sync tone
SYMBOL_DURATION = 0.045   # 45 ms active tone per 4-bit nibble
GUARD_DURATION = 0.015    # 15 ms silent guard interval between symbols
LEAD_SILENCE = 0.100      # 100 ms leading/trailing silence

NIBBLE_FREQS = [BASE_FREQ + i * FREQ_STEP for i in range(16)]
ALL_FREQS = [SYNC1_FREQ, SYNC2_FREQ, EOT_FREQ] + NIBBLE_FREQS

DEFAULT_SAMPLE_SMS = (
    "UK6DC1DCIM Confirmed. Ksh650.00 received from 254710720949 MERCY "
    "on 7/11/26 at 4:02 PM. New M-PESA balance is Ksh14,250.00."
)
DEFAULT_RECEIPT_URL = "http://127.0.0.1:5174/api/till/receipt"


def crc16_ccitt(data: bytes, poly: int = 0x1021, init: int = 0xFFFF) -> int:
    """Compute 16-bit CRC-CCITT (0x1021, initial 0xFFFF)."""
    crc = init
    for b in data:
        crc ^= (b << 8)
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ poly) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def generate_tone_samples(freq: float, duration: float, sample_rate: int = SAMPLE_RATE) -> list[int]:
    """Generate 16-bit signed PCM samples for a sine wave with raised-cosine edge tapering."""
    num_samples = int(round(duration * sample_rate))
    fade_samples = min(int(0.004 * sample_rate), num_samples // 4)  # 4 ms anti-click envelope
    samples = []
    max_val = int(32767 * AMPLITUDE)
    two_pi_f = 2.0 * math.pi * freq / sample_rate

    for i in range(num_samples):
        env = 1.0
        if i < fade_samples:
            env = 0.5 * (1.0 - math.cos(math.pi * i / fade_samples))
        elif i >= num_samples - fade_samples:
            rem = num_samples - 1 - i
            env = 0.5 * (1.0 - math.cos(math.pi * rem / fade_samples))
        val = int(round(max_val * env * math.sin(two_pi_f * i)))
        samples.append(val)
    return samples


def generate_silence_samples(duration: float, sample_rate: int = SAMPLE_RATE) -> list[int]:
    """Generate 16-bit signed PCM silence samples."""
    return [0] * int(round(duration * sample_rate))


def build_frame_bytes(text: str) -> tuple[bytes, int]:
    """Pack UTF-8 text into [LENGTH (2B)] + [PAYLOAD] + [CRC16 (2B)]."""
    payload = text.encode("utf-8")
    if len(payload) > 65535:
        raise ValueError("Payload exceeds maximum frame size (65535 bytes).")
    crc = crc16_ccitt(payload)
    frame = struct.pack(">H", len(payload)) + payload + struct.pack(">H", crc)
    return frame, crc


def encode_text_to_wav(text: str, out_path: str) -> dict:
    """Encode a text string into a 16-tone MFSK WAV file."""
    frame_bytes, crc = build_frame_bytes(text)
    samples: list[int] = []

    # Leading silence
    samples.extend(generate_silence_samples(LEAD_SILENCE))

    # Preamble: SYNC1 then SYNC2
    samples.extend(generate_tone_samples(SYNC1_FREQ, SYNC_DURATION))
    samples.extend(generate_silence_samples(SYNC_GAP))
    samples.extend(generate_tone_samples(SYNC2_FREQ, SYNC_DURATION))
    samples.extend(generate_silence_samples(SYNC_GAP))

    # Data nibbles (high nibble, then low nibble per byte)
    nibbles = []
    for byte_val in frame_bytes:
        hi = (byte_val >> 4) & 0x0F
        lo = byte_val & 0x0F
        nibbles.extend([hi, lo])
        samples.extend(generate_tone_samples(NIBBLE_FREQS[hi], SYMBOL_DURATION))
        samples.extend(generate_silence_samples(GUARD_DURATION))
        samples.extend(generate_tone_samples(NIBBLE_FREQS[lo], SYMBOL_DURATION))
        samples.extend(generate_silence_samples(GUARD_DURATION))

    # EOT tone + trailing silence
    samples.extend(generate_tone_samples(EOT_FREQ, SYNC_DURATION))
    samples.extend(generate_silence_samples(LEAD_SILENCE))

    # Write 16-bit mono PCM WAV
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    pcm_data = struct.pack(f"<{len(samples)}h", *samples)
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_data)

    duration_sec = len(samples) / SAMPLE_RATE
    return {
        "out_path": os.path.abspath(out_path),
        "payload_bytes": len(text.encode("utf-8")),
        "frame_bytes": len(frame_bytes),
        "total_nibbles": len(nibbles),
        "crc16": f"0x{crc:04X}",
        "duration_sec": round(duration_sec, 3),
        "sample_rate": SAMPLE_RATE,
    }


def goertzel_power(samples: list[int], start: int, length: int, target_freq: float, sample_rate: int = SAMPLE_RATE) -> float:
    """Compute normalized spectral power at target_freq using the Goertzel algorithm."""
    if length <= 0:
        return 0.0
    k = int(0.5 + (length * target_freq) / sample_rate)
    omega = (2.0 * math.pi * k) / length
    coeff = 2.0 * math.cos(omega)
    s_prev = 0.0
    s_prev2 = 0.0
    end = min(start + length, len(samples))
    for idx in range(start, end):
        s = samples[idx] + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    return power / (length * length)


def read_wav_mono(wav_path: str) -> tuple[list[int], int]:
    """Read a WAV file and return mono 16-bit signed integer samples and sample rate."""
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth != 2:
        raise ValueError(f"Expected 16-bit PCM WAV (sampwidth=2), got sampwidth={sampwidth}")

    total_samples = n_frames * n_channels
    unpacked = struct.unpack(f"<{total_samples}h", raw)
    if n_channels > 1:
        mono = [unpacked[i] for i in range(0, total_samples, n_channels)]
    else:
        mono = list(unpacked)
    return mono, framerate


def decode_wav_to_text(wav_path: str) -> dict:
    """
    Decode a 16-tone MFSK WAV file using Goertzel spectral energy detection.
    Locates the SYNC1 -> SYNC2 preamble, then steps through nibble symbol slots
    and verifies the 16-bit CRC-CCITT checksum.
    """
    samples, sr = read_wav_mono(wav_path)

    # Step 1: Locate SYNC1 peak using a sliding window (5 ms step, 40 ms window)
    win_len = int(0.040 * sr)
    hop_len = int(0.005 * sr)
    best_sync1_pos = 0
    best_sync1_score = -1.0

    expected_sync2_offset = int((SYNC_DURATION + SYNC_GAP) * sr)

    # Scan for combined SYNC1 followed by SYNC2 signature
    max_scan = max(1, len(samples) - expected_sync2_offset - win_len)
    for pos in range(0, max_scan, hop_len):
        p1 = goertzel_power(samples, pos, win_len, SYNC1_FREQ, sr)
        p2 = goertzel_power(samples, pos + expected_sync2_offset, win_len, SYNC2_FREQ, sr)
        score = p1 * p2
        if score > best_sync1_score:
            best_sync1_score = score
            best_sync1_pos = pos

    # Refine SYNC1 start edge with 1 ms resolution around best_sync1_pos
    fine_step = max(1, int(0.001 * sr))
    sync_win = int(SYNC_DURATION * sr)
    search_start = max(0, best_sync1_pos - int(0.060 * sr))
    search_end = min(max_scan, best_sync1_pos + int(0.060 * sr))

    refined_sync1_pos = best_sync1_pos
    best_fine_score = -1.0
    for pos in range(search_start, search_end, fine_step):
        p1 = goertzel_power(samples, pos, sync_win, SYNC1_FREQ, sr)
        p2 = goertzel_power(samples, pos + expected_sync2_offset, sync_win, SYNC2_FREQ, sr)
        score = p1 + p2
        if score > best_fine_score:
            best_fine_score = score
            refined_sync1_pos = pos

    # Data symbols start immediately after SYNC1 + GAP + SYNC2 + GAP
    data_start = refined_sync1_pos + 2 * int(round(SYNC_DURATION * sr)) + 2 * int(round(SYNC_GAP * sr))
    symbol_samples = int(round(SYMBOL_DURATION * sr))
    slot_samples = int(round((SYMBOL_DURATION + GUARD_DURATION) * sr))

    # Analyze the inner 80% of each symbol to stay clear of edge transitions
    inner_margin = int(0.10 * symbol_samples)
    inner_len = symbol_samples - 2 * inner_margin

    def detect_nibble_at(slot_index: int) -> tuple[int, float, float]:
        start = data_start + slot_index * slot_samples + inner_margin
        if start + inner_len > len(samples):
            raise EOFError("Unexpected end of audio stream while decoding symbol.")
        eot_p = goertzel_power(samples, start, inner_len, EOT_FREQ, sr)
        best_nibble = 0
        best_p = -1.0
        for nib_idx, freq in enumerate(NIBBLE_FREQS):
            p = goertzel_power(samples, start, inner_len, freq, sr)
            if p > best_p:
                best_p = p
                best_nibble = nib_idx
        return best_nibble, best_p, eot_p

    # Read first 4 nibbles (2 bytes = payload length)
    header_nibbles = []
    for i in range(4):
        nib, _, _ = detect_nibble_at(i)
        header_nibbles.append(nib)

    len_hi = (header_nibbles[0] << 4) | header_nibbles[1]
    len_lo = (header_nibbles[2] << 4) | header_nibbles[3]
    payload_len = (len_hi << 8) | len_lo

    if payload_len <= 0 or payload_len > 4096:
        raise ValueError(f"Decoded invalid payload length: {payload_len} bytes")

    # Total bytes after length header = payload_len + 2 (CRC16)
    total_remaining_bytes = payload_len + 2
    decoded_bytes = bytearray()
    slot_idx = 4
    for _ in range(total_remaining_bytes):
        hi_nib, _, _ = detect_nibble_at(slot_idx)
        lo_nib, _, _ = detect_nibble_at(slot_idx + 1)
        slot_idx += 2
        decoded_bytes.append((hi_nib << 4) | lo_nib)

    payload_bytes = bytes(decoded_bytes[:payload_len])
    received_crc = struct.unpack(">H", bytes(decoded_bytes[payload_len:payload_len + 2]))[0]
    computed_crc = crc16_ccitt(payload_bytes)
    crc_valid = (received_crc == computed_crc)

    # Check EOT tone presence right after the last nibble slot
    eot_start = data_start + slot_idx * slot_samples + inner_margin
    eot_detected = False
    if eot_start + inner_len <= len(samples):
        eot_power = goertzel_power(samples, eot_start, inner_len, EOT_FREQ, sr)
        eot_detected = eot_power > 100.0

    decoded_text = payload_bytes.decode("utf-8", errors="replace")
    return {
        "text": decoded_text,
        "payload_length": payload_len,
        "received_crc16": f"0x{received_crc:04X}",
        "computed_crc16": f"0x{computed_crc:04X}",
        "crc_valid": crc_valid,
        "eot_detected": eot_detected,
        "sync_start_sample": refined_sync1_pos,
        "data_start_sample": data_start,
    }


def forward_to_server(text: str, url: str = DEFAULT_RECEIPT_URL) -> dict:
    """POST the decoded M-Pesa SMS payload to the local Savannah Till Receipt endpoint."""
    payload = json.dumps({
        "sms_text": text,
        "text": text,
        "raw_sms": text,
        "source": "acoustic_modem_16mfsk",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return {"forwarded": True, "status": resp.status, "url": url, "response": body}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
        return {"forwarded": False, "status": e.code, "url": url, "error": body}
    except Exception as e:
        return {"forwarded": False, "status": None, "url": url, "error": str(e)}


def play_wav_if_available(wav_path: str) -> bool:
    """Play the WAV file asynchronously on Windows if winsound is available."""
    try:
        import winsound
        # Play asynchronously so CLI tests finish promptly without blocking for the full audio length
        winsound.PlaySound(wav_path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        return True
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Savannah 16-Tone MFSK Acoustic Modem (Encode / Decode / Demo)"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Encode command
    enc_parser = subparsers.add_parser("encode", help="Encode UTF-8 text into a 16-MFSK WAV file")
    enc_parser.add_argument("text", type=str, help="SMS / UTF-8 text to encode")
    enc_parser.add_argument("--out", default="sample_mpesa_acoustic.wav", help="Output WAV file path")

    # Decode command
    dec_parser = subparsers.add_parser("decode", help="Decode a 16-MFSK WAV file back into text")
    dec_parser.add_argument("wav_file", type=str, help="Input WAV file path")
    dec_parser.add_argument("--forward", action="store_true", help="POST decoded SMS to local server")
    dec_parser.add_argument("--url", default=DEFAULT_RECEIPT_URL, help="Target server URL for --forward")

    # Demo command
    demo_parser = subparsers.add_parser(
        "demo",
        help="End-to-end encode -> speaker playback -> Goertzel decode -> CRC16 check -> HTTP forward",
    )
    demo_parser.add_argument("--out", default="sample_mpesa_acoustic.wav", help="WAV file for demo")
    demo_parser.add_argument("--text", default=DEFAULT_SAMPLE_SMS, help="Sample SMS text for demo")
    demo_parser.add_argument("--url", default=DEFAULT_RECEIPT_URL, help="Target server URL")

    args = parser.parse_args()

    if args.command == "encode":
        info = encode_text_to_wav(args.text, args.out)
        print("=== 16-MFSK ACOUSTIC ENCODE COMPLETE ===")
        print(json.dumps(info, indent=2))

    elif args.command == "decode":
        res = decode_wav_to_text(args.wav_file)
        print("=== 16-MFSK ACOUSTIC DECODE COMPLETE ===")
        print(json.dumps(res, indent=2))
        if not res["crc_valid"]:
            sys.exit(2)
        if args.forward:
            fwd = forward_to_server(res["text"], args.url)
            print("=== HTTP FORWARD RESULT ===")
            print(json.dumps(fwd, indent=2))

    elif args.command == "demo":
        print("======================================================================")
        print(" SAVANNAH 16-TONE MFSK ACOUSTIC MODEM — END-TO-END VERIFICATION DEMO")
        print("======================================================================")
        print(f"[1/4] Original SMS ({len(args.text)} chars):")
        print(f"      {args.text}")

        enc_info = encode_text_to_wav(args.text, args.out)
        print(f"\n[2/4] Encoded 16-MFSK Audio Frame -> {enc_info['out_path']}")
        print(f"      Frame Size : {enc_info['frame_bytes']} bytes ({enc_info['total_nibbles']} hex nibbles)")
        print(f"      CRC16-CCITT: {enc_info['crc16']}")
        print(f"      Duration   : {enc_info['duration_sec']}s @ {enc_info['sample_rate']} Hz")

        played = play_wav_if_available(enc_info["out_path"])
        print(f"      Speaker Out: {'Playing via winsound' if played else 'Skipped (headless)'}")

        dec_info = decode_wav_to_text(enc_info["out_path"])
        exact_match = (dec_info["text"] == args.text)
        print("\n[3/4] Goertzel Spectral Decode & Integrity Check:")
        print(f"      Decoded SMS: {dec_info['text']}")
        print(f"      CRC16 Check: {dec_info['received_crc16']} == {dec_info['computed_crc16']} (VALID={dec_info['crc_valid']})")
        print(f"      EOT Tone   : Detected={dec_info['eot_detected']}")
        print(f"      Byte Match : {'100% EXACT MATCH' if exact_match else 'MISMATCH!'}")

        fwd_info = forward_to_server(dec_info["text"], args.url)
        print(f"\n[4/4] Webhook Forward to {args.url}:")
        print(f"      {json.dumps(fwd_info)}")
        print("======================================================================")

        if not (dec_info["crc_valid"] and exact_match):
            sys.exit(1)


if __name__ == "__main__":
    main()
