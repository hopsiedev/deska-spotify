// Windows: un PowerShell persistente (spotify-worker.ps1) con SMTC y el volumen por aplicación.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function createAdapter({ dir, dataDir }) {
  let worker = null;
  let buf = '';
  let seq = 0;
  const pending = new Map();

  function start() {
    worker = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'spotify-worker.ps1'), '-Dir', dataDir],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const sep = line.indexOf('|');
        if (sep < 0) continue; // "ready"
        const p = pending.get(line.slice(0, sep));
        if (p) { pending.delete(line.slice(0, sep)); clearTimeout(p.timer); p.resolve(JSON.parse(line.slice(sep + 1))); }
      }
    });
    worker.on('exit', () => {
      worker = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, out: 'worker detenido' }); pending.delete(id); }
    });
  }

  function run(cmd, arg = '') {
    if (!worker) start();
    const id = String(++seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, out: 'timeout' }); }, 15000);
      pending.set(id, { resolve, timer });
      worker.stdin.write(`${id}|${cmd}|${Buffer.from(arg, 'utf8').toString('base64')}${String.fromCharCode(10)}`);
    });
  }

  return {
    async status() {
      const r = await run('status');
      if (!r.ok) throw new Error(r.out || 'status');
      const d = r.data;
      return {
        run: d.run === true, playing: d.playing === true, title: d.title || '', artist: d.artist || '', album: d.album || '',
        pos: d.pos || 0, dur: d.dur || 0, vol: d.vol ?? null, cover: d.cover || '',
      };
    },
    async cover() { return fs.readFileSync(path.join(dataDir, '.cover.img')); },
    async command(c, a) {
      const r = await run(c, a);
      if (!r.ok) throw new Error(r.out || 'error');
    },
    close() { if (worker) worker.kill(); },
  };
}
