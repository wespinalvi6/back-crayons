const express = require("express");
const router = express.Router();
const aiAssistantController = require("../controllers/aiAssistantController");

const { verifyToken } = require("../middleware/auth");

router.post("/", verifyToken, aiAssistantController.aiAssistant);

module.exports = router;
