const mongoose = require('mongoose');

const NftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  symbol: {
    type: String,
    required: true,
    trim: true
  },
  uri: {
    type: String,
    required: true,
    trim: true
  },
  universityWallet: {
    type: String,
    required: true,
    trim: true
  },
  studentWallet: {
    type: String,
    required: true,
    trim: true
  },
  universityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'University',
    index: true
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  universityWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    index: true
  },
  studentWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    index: true
  },
  sellerFeeBasisPoints: {
    type: Number,
    default: 500 // 5% royalty
  },
  minted: {
    type: Boolean,
    default: false
  },
  allocated: {
    type: Boolean,
    default: true
  },
  allocatedAt: {
    type: Date,
    default: Date.now
  },
  mintedAt: {
    type: Date
  },
  nftAddress: {
    type: String,
  },


  // This are not Updated , Create them after Exam 
  nftStatus: {
    type: String,
    enum: ["PENDING_CONFIRMATION", "CONFIRMED", "AUTO_CONFIRMED", "MINTED"],
    default: "PENDING_CONFIRMATION"
  },
  confirmationDeadline: {
    type: Date,
    default: function() {
      // Set
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 7);
      return deadline;
    }
  },
  isConfirmed: {
    type: Boolean,
    default: false
  },
  confirmedAt: {
    type: Date
  },
  wasAutoConfirmed: {
    type: Boolean,
    default: false
  },
  

});

module.exports = mongoose.model('Allocated NFT Detalis', NftSchema);