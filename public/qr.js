/*
 * Small QR code generator (byte mode, error correction level M, versions 1 to 10).
 * Plenty for web addresses up to about 210 characters. No outside code.
 *   QR.encode(text)  -> { size, modules }  (modules[row][col] is true when dark)
 *   QR.svg(text)     -> SVG markup with a 4 module quiet zone
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(this, function () {
  'use strict';

  // Level M: [EC codewords per block, blocks in group 1, data codewords in group 1, blocks in group 2, data codewords in group 2]
  var TABLE = {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0], 4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0], 7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37], 10: [26, 4, 43, 1, 44]
  };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  var MAX_VERSION = 10;

  /* ---- Reed-Solomon over GF(256) ---- */
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function generator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function remainder(data, degree) {
    var gen = generator(degree);
    var res = new Array(degree).fill(0);
    data.forEach(function (b) {
      var factor = b ^ res.shift();
      res.push(0);
      for (var i = 0; i < degree; i++) res[i] ^= gfMul(gen[i + 1], factor);
    });
    return res;
  }

  function utf8(text) {
    var out = [];
    var enc = unescape(encodeURIComponent(text));
    for (var i = 0; i < enc.length; i++) out.push(enc.charCodeAt(i));
    return out;
  }

  function dataCodewords(v) { var t = TABLE[v]; return t[1] * t[2] + t[3] * t[4]; }

  function buildCodewords(bytes, v) {
    var capacity = dataCodewords(v);
    var bits = [];
    function push(value, count) { for (var i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    push(4, 4);                              // byte mode
    push(bytes.length, v < 10 ? 8 : 16);     // character count
    bytes.forEach(function (b) { push(b, 8); });
    var max = capacity * 8;
    for (var t = 0; t < 4 && bits.length < max; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (var pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

    // split into blocks, add error correction, interleave
    var t2 = TABLE[v], blocks = [], pos = 0;
    for (var g = 0; g < 2; g++) {
      var count = g === 0 ? t2[1] : t2[3], len = g === 0 ? t2[2] : t2[4];
      for (var k = 0; k < count; k++) { blocks.push(data.slice(pos, pos + len)); pos += len; }
    }
    var ecs = blocks.map(function (b) { return remainder(b, t2[0]); });
    var out = [];
    var maxLen = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    for (var c = 0; c < maxLen; c++) blocks.forEach(function (b) { if (c < b.length) out.push(b[c]); });
    for (var e = 0; e < t2[0]; e++) ecs.forEach(function (b) { out.push(b[e]); });
    return out;
  }

  function bit(value, i) { return ((value >>> i) & 1) === 1; }

  function Matrix(v) {
    this.v = v;
    this.size = 17 + 4 * v;
    this.m = []; this.fn = [];
    for (var y = 0; y < this.size; y++) { this.m.push(new Array(this.size).fill(false)); this.fn.push(new Array(this.size).fill(false)); }
  }
  Matrix.prototype.setFn = function (x, y, dark) { this.m[y][x] = dark; this.fn[y][x] = true; };
  Matrix.prototype.drawPatterns = function () {
    var size = this.size, i;
    for (i = 0; i < size; i++) { this.setFn(6, i, i % 2 === 0); this.setFn(i, 6, i % 2 === 0); }
    var self = this;
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) self.setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var pos = ALIGN[this.v], last = pos.length - 1;
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        this.setFn(pos[a] + dx, pos[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormat(0);
    if (this.v >= 7) {
      var rem = this.v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var bits = (this.v << 12) | rem;
      for (i = 0; i < 18; i++) {
        var dark = bit(bits, i), p = size - 11 + (i % 3), q = Math.floor(i / 3);
        this.setFn(p, q, dark); this.setFn(q, p, dark);
      }
    }
  };
  Matrix.prototype.drawFormat = function (mask) {
    var size = this.size, i;
    var data = (0 << 3) | mask;              // level M has format bits 00
    var rem = data;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    for (i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
    this.setFn(8, 7, bit(bits, 6));
    this.setFn(8, 8, bit(bits, 7));
    this.setFn(7, 8, bit(bits, 8));
    for (i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
    for (i = 0; i < 8; i++) this.setFn(size - 1 - i, 8, bit(bits, i));
    for (i = 8; i < 15; i++) this.setFn(8, size - 15 + i, bit(bits, i));
    this.setFn(8, size - 8, true);
  };
  Matrix.prototype.drawData = function (codewords) {
    var size = this.size, i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (!this.fn[y][x] && i < codewords.length * 8) {
            this.m[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };
  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) for (var x = 0; x < this.size; x++) {
      var inv;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
      if (!this.fn[y][x] && inv) this.m[y][x] = !this.m[y][x];
    }
  };
  Matrix.prototype.penalty = function () {
    var size = this.size, m = this.m, total = 0, x, y, run, line;
    function lineScore(cells) {
      var score = 0, runLen = 1;
      for (var i = 1; i < cells.length; i++) {
        if (cells[i] === cells[i - 1]) { runLen++; if (runLen === 5) score += 3; else if (runLen > 5) score += 1; }
        else runLen = 1;
      }
      var s = cells.map(function (c) { return c ? '1' : '0'; }).join('');
      var re = /(?=(00001011101|10111010000))/g, hit;
      while ((hit = re.exec(s))) { score += 40; re.lastIndex = hit.index + 1; }
      return score;
    }
    for (y = 0; y < size; y++) total += lineScore(m[y]);
    for (x = 0; x < size; x++) { line = []; for (y = 0; y < size; y++) line.push(m[y][x]); total += lineScore(line); }
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) total += 3;
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    total += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return total;
  };

  function encode(text) {
    var bytes = utf8(String(text));
    var v = 1;
    while (v <= MAX_VERSION && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(v) * 8) v++;
    if (v > MAX_VERSION) throw new Error('Text is too long for this QR code.');
    var codewords = buildCodewords(bytes, v);
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var mx = new Matrix(v);
      mx.drawPatterns();
      mx.drawData(codewords);
      mx.applyMask(mask);
      mx.drawFormat(mask);
      var s = mx.penalty();
      if (s < bestScore) { bestScore = s; best = mx; }
    }
    return { size: best.size, modules: best.m, version: v };
  }

  function svg(text, opts) {
    var q = encode(text), quiet = 4, n = q.size + quiet * 2, d = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) {
      if (q.modules[y][x]) d += 'M' + (x + quiet) + ',' + (y + quiet) + 'h1v1h-1z';
    }
    var label = (opts && opts.label) || 'QR code';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="' + label.replace(/"/g, '') + '">'
      + '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  return { encode: encode, svg: svg };
});
