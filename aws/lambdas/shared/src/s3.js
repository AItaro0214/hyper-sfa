// S3。バケットは名前そのもの、または 'image' | 'audio' | 'data' | 'export' で渡す。
// 後者は環境変数（IMAGE_BUCKET / AUDIO_BUCKET / DATA_BUCKET / EXPORT_BUCKET）から引く。
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3c = null;
const client = () => (s3c ??= new S3Client({}));

const ENV = { image: 'IMAGE_BUCKET', audio: 'AUDIO_BUCKET', data: 'DATA_BUCKET', export: 'EXPORT_BUCKET' };
function bucketName(b) {
  const name = ENV[b] ? process.env[ENV[b]] : b;
  if (!name) throw new Error('バケット名が未設定です');
  return name;
}

// ダウンロード時のファイル名。日本語は RFC 5987 の形で渡し、古い環境向けに ASCII の代わりも付ける
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const s3 = {
  async presignPut({ bucket, key, contentType, expiresSec = 900 }) {
    const cmd = new PutObjectCommand({ Bucket: bucketName(bucket), Key: key, ContentType: contentType });
    // Content-Type を署名に含める。違う種類のファイルを同じ URL で置かれないようにするため
    return getSignedUrl(client(), cmd, { expiresIn: expiresSec, signableHeaders: new Set(['content-type']) });
  },

  async presignGet({ bucket, key, expiresSec = 900, filename }) {
    const cmd = new GetObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      ...(filename ? { ResponseContentDisposition: contentDisposition(filename) } : {}),
    });
    return getSignedUrl(client(), cmd, { expiresIn: expiresSec });
  },

  /** Body のストリームを含む応答をそのまま返す。 */
  async getObject({ bucket, key }) {
    return client().send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  },

  async getObjectBuffer({ bucket, key }) {
    const r = await client().send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  },

  async putObject({ bucket, key, body, contentType }) {
    await client().send(new PutObjectCommand({ Bucket: bucketName(bucket), Key: key, Body: body, ContentType: contentType }));
  },

  async deleteObject({ bucket, key }) {
    await client().send(new DeleteObjectCommand({ Bucket: bucketName(bucket), Key: key }));
  },

  /** 無ければ null。あれば { size, contentType }。 */
  async headObject({ bucket, key }) {
    try {
      const r = await client().send(new HeadObjectCommand({ Bucket: bucketName(bucket), Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch (e) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  },

  /** prefix で始まるキーの配列。 */
  async listPrefix({ bucket, prefix }) {
    const out = [];
    let token;
    do {
      const r = await client().send(new ListObjectsV2Command({ Bucket: bucketName(bucket), Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  },
};
