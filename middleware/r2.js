const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

// Cloudflare R2 client (S3-compatible)
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

async function uploadImageToR2(file) {
    if (!file) return null;
    const ext = path.extname(file.originalname);
    const key = `products/${crypto.randomUUID()}${ext}`;

    await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
    }));

    return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function deleteImageFromR2(imageUrl) {
    if (!imageUrl || !process.env.R2_PUBLIC_URL) return;
    const key = imageUrl.replace(`${process.env.R2_PUBLIC_URL}/`, '');
    try {
        await s3.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key
        }));
    } catch (err) {
        console.error('Failed to delete image from R2:', err.message);
    }
}

module.exports = { upload, uploadImageToR2, deleteImageFromR2 };
