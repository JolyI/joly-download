#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扩展图标生成器（开发期工具，非运行时依赖）。
纯标准库手写 PNG 编码 + 4x 超采样抗锯齿。

图形 = Joly 的 J 字母回钩 + 向下落入的青绿笔画，透明背景。
箭头形切口融入字母结构，宽笔画与留白兼顾 16px 工具栏辨识度。
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


def append_curve(points, control1, control2, end):
    """用三次贝塞尔曲线构造字母回钩；超采样负责最终边缘抗锯齿。"""
    start = points[-1]
    for step in range(1, 13):
        t = step / 12
        u = 1 - t
        points.append(tuple(
            u ** 3 * start[k] + 3 * u * u * t * control1[k]
            + 3 * u * t * t * control2[k] + t ** 3 * end[k]
            for k in (0, 1)
        ))


def in_polygon(x, y, points):
    inside = False
    x0, y0 = points[-1]
    for x1, y1 in points:
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
        x0, y0 = x1, y1
    return inside


def logo_layers():
    head = [(0.64, 0.12), (0.84, 0.12), (0.84, 0.35), (0.74, 0.46), (0.64, 0.35)]
    body = [(0.64, 0.44), (0.74, 0.55), (0.84, 0.44), (0.84, 0.60)]
    append_curve(body, (0.84, 0.80), (0.70, 0.92), (0.49, 0.92))
    append_curve(body, (0.29, 0.92), (0.14, 0.79), (0.14, 0.60))
    body.extend([(0.33, 0.55), (0.33, 0.60)])
    append_curve(body, (0.33, 0.68), (0.39, 0.73), (0.49, 0.73))
    append_curve(body, (0.59, 0.73), (0.64, 0.68), (0.64, 0.59))
    layers = []
    for points, color in ((head, (70, 151, 158)), (body, (91, 118, 177))):
        xs, ys = zip(*points)
        layers.append((points, color, (min(xs), min(ys), max(xs), max(ys))))
    return layers


def draw_icon(size):
    SS = 4
    rgba = bytearray(size * size * 4)

    layers = logo_layers()

    for py in range(size):
        for px in range(size):
            color_sum = [0, 0, 0]
            glyph_count = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    for points, color, (x0, y0, x1, y1) in layers:
                        if x0 <= x <= x1 and y0 <= y <= y1 and in_polygon(x, y, points):
                            glyph_count += 1
                            for channel in range(3):
                                color_sum[channel] += color[channel]
                            break

            i = (py * size + px) * 4
            if glyph_count == 0:
                continue

            for channel in range(3):
                rgba[i + channel] = int(round(color_sum[channel] / glyph_count))
            rgba[i + 3] = int(round(glyph_count / (SS * SS) * 255))

    return encode_png(size, size, rgba)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(draw_icon(size))
        print("generated", path)
