import NFT from "../models/nft.js";
import Reports from "../models/reports.js";
import University from "../models/university.js";
import Wallet from "../models/wallet.js";
import StudentDetails from "../models/studentDetails.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import { findOrCreateUserByWallet } from "../services/userWalletService.js";

const getStudentWallet = async (user, walletAddress) => {
  if (walletAddress) {
    if (!isValidSolanaAddress(walletAddress)) {
      throw new AppError("Invalid Solana wallet address", 400);
    }

    const wallet = await Wallet.findOne({
      chain: "solana",
      address: walletAddress,
      userId: user._id,
    });

    if (wallet) {
      return wallet;
    }

    if (user.roleId?.name === "admin") {
      const anyWallet = await Wallet.findOne({
        chain: "solana",
        address: walletAddress,
      });

      return anyWallet || { address: walletAddress, _id: null, userId: null };
    }

    throw new AppError("Wallet is not linked to your account", 403);
  }

  const wallet = await Wallet.findOne({ userId: user._id }).sort({
    isPrimary: -1,
    createdAt: 1,
  });

  if (!wallet) {
    throw new AppError("No wallet is linked to this account", 400);
  }

  return wallet;
};

const walletFilter = (wallet) => {
  const conditions = [{ studentWallet: wallet.address }];

  if (wallet._id) {
    conditions.push({ studentWalletId: wallet._id });
  }

  return { $or: conditions };
};

const resolveUniversityReferences = async (nft) => {
  let universityId = nft.universityId;
  let universityWalletId = nft.universityWalletId;

  if (!universityId && nft.universityWallet) {
    const university = await University.findOne({
      walletAddress: nft.universityWallet,
    });

    if (university) {
      universityId = university._id;
    }
  }

  if (!universityWalletId && nft.universityWallet) {
    const wallet = await Wallet.findOne({
      chain: "solana",
      address: nft.universityWallet,
    });

    if (wallet) {
      universityWalletId = wallet._id;
    }
  }

  return { universityId, universityWalletId };
};

export const createNftAllocation = asyncHandler(async (req, res) => {
  const {
    studentWallet,
    name,
    symbol,
    uri,
    ipfsHash,
    sellerFeeBasisPoints,
  } = req.body;

  if (!studentWallet || !name || !symbol || !uri || !ipfsHash) {
    throw new AppError("Missing required fields for NFT allocation", 400);
  }

  if (!isValidSolanaAddress(studentWallet)) {
    throw new AppError("Invalid student wallet address", 400);
  }

  let university;

  if (req.user.roleId?.name === "admin" && req.body.universityId) {
    university = await University.findById(req.body.universityId);
  } else {
    university = await University.findOne({ userId: req.user._id });
  }

  if (!university) {
    throw new AppError(
      "University profile not found. Create a university profile first.",
      400
    );
  }

  const existingAllocation = await NFT.findOne({
    ipfsHash,
    studentWallet,
    $or: [
      { universityId: university._id },
      { universityWallet: university.walletAddress },
    ],
  });

  if (existingAllocation) {
    throw new AppError(
      "NFT allocation already exists for this combination",
      409
    );
  }

  const { user: student, wallet: studentWalletDocument } =
    await findOrCreateUserByWallet(studentWallet);

  const universityWallet = await Wallet.findOne({
    chain: "solana",
    address: university.walletAddress,
  });

  if (universityWallet && !university.walletId) {
    university.walletId = universityWallet._id;
    await university.save();
  }

  const allocation = await NFT.create({
    name,
    symbol,
    uri,
    ipfsHash,
    universityWallet: university.walletAddress,
    studentWallet,
    universityId: university._id,
    studentId: student._id,
    universityWalletId: universityWallet?._id,
    studentWalletId: studentWalletDocument._id,
    sellerFeeBasisPoints,
    allocated: true,
    allocatedAt: new Date(),
    minted: false,
  });

  await StudentDetails.findOneAndUpdate(
    { universityId: university._id, studentId: student._id },
    {
      $setOnInsert: {
        studentName: student.name,
        studentWalletAddress: studentWallet,
        studentId: student._id,
        universityId: university._id,
        studentWalletId: studentWalletDocument._id,
        universityWalletId: universityWallet?._id,
        universityWalletAddress: university.walletAddress,
        universityName: university.name,
      },
      $inc: { totalAllocatedNFTs: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await University.updateOne(
    { _id: university._id },
    { $inc: { totalAllocated: 1 } }
  );

  res.status(201).json({
    success: true,
    message: "NFT allocation created successfully in database",
    allocation,
  });
});

export const checkAuthorization = asyncHandler(async (req, res) => {
  const { walletAddress } = req.params;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const unmintedAllocation = await NFT.findOne({
    allocated: true,
    minted: false,
    ...walletFilter(wallet),
  })
    .sort({ allocatedAt: 1 })
    .populate("universityId", "name code walletAddress");

  const existingReport = await Reports.findOne(walletFilter(wallet));

  if (unmintedAllocation) {
    res.status(200).json({
      authorized: true,
      existingReport: Boolean(existingReport),
      nftInfo: {
        _id: unmintedAllocation._id,
        name: unmintedAllocation.name,
        symbol: unmintedAllocation.symbol,
        uri: unmintedAllocation.uri,
        ipfsHash: unmintedAllocation.ipfsHash,
        confirmationStatus: unmintedAllocation.nftStatus,
        sellerFeeBasisPoints: unmintedAllocation.sellerFeeBasisPoints,
        universityName: unmintedAllocation.universityId?.name || null,
      },
    });
    return;
  }

  const anyAllocation = await NFT.findOne(walletFilter(wallet));

  if (anyAllocation) {
    res.status(200).json({
      authorized: false,
      existingReport: Boolean(existingReport),
      message:
        "All NFTs have already been minted for this wallet, or no new NFTs are ready for minting.",
    });
    return;
  }

  res.status(200).json({
    authorized: false,
    existingReport: Boolean(existingReport),
    message: "No NFT allocation found for this wallet.",
  });
});

export const confirmCredential = asyncHandler(async (req, res) => {
  const { walletAddress, nftId } = req.body;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const filter = {
    allocated: true,
    minted: false,
    ...walletFilter(wallet),
  };

  if (nftId) {
    filter._id = nftId;
  }

  const nft = await NFT.findOne(filter).sort({ allocatedAt: 1 });

  if (!nft) {
    throw new AppError("NFT allocation not found", 404);
  }

  if (!nft.studentId && wallet.userId) {
    nft.studentId = wallet.userId;
  }

  if (!nft.studentWalletId && wallet._id) {
    nft.studentWalletId = wallet._id;
  }

  nft.nftStatus = "CONFIRMED";
  nft.isConfirmed = true;
  nft.confirmedAt = new Date();

  await nft.save();

  res.status(200).json({
    success: true,
    message: "NFT details are confirmed",
  });
});

export const confirmMint = asyncHandler(async (req, res) => {
  const { walletAddress, nft_Mint_Address, nftId } = req.body;

  if (!nft_Mint_Address || !isValidSolanaAddress(nft_Mint_Address)) {
    throw new AppError("A valid nft_Mint_Address is required", 400);
  }

  const wallet = await getStudentWallet(req.user, walletAddress);

  const filter = {
    allocated: true,
    minted: false,
    ...walletFilter(wallet),
  };

  if (nftId) {
    filter._id = nftId;
  }

  const allocation = await NFT.findOne(filter).sort({ allocatedAt: 1 });

  if (!allocation) {
    throw new AppError(
      "Wallet not authorized or NFT already minted/not allocated",
      403
    );
  }

  if (!allocation.studentId && wallet.userId) {
    allocation.studentId = wallet.userId;
  }

  if (!allocation.studentWalletId && wallet._id) {
    allocation.studentWalletId = wallet._id;
  }

  const { universityId, universityWalletId } =
    await resolveUniversityReferences(allocation);

  if (!allocation.universityId && universityId) {
    allocation.universityId = universityId;
  }

  if (!allocation.universityWalletId && universityWalletId) {
    allocation.universityWalletId = universityWalletId;
  }

  allocation.nftStatus = "MINTED";
  allocation.minted = true;
  allocation.mintedAt = new Date();
  allocation.nftAddress = nft_Mint_Address;

  await allocation.save();

  if (allocation.universityId) {
    await University.updateOne(
      { _id: allocation.universityId },
      { $inc: { totalMinted: 1 } }
    );
  }

  if (allocation.universityId && allocation.studentId) {
    await StudentDetails.updateOne(
      {
        universityId: allocation.universityId,
        studentId: allocation.studentId,
      },
      { $inc: { studentTotalMintedNFT: 1 } }
    );
  }

  res.status(200).json({
    success: true,
    message: "NFT data saved successfully",
  });
});

export const getMintedNfts = asyncHandler(async (req, res) => {
  const { walletAddress } = req.params;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const mintedNfts = await NFT.find({
    minted: true,
    ...walletFilter(wallet),
  })
    .sort({ mintedAt: -1 })
    .populate("universityId", "name code walletAddress");

  const formattedNfts = mintedNfts.map((nft, index) => ({
    id: index + 1,
    nftId: nft._id,
    name: nft.name,
    issueDate: nft.allocatedAt,
    mintedDate: nft.mintedAt,
    nftAddress: nft.nftAddress,
    symbol: nft.symbol,
    uri: nft.uri,
    ipfsHash: nft.ipfsHash,
    universityName: nft.universityId?.name || null,
  }));

  res.status(200).json({ nfts: formattedNfts });
});

export const createReport = asyncHandler(async (req, res) => {
  const {
    walletAddress,
    nftIpfsHash,
    reportType,
    reportDetails,
  } = req.body;

  const studentWalletAddress = req.body.studentWallet || walletAddress;

  if (!nftIpfsHash || !reportType || !reportDetails) {
    throw new AppError("Missing required fields", 400);
  }

  const wallet = await getStudentWallet(req.user, studentWalletAddress);

  const nft = await NFT.findOne({
    $and: [
      {
        $or: [{ ipfsHash: nftIpfsHash }, { uri: nftIpfsHash }],
      },
      walletFilter(wallet),
    ],
  });

  if (!nft) {
    throw new AppError("No matching NFT was found for this report", 404);
  }

  const existingReport = await Reports.findOne({
    nftIpfsHash,
    reportType,
    ...walletFilter(wallet),
  });

  if (existingReport) {
    throw new AppError("Report already exists", 409);
  }

  const { universityId, universityWalletId } =
    await resolveUniversityReferences(nft);

  const report = await Reports.create({
    universityWallet: nft.universityWallet,
    studentWallet: wallet.address,
    universityId: universityId || undefined,
    studentId: nft.studentId || wallet.userId || req.user._id,
    universityWalletId: universityWalletId || undefined,
    studentWalletId: nft.studentWalletId || wallet._id || undefined,
    nftIpfsHash,
    reportType,
    reportDetails,
    reportedOn: new Date(),
  });

  res.status(201).json({
    success: true,
    message: "Report created successfully",
    report,
  });
});
