// Tiny canvas helper: crisp on high-DPI screens, coordinates in CSS pixels.

const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
const MONO = 'Consolas, "SF Mono", Menlo, monospace';

export class Painter {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = 0;
    this.H = 0;
  }

  // Call at the start of every draw; resizes the backing store if needed.
  begin(bg) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
    }
    this.W = w;
    this.H = h;
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, w, h); }
    return this;
  }

  rect(x0, y0, x1, y1, fill) {
    this.ctx.fillStyle = fill;
    this.ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  box(x0, y0, x1, y1, stroke, width = 1) {
    const c = this.ctx;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.strokeRect(Math.min(x0, x1) + width / 2, Math.min(y0, y1) + width / 2,
      Math.abs(x1 - x0) - width, Math.abs(y1 - y0) - width);
  }

  line(x0, y0, x1, y1, stroke, width = 1, dash = null) {
    const c = this.ctx;
    c.beginPath();
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.setLineDash(dash || []);
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.setLineDash([]);
  }

  circle(x, y, r, { fill = null, stroke = null, width = 2 } = {}) {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
  }

  diamond(x, y, r, fill) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  text(x, y, str, { color = "#e6e6e6", size = 11, bold = false, italic = false, mono = false,
    align = "center", base = "middle" } = {}) {
    const c = this.ctx;
    c.font = `${italic ? "italic " : ""}${bold ? "700 " : ""}${size}px ${mono ? MONO : FONT}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = base;
    c.fillText(str, x, y);
  }

  // Centred message for empty states, word-wrapped to the canvas width
  message(lines, color, size = 13) {
    const c = this.ctx;
    c.font = `${size}px ${FONT}`;
    const maxW = this.W - 32;
    const wrapped = [];
    for (const line of lines) {
      let cur = "";
      for (const word of line.split(" ")) {
        const next = cur ? cur + " " + word : word;
        if (c.measureText(next).width > maxW && cur) { wrapped.push(cur); cur = word; }
        else cur = next;
      }
      wrapped.push(cur);
    }
    const mid = this.H / 2 - ((wrapped.length - 1) * (size + 6)) / 2;
    wrapped.forEach((l, i) => this.text(this.W / 2, mid + i * (size + 6), l, { color, size }));
  }
}
