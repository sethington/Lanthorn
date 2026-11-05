#!/usr/bin/env python3
"""Generates runtime/moon/moon_00.png .. moon_15.png: 16 moon phases (new .. full), RGBA, 128 px. No dependencies."""
import math, struct, zlib
CELL, COLS, ROWS = 128, 8, 2
W, H = CELL * COLS, CELL * ROWS

def noise(x, y, s):
    n = math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453
    return n - math.floor(n)

def vnoise(x, y, s):
    xi, yi = math.floor(x), math.floor(y)
    xf, yf = x - xi, y - yi
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a, b = noise(xi, yi, s), noise(xi + 1, yi, s)
    c, d = noise(xi, yi + 1, s), noise(xi + 1, yi + 1, s)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v

def fbm(x, y, s):
    return 0.55 * vnoise(x, y, s) + 0.3 * vnoise(x * 2.1, y * 2.1, s + 1) + 0.15 * vnoise(x * 4.3, y * 4.3, s + 2)

px = bytearray(W * H * 4)
for f in range(COLS * ROWS):
    ph = f / (COLS * ROWS - 1)               # 0 new .. 1 full
    a = (1 - ph) * math.pi                   # the light circles the moon: 0 = from us (full), pi = from behind (new)
    L = (math.sin(a), 0.0, math.cos(a))
    ox, oy = (f % COLS) * CELL, (f // COLS) * CELL
    for j in range(CELL):
        for i in range(CELL):
            x = (i + 0.5) / CELL * 2 - 1
            y = 1 - (j + 0.5) / CELL * 2
            r2 = x * x + y * y
            o = ((oy + j) * W + ox + i) * 4
            if r2 > 1:
                continue
            z = math.sqrt(1 - r2)
            lit = max(0.0, x * L[0] + z * L[2])
            lit = min(1.0, lit * 1.15)
            soft = lit ** 0.8
            m = fbm(x * 3.2 + 5, y * 3.2 + 9, 3)                        # maria: broad darker seas
            sea = 0.62 + 0.38 * min(1.0, max(0.0, (m - 0.35) * 3.2))
            crater = fbm(x * 9, y * 9, 11)
            shade = sea * (0.9 + 0.1 * crater)
            earth = 0.10                                               # earthshine: the dark side is a dim bluish disc, not nothing
            v = earth * shade + (1 - earth) * soft * shade
            edge = min(1.0, (1 - math.sqrt(r2)) * 30)                  # alpha ramp for the mask's cut-off (0.5)
            dim = 1 - soft                                             # how much of this pixel is in shadow
            px[o] = int(255 * min(1, v * 0.97 + dim * 0.02))
            px[o + 1] = int(255 * min(1, v * 0.94 + dim * 0.03))
            px[o + 2] = int(255 * min(1, v * 0.85 + dim * 0.07))
            px[o + 3] = int(255 * edge)

import os
os.makedirs("runtime/moon", exist_ok=True)
def chunk(t, d): c = struct.pack(">I", len(d)) + t + d; return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
for f in range(COLS * ROWS):
    ox, oy = (f % COLS) * CELL, (f // COLS) * CELL
    rows = [b"\x00" + bytes(px[((oy + j) * W + ox) * 4:((oy + j) * W + ox + CELL) * 4]) for j in range(CELL)]
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", CELL, CELL, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    open(f"runtime/moon/moon_{f:02d}.png", "wb").write(png)
print("wrote runtime/moon/moon_00..15.png")
