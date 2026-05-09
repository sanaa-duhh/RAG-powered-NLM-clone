'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const uploadRoutes = require('./routes/upload');
const chatRoutes = require('./routes/chat');
const errorHandler = require('./middleware/errorHandler');
const { logInfo, logWarn, logError } = require('./utils/logger');
const { validateEnv } = require('./config/validateEnv');
const { initializeCollection } = require('./rag/vectorStore');

validateEnv();

// --- Ensure uploads directory exists (defensive — also tracked via .gitkeep) ---
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// --- App setup ---
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());

// CORS: allow all origins in dev, restrict to CLIENT_URL in prod
app.use(
  cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.CLIENT_URL : '*',
    methods: ['GET', 'POST'],
  }),
);

// HTTP request logging (morgan format: concise in dev, combined in prod)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing — explicit 1MB limit prevents oversized JSON payloads
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- Routes ---
app.use('/api', uploadRoutes);
app.use('/api', chatRoutes);

// Health check — used by Render to verify the service is up
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// 404 — catches any unmatched route
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'ROUTE_NOT_FOUND' });
});

// Centralized error handler — must be the LAST middleware registered
app.use(errorHandler);

// --- Start ---
app.listen(PORT, () => {
  logInfo(`Server running on port ${PORT}`);
  logInfo(`Health: http://localhost:${PORT}/api/health`);

  // Qdrant startup check — runs after server is listening so it doesn't block startup.
  // In development without QDRANT_URL set, skip gracefully.
  if (process.env.QDRANT_URL) {
    initializeCollection()
      .then(({ created, pointCount }) => {
        if (created) {
          logInfo('Qdrant collection created and ready');
        } else {
          logInfo(`Qdrant collection verified — ${pointCount} point(s) stored`);
        }
      })
      .catch((err) => {
        logError('QDRANT', `Startup check failed: ${err.message}`);
        logError('QDRANT', 'Upload endpoint will fail until Qdrant is reachable');
      });
  } else {
    logWarn('QDRANT', 'QDRANT_URL not set — vector storage disabled (set it to enable uploads)');
  }
});
