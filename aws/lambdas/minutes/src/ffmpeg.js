// ffmpeg は Lambda layer から使う（/opt/bin/ffmpeg）。パッケージには入れない。
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const defaultIo = {
  exec: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
    }),
  exists: async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  mkdtemp: () => mkdtemp(join(tmpdir(), 'min-')),
  readdir,
  readFile,
  writeFile,
  rm: (p) => rm(p, { recursive: true, force: true }),
};

export function ffmpegPath(env) {
  return env.FFMPEG_PATH || '/opt/bin/ffmpeg';
}

// 区切りを maxSec 秒ごとに分ける。どのモデルでも受け付けやすい mp3（モノラル）にする
export async function splitAudio(io, ffmpeg, dir, inFile, maxSec) {
  const pattern = join(dir, 'part-%03d.mp3');
  await io.exec(ffmpeg, [
    '-y', '-i', inFile, '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k',
    '-f', 'segment', '-segment_time', String(maxSec), '-reset_timestamps', '1', pattern,
  ]);
  const names = (await io.readdir(dir)).filter((n) => /^part-\d+\.mp3$/.test(n)).sort();
  return names.map((n) => join(dir, n));
}

// 区切りを順につなげて M4A（AAC 48kbps、モノラル）にする
export async function concatToM4a(io, ffmpeg, dir, files, outFile) {
  // concat の一覧では、パスの ' を '\'' にして囲む
  const quote = (f) => "'" + f.split('\\').join('/').split("'").join("'\\''") + "'";
  const list = files.map((f) => 'file ' + quote(f)).join('\n');
  const listFile = join(dir, 'list.txt');
  await io.writeFile(listFile, list);
  await io.exec(ffmpeg, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', outFile,
  ]);
}
