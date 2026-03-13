const express = require('express');
const router = express.Router();
const chat = require('../controllers/chatController');
const { verifyToken } = require('../middleware/auth');

// Simple health route for chat module
router.get('/status', (req, res) => {
  res.json({ ok: true, module: 'chat' });
});

// Chat endpoint (requires auth)
router.post('/', verifyToken, chat);

module.exports = router;
