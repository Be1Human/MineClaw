export function projectPointerToDrawingPixel(canvas, clientX, clientY) {
  const rect = canvas?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
  const x = Math.min(canvas.width - 1, Math.floor((clientX - rect.left) * canvas.width / rect.width));
  const topDownY = Math.min(canvas.height - 1, Math.floor((clientY - rect.top) * canvas.height / rect.height));
  return { x, y: canvas.height - 1 - topDownY };
}

export function isOpaqueCanvasPixel(canvas, clientX, clientY) {
  const point = projectPointerToDrawingPixel(canvas, clientX, clientY);
  if (!point) return false;
  const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!context) return false;
  const pixel = new Uint8Array(4);
  context.readPixels(point.x, point.y, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
  return pixel[3] > 0;
}
