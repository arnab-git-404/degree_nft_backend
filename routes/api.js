const express = require('express');
const nftController = require('../controllers/nftController');
const universityController = require('../controllers/universityController');


const router = express.Router();


// NFT routes
router.post('/create-nft-ipfsHash-allocation', nftController.createNftAllocation);
router.get('/check-authorization/:walletAddress', nftController.checkAuthorization);
router.post('/confirm-mint', nftController.confirmMint);
router.get('/minted-nfts/:walletAddress', nftController.getMintedNfts);
router.post('/confirm-nft-credential', nftController.confirmCredential );
router.post('/report-issue' , nftController.createReport);


//University Routes
router.post('/batch-upload', universityController.batchUpload);
router.get('/get-all-uploaded-data', universityController.getAllUploadedData);
router.post('/update-nft-allocations/:walletAddress', universityController.updateNftAllocations);
router.get('/get-reports' , universityController.getAllReports);


module.exports = router;