const mongoose = require('mongoose');

const StudentDetailsSchema = new mongoose.Schema({
    studentName: {
        type: String,
        required: true,
        trim: true
    },
    studentWalletAddress: {
        type: String,
        required: true,
        trim: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    universityId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'University',
        index: true
    },
    studentWalletId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Wallet',
        index: true
    },
    universityWalletId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Wallet',
        index: true
    },
    studentTotalMintedNFT: {
        type: Number,
        default: 0
    },
    universityWalletAddress: {
        type: String,
        required: true,
        trim: true
    },
    universityName: {
        type: String,
        required: true,
        trim: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    totalAllocatedNFTs: {
        type: Number,
        default: 0
    },
});

module.exports = mongoose.model('StudentDetails', StudentDetailsSchema);

