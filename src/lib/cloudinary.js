import cloudinary from 'cloudinary'

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

export async function uploadToCloudinary(buffer, filename, mimetype, folder = '') {
  const res = await cloudinary.v2.uploader.upload_stream({
    resource_type: 'auto',
    folder,
    public_id: filename.replace(/\.[^/.]+$/, '') + '-' + Date.now(),
  })
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream({ folder }, (error, result) => {
      if (error) return reject(error)
      resolve(result)
    })
    stream.end(buffer)
  })
}

export async function deleteFromCloudinary(publicId) {
  return cloudinary.v2.uploader.destroy(publicId)
}
