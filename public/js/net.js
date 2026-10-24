// ============================================================
//  net.js — 서버 연결 (같은 와이파이의 선생님 노트북)
// ============================================================
export class Net {
  constructor() {
    this.handlers = new Map();
    this.ready = false;
    this.queue = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}`;
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.ready = true;
        settled = true;
        for (const m of this.queue) ws.send(m);
        this.queue = [];
        resolve();
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        const h = this.handlers.get(m.t);
        if (h) h(m);
      };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('연결 실패')); } };
      ws.onclose = () => {
        this.ready = false;
        if (!settled) { settled = true; reject(new Error('연결 종료')); }
        const w = document.getElementById('netWarn');
        if (w && !document.getElementById('game').hidden) w.hidden = false;
      };
    });
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }

  send(obj) {
    const s = JSON.stringify(obj);
    if (this.ready && this.ws.readyState === 1) this.ws.send(s);
    else if (this.queue.length < 40) this.queue.push(s);
  }

  // 교사 화면용 JPEG — 큐에 쌓지 않는다 (늦은 화면은 보낼 가치가 없다)
  sendBinary(buf) {
    if (!this.ready || this.ws.readyState !== 1) return false;
    if (this.ws.bufferedAmount > 400000) return false;   // 망이 막히면 이번 장은 버린다
    this.ws.send(buf);
    return true;
  }
}
