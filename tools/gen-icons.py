#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扩展图标生成器（开发期工具，非运行时依赖）。
纯标准库手写 PNG 编码 + 4x 超采样抗锯齿。
用法：python3 tools/gen-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def _crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF


def _chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", _crc32(tag + data))
    )


def encode_png(width, height, rgba):
    stride = width * 4
    raw = bytearray((stride + 1) * height)
    for y in range(height):
        raw[y * (stride + 1)] = 0
        row = y * stride
        raw[y * (stride + 1) + 1 : y * (stride + 1) + 1 + stride] = rgba[row : row + stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_triangle(px, py, ax, ay, bx, by, cx, cy):
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def lerp(a, b, t):
    return a + (b - a) * t


def draw_icon(size):
    SS = 4
    rgba = bytearray(size * size * 4)
    show_tray = size >= 32

    for py in range(size):
        for px in range(size):
            bg_count = 0
            white_count = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    bg = in_rounded_rect(x, y, 0.02, 0.02, 0.98, 0.98, 0.225)
                    if not bg:
                        continue
                    bg_count += 1
                    stem = in_rounded_rect(x, y, 0.435, 0.235, 0.565, 0.55, 0.022)
                    head = in_triangle(x, y, 0.5, 0.72, 0.285, 0.515, 0.715, 0.515)
                    tray = show_tray and in_rounded_rect(x, y, 0.255, 0.795, 0.745, 0.868, 0.036)
                    if stem or head or tray:
                        white_count += 1

            i = (py * size + px) * 4
            if bg_count == 0:
                continue

            alpha = bg_count / (SS * SS)
            white_ratio = white_count / bg_count
            t = (py + 0.5) / size

            r = lerp(lerp(74, 10, t), 255, white_ratio)
            g = lerp(lerp(157, 99, t), 255, white_ratio)
            b = lerp(lerp(255, 240, t), 255, white_ratio)

            rgba[i] = int(round(r))
            rgba[i + 1] = int(round(g))
            rgba[i + 2] = int(round(b))
            rgba[i + 3] = int(round(alpha * 255))

    return encode_png(size, size, rgba)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(draw_icon(size))
        print("generated", path)
