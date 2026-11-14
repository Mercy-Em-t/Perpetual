// ============================================================================
// mux_4x1_lab2.v
// Lab Question #2: Implementation of F(A, B, C, D) = Σ(1, 2, 5, 7, 8, 10, 11, 13, 15)
// Using a 4x1 Multiplexer (Figure 2c & Figure 2d) and External Logic Gates
// Selection Lines: s1 = A (MSB), s0 = B (LSB)
// ============================================================================

`timescale 1ns / 1ps

// 1. 4x1 Multiplexer Built per Figure 2(d) (Gate-Level: 2 NOTs, 4x 3-input ANDs, 1x 4-input OR)
module mux_4x1_fig2d (
    input  wire d0, d1, d2, d3,
    input  wire s1, // Connected to A (MSB)
    input  wire s0, // Connected to B (LSB)
    output wire y
);
    wire not_s1, not_s0;
    wire g0, g1, g2, g3;

    not u_not1 (not_s1, s1);
    not u_not0 (not_s0, s0);

    and u_and0 (g0, d0, not_s1, not_s0); // s1=0, s0=0 -> D0
    and u_and1 (g1, d1, not_s1, s0);     // s1=0, s0=1 -> D1
    and u_and2 (g2, d2, s1,     not_s0); // s1=1, s0=0 -> D2
    and u_and3 (g3, d3, s1,     s0);     // s1=1, s0=1 -> D3

    or  u_or   (y, g0, g1, g2, g3);
endmodule

// 2. Top-Level Circuit for F(A, B, C, D) = Σ(1, 2, 5, 7, 8, 10, 11, 13, 15)
module boolean_func_mux4x1 (
    input  wire A, B, C, D,
    output wire Y
);
    wire D0, D1, D2, D3;
    wire not_D;

    // External Gating (Minimized Expressions in terms of C and D):
    // AB = 00 -> D0 = C ^ D
    xor u_xor_d0 (D0, C, D);

    // AB = 01 -> D1 = D
    assign D1 = D;

    // AB = 10 -> D2 = C | ~D
    not u_not_d  (not_D, D);
    or  u_or_d2  (D2, C, not_D);

    // AB = 11 -> D3 = D
    assign D3 = D;

    // Instantiate 4x1 Multiplexer with s1 = A (MSB), s0 = B (LSB)
    mux_4x1_fig2d u_mux (
        .d0(D0),
        .d1(D1),
        .d2(D2),
        .d3(D3),
        .s1(A),
        .s0(B),
        .y(Y)
    );
endmodule
