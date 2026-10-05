const multer = require('multer');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

function fileFilter(allowedTypes) {
  return (req, file, cb) => {
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  };
}

// Property media: images or videos, up to 100MB (videos are the large case).
const uploadPropertyMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: fileFilter([...IMAGE_TYPES, ...VIDEO_TYPES]),
});

// Project media: images or videos, up to 100MB - mirrors uploadPropertyMedia.
const uploadProjectMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: fileFilter([...IMAGE_TYPES, ...VIDEO_TYPES]),
});

// Profile pictures: images only, up to 5MB.
const uploadProfilePicture = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter(IMAGE_TYPES),
});

// Admin bulk imports (localities, circle rates, stamp duty, auction lists):
// CSV only, up to 5MB. Browsers report CSV under several mimetypes.
const CSV_TYPES = ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'];
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter(CSV_TYPES),
});

// Careers applications ("Work With Us"): resume as PDF/DOC/DOCX, up to 5MB.
const DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const uploadResume = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter(DOCUMENT_TYPES),
});

// Deal / customer documents (KYC, agreements, receipts): PDF, Office docs
// or images, up to 20MB.
const uploadDocumentFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: fileFilter([
    ...DOCUMENT_TYPES,
    ...IMAGE_TYPES,
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
});

// Auction / sale notices for the parser: PDF (text or scanned), a photo /
// scan of the notice, or plain text, up to 20MB.
const uploadNoticeFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: fileFilter(['application/pdf', 'text/plain', 'image/jpeg', 'image/png', 'image/webp']),
});

module.exports = {
  uploadNoticeFile,
  uploadDocumentFile,
  uploadPropertyMedia,
  uploadProjectMedia,
  uploadProfilePicture,
  uploadCsv,
  uploadResume,
  IMAGE_TYPES,
  VIDEO_TYPES,
};
