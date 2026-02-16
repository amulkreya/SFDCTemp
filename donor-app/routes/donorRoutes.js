const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/authMiddleware');
const donorController = require('../controllers/donorController');

router.get('/', isAuthenticated, donorController.listDonors);
router.post('/new', isAuthenticated, donorController.createDonor);
router.get('/search', isAuthenticated, donorController.searchDonor);

module.exports = router;
