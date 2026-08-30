import assert from 'node:assert/strict';
import test from 'node:test';
import { isOpaqueCanvasPixel, projectPointerToDrawingPixel } from '../../../../apps/minecraft-companion/web/src/lib/desktopPetPointerHit.js';

function canvasWith(alpha = 255) {
  const calls = [];
  const context = {
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    readPixels(x, y, width, height, _format, _type, pixel) {
      calls.push({ x, y, width, height });
      pixel[3] = alpha;
    },
  };
  return {
    width: 240,
    height: 480,
    calls,
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 170, bottom: 340, width: 160, height: 320 }),
    getContext: kind => kind === 'webgl2' ? context : null,
  };
}

test('画布外指针直接穿透且不读取 WebGL 像素', () => {
  const canvas = canvasWith();
  assert.equal(projectPointerToDrawingPixel(canvas, 170, 100), null);
  assert.equal(isOpaqueCanvasPixel(canvas, 9, 100), false);
  assert.equal(canvas.calls.length, 0);
});

test('CSS 中心坐标映射到 WebGL drawing buffer 并翻转 Y', () => {
  const canvas = canvasWith();
  assert.deepEqual(projectPointerToDrawingPixel(canvas, 90, 180), { x: 120, y: 239 });
  assert.equal(isOpaqueCanvasPixel(canvas, 90, 180), true);
  assert.deepEqual(canvas.calls, [{ x: 120, y: 239, width: 1, height: 1 }]);
});

test('画布内 Alpha 为零的像素保持鼠标穿透', () => {
  const canvas = canvasWith(0);
  assert.equal(isOpaqueCanvasPixel(canvas, 90, 180), false);
});
