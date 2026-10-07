import 'dotenv/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const accountId = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
export const storageConfigured = Boolean(accountId && bucket && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const localStorageEnabled = process.env.NODE_ENV === 'development' && !storageConfigured;
export const storageProvider = storageConfigured ? 'r2' : localStorageEnabled ? 'local' : null;
const localRoot = resolve(process.env.LOCAL_STORAGE_DIR || 'private-storage');
const localBaseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3001';

function localObjectPath(key: string) {
  const parts = key.split('/');
  if (!key || parts.some(part => !part || part === '.' || part === '..' || !/^[\w.-]+$/.test(part))) throw new Error('Invalid private file key.');
  const target = resolve(localRoot, ...parts);
  if (!target.toLowerCase().startsWith(`${localRoot.toLowerCase()}${sep}`)) throw new Error('Invalid private file key.');
  return target;
}

function localSignature(action: string, key: string, expires: number) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required for local file storage.');
  return createHmac('sha256', secret).update(`${action}\n${key}\n${expires}`).digest('hex');
}

function localUrl(action: 'upload' | 'file', key: string) {
  const expires = Date.now() + (action === 'upload' ? 10 : 5) * 60 * 1000;
  const url = new URL(`/api/local-storage/${action}`, localBaseUrl);
  url.searchParams.set('key', key);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('signature', localSignature(action, key, expires));
  return url.toString();
}

function verifyLocalUrl(req: Request, action: 'upload' | 'file') {
  if (!localStorageEnabled) throw new Error('Local file storage is disabled.');
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const expires = Number(req.query.expires);
  const signature = typeof req.query.signature === 'string' ? req.query.signature : '';
  if (!key || !Number.isSafeInteger(expires) || expires < Date.now() || expires > Date.now() + 10 * 60 * 1000) throw new Error('This private file link has expired.');
  localObjectPath(key);
  const expected = Buffer.from(localSignature(action, key, expires), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid private file link.');
  return { key, target: localObjectPath(key) };
}

export async function receiveLocalUpload(req: Request, res: Response) {
  const { key, target } = verifyLocalUrl(req, 'upload');
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await pipeline(req, createWriteStream(temporary, { flags: 'wx' }));
  await rename(temporary, target);
  await writeFile(`${target}.meta.json`, JSON.stringify({ contentType: req.headers['content-type'] || 'application/octet-stream' }));
  res.setHeader('ETag', `"${randomUUID()}"`);
  res.sendStatus(204);
}

export async function sendLocalFile(req: Request, res: Response) {
  const { target } = verifyLocalUrl(req, 'file');
  const [file, metadata] = await Promise.all([stat(target), readFile(`${target}.meta.json`, 'utf8').catch(() => '')]);
  if (!file.isFile()) return res.sendStatus(404);
  const contentType = metadata ? (JSON.parse(metadata) as { contentType?: string }).contentType : undefined;
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  createReadStream(target).on('error', () => { if (!res.headersSent) res.sendStatus(404); else res.destroy(); }).pipe(res);
}

const s3 = storageConfigured ? new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
}) : null;

const client = () => {
  if (!s3 || !bucket) throw new Error('Private file storage is not configured.');
  return { s3, bucket };
};

export async function beginMultipart(key: string, contentType: string) {
  const { s3, bucket } = client();
  const result = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  if (!result.UploadId) throw new Error('Storage did not create an upload.');
  return result.UploadId;
}

export async function signPart(key: string, uploadId: string, partNumber: number) {
  const { s3, bucket } = client();
  return getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 600 });
}

export async function listParts(key: string, uploadId: string) {
  const { s3, bucket } = client();
  const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
  let marker: string | undefined;
  do {
    const response = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    parts.push(...(response.Parts || []).map(part => ({ partNumber: part.PartNumber!, etag: part.ETag!, size: part.Size || 0 })));
    marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
  } while (marker !== undefined);
  return parts;
}

export async function finishMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
  const { s3, bucket } = client();
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: bucket, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })) },
  }));
}

export async function cancelMultipart(key: string, uploadId: string) {
  const { s3, bucket } = client();
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

export async function signPut(key: string, contentType: string) {
  if (localStorageEnabled) return localUrl('upload', key);
  const { s3, bucket } = client();
  return getSignedUrl(s3, new (await import('@aws-sdk/client-s3')).PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 600 });
}

export async function signGet(key: string) {
  if (localStorageEnabled) return localUrl('file', key);
  const { s3, bucket } = client();
  return getSignedUrl(s3, new (await import('@aws-sdk/client-s3')).GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

export async function objectExists(key: string) {
  if (localStorageEnabled) {
    try { return (await stat(localObjectPath(key))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  const { s3, bucket } = client();
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false; throw error; }
}

export async function objectMetadata(key: string) {
  if (localStorageEnabled) {
    const target = localObjectPath(key);
    const [file, metadata] = await Promise.all([stat(target), readFile(`${target}.meta.json`, 'utf8').catch(() => '')]);
    return { contentLength: file.size, contentType: metadata ? (JSON.parse(metadata) as { contentType?: string }).contentType || '' : '' };
  }
  const { s3, bucket } = client();
  const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { contentLength: response.ContentLength || 0, contentType: response.ContentType || '' };
}

export async function deleteObject(key: string) {
  if (localStorageEnabled) {
    const target = localObjectPath(key);
    await Promise.all([rm(target, { force: true }), rm(`${target}.meta.json`, { force: true })]);
    return;
  }
  const { s3, bucket } = client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
