import { v2 as cloudinary } from 'cloudinary'
import streamifier from 'streamifier'

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const FOLDER = 'uacc-dims'
const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB

// Cloudinary treats "image" as its own resource type with image-specific
// transforms/derivatives available; everything else (PDF, DOCX, XLSX, ...)
// has to go in as "raw" — it's stored as-is, no transformation pipeline.
function resourceTypeForMime(mimeType) {
  return mimeType && mimeType.startsWith('image/') ? 'image' : 'raw'
}

// Uploads a buffer (as already read into memory by multer) via Cloudinary's
// upload_stream, so we don't need to write the file to disk first.
export function uploadFile(fileBuffer, originalName, mimeType, options = {}) {
  if (!fileBuffer || fileBuffer.length === 0) {
    return Promise.reject(new Error('No file content to upload'))
  }
  if (fileBuffer.length > MAX_FILE_SIZE) {
    return Promise.reject(new Error('File exceeds the 25MB limit'))
  }

  const resourceType = options.resourceType || resourceTypeForMime(mimeType)

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: FOLDER,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        filename_override: originalName,
        ...options,
      },
      (err, result) => {
        if (err) return reject(err)
        resolve(result)
      }
    )
    streamifier.createReadStream(fileBuffer).pipe(uploadStream)
  })
}

export function deleteFile(publicId, resourceType = 'raw') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
}

// Signed, time-limited URL for a given public_id. Note: expiry is only
// actually *enforced* by Cloudinary for resources uploaded with delivery
// type "authenticated" — uploadFile() above uses the default "upload" type
// (matching the directive's plain image/raw split), so today this mainly
// guards against URL guessing/tampering rather than truly locking access
// down after expiresInSec. Revisit the upload delivery type if real
// enforced expiry is needed later.
export function generateSignedUrl(publicId, resourceType = 'raw', expiresInSec = 3600) {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSec
  return cloudinary.url(publicId, {
    resource_type: resourceType,
    type: 'upload',
    sign_url: true,
    expires_at: expiresAt,
  })
}

export function getFileInfo(publicId, resourceType = 'raw') {
  return cloudinary.api.resource(publicId, { resource_type: resourceType })
}

// Cloudinary's admin API scopes a single call to one resource_type, so
// listing everything under our folder means querying "image" and "raw"
// separately and merging — most recently uploaded first, capped at
// maxResults total across both.
export async function listFiles(maxResults = 50) {
  const [images, raw] = await Promise.all([
    cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix: FOLDER, max_results: maxResults }),
    cloudinary.api.resources({ type: 'upload', resource_type: 'raw', prefix: FOLDER, max_results: maxResults }),
  ])

  return [...images.resources, ...raw.resources]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, maxResults)
}
