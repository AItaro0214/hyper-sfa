// zip（PK）をブラウザだけで展開する。ライブラリを入れないのは、ビルド無しで配信する決まりのため。
// pptx / xlsx は zip なので、これで中の XML を読める。ZIP64 は非対応（資料は 20MB 以下の前提）。

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('このブラウザは資料の展開に対応していません。新しい Chrome / Edge / Safari で開いてください。');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// filter(path) が false を返したエントリは展開しない。pptx の画像のような大きな物を飛ばして速くするため。
export async function readZip(arrayBuffer, { filter } = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  // 末尾のコメントが最大 65535 バイトあるので、その範囲だけ後ろから探す
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('zip として読めませんでした。壊れているか、パスワード付きの可能性があります。');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new ZipError('大きすぎる zip（ZIP64）には対応していません。');

  const dec = new TextDecoder('utf-8');
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError('zip の目次が壊れています。');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (filter && !filter(name)) continue;
    if (flags & 1) throw new ZipError('パスワード付きのファイルは読めません。');
    // データの位置は、中央ディレクトリの値ではなくローカルヘッダの名前・追加欄の長さで決まる
    if (localOff + 30 > bytes.length || dv.getUint32(localOff, true) !== SIG_LOC) throw new ZipError('zip の中身が壊れています。');
    const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    const raw = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new ZipError(`未対応の圧縮方式です（${method}）。`);
  }
  return out;
}
