'use strict';
const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const fmt = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fmt.combine(
    fmt.timestamp({ format: 'HH:mm:ss' }),
    fmt.errors({ stack: true }),
    fmt.json()
  ),
  transports: [
    new winston.transports.Console({
      format: fmt.combine(
        fmt.colorize(),
        fmt.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
      ),
    }),
  ],
});

if (process.env.LOG_TO_FILE !== 'false') {
  logger.add(new winston.transports.File({
    filename: path.join(logsDir, 'scraper.log'),
    maxsize: 5 * 1024 * 1024,
    maxFiles: 5,
  }));
  logger.add(new winston.transports.File({
    filename: path.join(logsDir, 'errors.log'),
    level: 'error',
  }));
}

module.exports = logger;
