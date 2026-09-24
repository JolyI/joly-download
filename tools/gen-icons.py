#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扩展图标生成器（开发期工具，非运行时依赖）。
纯标准库手写 PNG 编码；以 16px 像素网格等比放大，保持清晰硬边。

图形 = 戴红帽的金色 J 方块，呼应超级玛丽主题与 Joly 品牌。
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


PALETTE = {
    ".": (0, 0, 0, 0),
    "K": (36, 37, 43, 255),
    "R": (231, 71, 48, 255),
    "D": (179, 49, 37, 255),
    "Y": (255, 211, 78, 255),
    "S": (211, 141, 44, 255),
    "W": (255, 246, 218, 255),
}

# 红帽沿和高反差 J 在最小工具栏尺寸下仍独立成形。
PIXELS = (
    ".....KKKKKK.....",
    "....KRRRRRRK....",
    "....KRWRRRRK....",
    "..KKKRRRRRRKKK..",
    ".KRRRRRRRRRRRRK.",
    ".KDDDDDDDDDDDDK.",
    "..KYYYYYYYYYSK..",
    "..KYWWWWWWYYSK..",
    "..KYYYYWWYYYSK..",
    "..KYYYYWWYYYSK..",
    "..KYWWYWWYYYSK..",
    "..KYWWYWWYYYSK..",
    "..KYYWWWWYYYSK..",
    "..KYYYYYYYYYSK..",
    "..KSSSSSSSSSSK..",
    "...KKKKKKKKKK...",
)


def draw_icon(size):
    rgba = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            color = PALETTE[PIXELS[py * 16 // size][px * 16 // size]]
            offset = (py * size + px) * 4
            rgba[offset : offset + 4] = bytes(color)
    return encode_png(size, size, rgba)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(draw_icon(size))
        print("generated", path)
