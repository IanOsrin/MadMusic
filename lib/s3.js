import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
})

const BUCKET = process.env.S3_BUCKET
const BASE   = (process.env.S3_BASE_URL || '').replace(/\/$/, '')

/**
 * Upload a buffer to S3 and return its public URL.
 */
export async function uploadToS3(key, buffer, contentType, cacheControl = 'public, max-age=31536000') {
  if (!BUCKET) throw new Error('S3_BUCKET not configured')
  await s3.send(new PutObjectCommand({
    Bucket:       BUCKET,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType,
    CacheControl: cacheControl
  }))
  return `${BASE}/${key}`
}

export const uploadMp3      = (key, buf) => uploadToS3(key, buf, 'audio/mpeg')
export const uploadWaveform = (key, buf) => uploadToS3(key, buf, 'application/json')
export const uploadArtwork  = (key, buf) => uploadToS3(key, buf, 'image/jpeg')
