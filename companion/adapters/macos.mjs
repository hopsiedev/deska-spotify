// macOS: AppleScript sobre la app de escritorio de Spotify (osascript). SIN PROBAR en un Mac real.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const osa = (script) => new Promise((resolve, reject) => {
  execFile('osascript', ['-e', script], { timeout: 10000 }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim())));
});

const STATUS = `
if application "Spotify" is not running then return "off"
tell application "Spotify"
	set ps to player state as text
	if ps is "stopped" then return "on" & tab & ps
	set tr to current track
	set art to ""
	try
		set art to artwork url of tr
	end try
	return "on" & tab & ps & tab & (name of tr) & tab & (artist of tr) & tab & (album of tr) & tab & (duration of tr) & tab & (player position) & tab & (sound volume) & tab & art
end tell`;

const guarded = (action) => `if application "Spotify" is running then
	tell application "Spotify" to ${action}
end if`;

const num = (v) => Number(String(v).replace(',', '.')) || 0;

export function createAdapter() {
  let artUrl = '';
  let artCache = { url: '', data: null };

  return {
    async status() {
      const out = await osa(STATUS);
      if (out === 'off') return { run: false };
      const [, state, title = '', artist = '', album = '', durMs = '0', pos = '0', vol = '', art = ''] = out.split('\t');
      artUrl = art;
      return {
        run: true,
        playing: state === 'playing',
        title, artist, album,
        pos: Math.round(num(pos) * 10) / 10,
        dur: Math.round(num(durMs) / 100) / 10,
        vol: vol === '' ? null : Math.round(num(vol)),
        cover: art ? crypto.createHash('md5').update(art).digest('hex').slice(0, 10) : '',
      };
    },
    async cover() {
      if (!/^https:\/\/[a-z0-9.-]+\//i.test(artUrl)) return null;
      if (artCache.url === artUrl) return artCache.data;
      const r = await fetch(artUrl);
      if (!r.ok) return null;
      artCache = { url: artUrl, data: Buffer.from(await r.arrayBuffer()) };
      return artCache.data;
    },
    async command(c, a) {
      switch (c) {
        case 'toggle': return void (await osa(guarded('playpause')));
        case 'pause': return void (await osa(guarded('pause')));
        case 'resume': return void (await osa(guarded('play')));
        case 'next': return void (await osa(guarded('next track')));
        case 'prev': return void (await osa(guarded('previous track')));
        case 'volume': return void (await osa(guarded(`set sound volume to ${Number(a)}`)));
        case 'seek': return void (await osa(guarded(`set player position to ${Number(a)}`)));
        default: throw new Error('comando no válido');
      }
    },
  };
}
