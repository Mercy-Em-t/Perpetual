/**
 * mux_4x1_lab2.mjs
 * ================
 * Lab Question #2: Implementation of Boolean Function Using a 4x1 Multiplexer
 * Target Function: F(A, B, C, D) = Σ(1, 2, 5, 7, 8, 10, 11, 13, 15)
 *
 * Design Rules Implemented:
 *   1. Selection lines: s1 = A (MSB), s0 = B (LSB)
 *   2. Data lines (D0, D1, D2, D3) as simplified functions of C and D:
 *        - AB = 00 -> D0 = C'D + CD' = C ⊕ D  (XOR gate)
 *        - AB = 01 -> D1 = C'D + CD  = D      (Direct wire)
 *        - AB = 10 -> D2 = C'D' + CD' + CD = C + D' (NOT + OR gate)
 *        - AB = 11 -> D3 = C'D + CD  = D      (Direct wire)
 *   3. Internal 4x1 MUX constructed using BOTH:
 *        - Figure 2(c): 2-to-4 Decoder + four 2-input AND gates + one 4-input OR gate
 *        - Figure 2(d): Two NOT gates + four 3-input AND gates + one 4-input OR gate
 */

// --- Primitive Logic Gates (Bitwise 0/1) ---
const NOT  = (x) => (x ? 0 : 1);
const AND2 = (a, b) => (a & b) ? 1 : 0;
const AND3 = (a, b, c) => (a & b & c) ? 1 : 0;
const OR2  = (a, b) => (a | b) ? 1 : 0;
const OR4  = (a, b, c, d) => (a | b | c | d) ? 1 : 0;
const XOR2 = (a, b) => (a ^ b) ? 1 : 0;

/**
 * External Gating Network (Data Lines D0..D3 from inputs C, D)
 * Minimized per Rule #2 and Rule #3:
 *   D0 = C ⊕ D
 *   D1 = D
 *   D2 = C + D'
 *   D3 = D
 */
export function computeDataLines(C, D) {
  const notD = NOT(D);
  const D0 = XOR2(C, D);      // AB = 00: minterms 1 (0001), 2 (0010)
  const D1 = D;               // AB = 01: minterms 5 (0101), 7 (0111)
  const D2 = OR2(C, notD);    // AB = 10: minterms 8 (1000), 10 (1010), 11 (1011)
  const D3 = D;               // AB = 11: minterms 13 (1101), 15 (1111)
  return { D0, D1, D2, D3, notD };
}

/**
 * Figure 2(c) Architecture:
 *   2-to-4 Decoder (inputs: s1=A, s0=B -> outputs: m0, m1, m2, m3)
 *   + four 2-input AND gates + one 4-input OR gate
 */
export function mux4x1_Fig2c({ D0, D1, D2, D3, s1_A, s0_B }) {
  // 2-to-4 Decoder internal logic
  const notA = NOT(s1_A);
  const notB = NOT(s0_B);
  const dec0 = AND2(notA, notB); // AB = 00
  const dec1 = AND2(notA, s0_B); // AB = 01
  const dec2 = AND2(s1_A, notB); // AB = 10
  const dec3 = AND2(s1_A, s0_B); // AB = 11

  // Four 2-input AND gates
  const g0 = AND2(D0, dec0);
  const g1 = AND2(D1, dec1);
  const g2 = AND2(D2, dec2);
  const g3 = AND2(D3, dec3);

  // Final 4-input OR gate
  const Y = OR4(g0, g1, g2, g3);
  return { Y, decoder: [dec0, dec1, dec2, dec3], andGates: [g0, g1, g2, g3] };
}

/**
 * Figure 2(d) Architecture:
 *   Two NOT inverters on selection lines (s1=A, s0=B)
 *   + four 3-input AND gates + one 4-input OR gate
 */
export function mux4x1_Fig2d({ D0, D1, D2, D3, s1_A, s0_B }) {
  const notA = NOT(s1_A);
  const notB = NOT(s0_B);

  // Four 3-input AND gates
  const g0 = AND3(D0, notA, notB); // D0 · A' · B'
  const g1 = AND3(D1, notA, s0_B); // D1 · A' · B
  const g2 = AND3(D2, s1_A, notB); // D2 · A  · B'
  const g3 = AND3(D3, s1_A, s0_B); // D3 · A  · B

  // Final 4-input OR gate
  const Y = OR4(g0, g1, g2, g3);
  return { Y, inverters: { notA, notB }, andGates: [g0, g1, g2, g3] };
}

// --- Full 16-State Verification & Documentation Table ---
const TARGET_MINTERMS = new Set([1, 2, 5, 7, 8, 10, 11, 13, 15]);

console.log("==========================================================================================");
console.log(" LAB QUESTION #2: 4x1 MULTIPLEXER IMPLEMENTATION OF F(A,B,C,D) = Σ(1,2,5,7,8,10,11,13,15)");
console.log(" Selection Lines: s1 = A (MSB), s0 = B (LSB)");
console.log(" Minimized Data Lines: D0 = C ⊕ D | D1 = D | D2 = C + D' | D3 = D");
console.log("==========================================================================================");
console.log(" m  | A B | C D | Active Line | D0 D1 D2 D3 | Fig2c(Y) | Fig2d(Y) | Expected | Status");
console.log("----+-----+-----+-------------+-------------+----------+----------+----------+--------");

let allPassed = true;
for (let m = 0; m < 16; m++) {
  const A = (m >> 3) & 1;
  const B = (m >> 2) & 1;
  const C = (m >> 1) & 1;
  const D = m & 1;

  const { D0, D1, D2, D3 } = computeDataLines(C, D);
  const res2c = mux4x1_Fig2c({ D0, D1, D2, D3, s1_A: A, s0_B: B });
  const res2d = mux4x1_Fig2d({ D0, D1, D2, D3, s1_A: A, s0_B: B });
  const expected = TARGET_MINTERMS.has(m) ? 1 : 0;
  const pass = (res2c.Y === expected && res2d.Y === expected);
  if (!pass) allPassed = false;

  const selIdx = (A << 1) | B;
  const mStr = String(m).padStart(2, " ");
  console.log(
    ` ${mStr} | ${A} ${B} | ${C} ${D} |     D${selIdx}      |  ${D0}  ${D1}  ${D2}  ${D3} |    ${res2c.Y}     |    ${res2d.Y}     |    ${expected}     | ${pass ? "✅ PASS" : "❌ FAIL"}`
  );
}
console.log("==========================================================================================");
console.log(`FINAL VERIFICATION: ${allPassed ? "100% PASSED (16/16 States Match Σ(1,2,5,7,8,10,11,13,15))" : "FAILED"}`);
