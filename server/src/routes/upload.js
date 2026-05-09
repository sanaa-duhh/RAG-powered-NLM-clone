'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const { uploadDocument } = require('../controllers/uploadController');
const config = require('../config');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (_req, file, cb) => {
    // Timestamp prefix avoids collisions; original name preserved for debugging
    const uniquePrefix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniquePrefix}-${file.originalname}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error('Only PDF and TXT files are allowed');
    err.code = 'UNSUPPORTED_TYPE';
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxSizeBytes },
});

// POST /api/upload
// Multer validates type + size and saves the file, then uploadDocument handles the response.
// On rejection, multer calls next(err) which flows to errorHandler.
router.post('/upload', upload.single('file'), uploadDocument);

module.exports = router;
