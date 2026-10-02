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

// 1 つの区切りの大きさがこれを超えたら分ける。OpenAI の文字起こしは 25MB まで、
// Gemini のインラインは 20MB までなので、小さいほうに合わせる
export const SPLIT_BYTES = 20 * 1024 * 1024;
// 長さの上限が無いモデルで、大きさだけ超えたときの区切りの長さ
export const FALLBACK_SPLIT_SEC = 600;

// 分けるか、分けるならどの長さで切るか。分けないときは null。
// durationSec が 0（長さが読めなかったアップロード）なら、大きさから 64kbps 相当（size / 8000 秒）で概算する
export function planSplit({ size, durationSec, maxSec }) {
  const dur = durationSec > 0 ? durationSec : size / 8000;
  const tooLong = maxSec > 0 && dur > maxSec;
  const tooBig = size > SPLIT_BYTES;
  if (!tooLong && !tooBig) return null;
  let sec = maxSec > 0 ? maxSec : FALLBACK_SPLIT_SEC;
  if (tooBig && dur > 0) {
    // 切った 1 つが 20MB に収まるよう、1 秒あたりの大きさから逆算する（余裕を 2 割とる）
    sec = Math.min(sec, Math.max(30, Math.floor((SPLIT_BYTES * 0.8) / (size / dur))));
  }
  return { splitSec: sec };
}

const normMime = (m) => String(m ?? '').toLowerCase().split(';')[0].trim();
const isAac = (m) => ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'video/mp4'].includes(m);
const isMp3 = (m) => m === 'audio/mpeg' || m === 'audio/mp3';

// 区切りを maxSec 秒ごとに分ける。戻り値は { files, mime }（部品の MIME を文字起こしに渡す）。
//
// AAC（m4a / mp4）と mp3 は、まず再エンコードせずに（-c:a copy）切る。
// 2 時間の音声で、再エンコードは 1〜2 分かかるが、コピーなら数秒で済むため。
// コピーが失敗したとき（ffmpeg が非 0 で終わる、部品が 0 個）は、mp3 への再エンコードに落ちる。
// webm / ogg（Opus）はコピーで切ると Gemini が受けないことがあるので、最初から再エンコードする。
//
// 時刻: -reset_timestamps 1 で各部品は 0 から始まる。コピーの切れ目はフレーム境界なので、
// 部品の長さは maxSec ちょうどにならず、通しの時刻（i * maxSec）に 1 秒未満のずれが出る。許容する
export async function splitAudio(io, ffmpeg, dir, inFile, maxSec, inMime = '') {
  const m = normMime(inMime);
  const copyKind = isAac(m) ? 'm4a' : isMp3(m) ? 'mp3' : null;
  const list = async (ext) =>
    (await io.readdir(dir)).filter((n) => n.startsWith('part-') && n.endsWith('.' + ext)).sort().map((n) => join(dir, n));

  if (copyKind) {
    const pattern = join(dir, `part-%03d.${copyKind}`);
    const args = ['-y', '-i', inFile, '-vn', '-c:a', 'copy', '-f', 'segment', '-segment_time', String(maxSec), '-reset_timestamps', '1'];
    if (copyKind === 'm4a') args.push('-segment_format', 'ipod');
    args.push(pattern);
    try {
      await io.exec(ffmpeg, args);
      const files = await list(copyKind);
      if (files.length > 0) return { files, mime: copyKind === 'm4a' ? 'audio/mp4' : 'audio/mp3' };
    } catch { /* 再エンコードに落ちる */ }
    // 途中までできた部品を消す（mp3 のコピーと再エンコードは名前が同じ）
    for (const f of await list(copyKind)) await io.rm(f);
  }

  const pattern = join(dir, 'part-%03d.mp3');
  await io.exec(ffmpeg, [
    '-y', '-i', inFile, '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '48k',
    '-f', 'segment', '-segment_time', String(maxSec), '-reset_timestamps', '1', pattern,
  ]);
  return { files: await list('mp3'), mime: 'audio/mp3' };
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
