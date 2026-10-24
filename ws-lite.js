// ============================================================
//  ws-lite.js — 의존성 0개 WebSocket 서버 (RFC 6455 최소 구현)
//  npm install 없이 `node server.js` 만으로 돌아가게 하려고 직접 구현.
// ============================================================
import crypto from 'crypto';
import { EventEmitter } from 'events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.fragOp = 0;
    this.fragChunks = [];
    this.isAlive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
    socket.setNoDelay(true);
  }

  _die() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // 폭주 방지 (한 프레임 1MB 넘으면 끊는다)
    if (this.buf.length > 1 << 20) { this.close(); return; }

    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < off + 2) return;
        len = b.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (b.length < off + 8) return;
        const big = b.readBigUInt64BE(off); off += 8;
        if (big > 1_000_000n) { this.close(); return; }
        len = Number(big);
      }

      let maskKey = null;
      if (masked) {
        if (b.length < off + 4) return;
        maskKey = b.subarray(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;

      let payload = Buffer.from(b.subarray(off, off + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._frame(0xa, payload); continue; }   // ping -> pong
      if (opcode === 0xa) { this.isAlive = true; continue; }         // pong

      if (opcode === 0x0) {
        this.fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragChunks);
          this.fragChunks = [];
          if (this.fragOp === 0x1) this.emit('message', full.toString('utf8'));
          else if (this.fragOp === 0x2) this.emit('binary', full);
          this.fragOp = 0;
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) { this.fragOp = opcode; this.fragChunks = [payload]; continue; }
        if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
        else this.emit('binary', payload);          // 교사 화면용 JPEG 프레임
        continue;
      }
    }
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(header);
      this.socket.write(payload);
    } catch { this._die(); }
  }

  send(str) {
    this._frame(0x1, Buffer.from(str, 'utf8'));
  }

  // 바이너리 프레임 (학생 화면 JPEG). base64 로 부풀리지 않고 그대로 보낸다.
  sendBinary(buf) {
    this._frame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() { this._frame(0x9, Buffer.alloc(0)); }

  close() {
    if (this.closed) return;
    try { this._frame(0x8, Buffer.alloc(0)); this.socket.end(); } catch { /* ignore */ }
    this._die();
  }
}

// http 서버에 붙인다
export function attachWS(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnection(new WSConnection(socket), req);
  });
}
