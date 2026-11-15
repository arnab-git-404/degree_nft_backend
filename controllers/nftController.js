import { audit } from "../utils/audit.js";
import mongoose from "mongoose";
import NFT from "../models/nft.js";
import Reports from "../models/reports.js";
import Institution from "../models/institution.js";
import Wallet from "../models/wallet.js";
import StudentDetails from "../models/studentDetails.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import { verifyCredentialMint } from "../utils/solana.js";
import { hasPermission } from "../middleware/auth.js";
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

    if (hasPermission(user, "platform:manage")) {
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

const resolveInstitutionReferences = async (nft) => {
  let institutionId = nft.institutionId;
  let institutionWalletId = nft.institutionWalletId;

  if (!institutionId && nft.institutionWallet) {
    const institution = await Institution.findOne({
      walletAddress: nft.institutionWallet,
    });

    if (institution) {
      institutionId = institution._id;
    }
  }

  if (!institutionWalletId && nft.institutionWallet) {
    const wallet = await Wallet.findOne({
      chain: "solana",
      address: nft.institutionWallet,
    });

    if (wallet) {
      institutionWalletId = wallet._id;
    }
  }

  return { institutionId, institutionWalletId };
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

  // Verified by requireInstitution: the caller's active membership, never a body field.
  const institution = req.institution;

  if (institution.verificationStatus !== "VERIFIED" || institution.status !== "ACTIVE") {
    throw new AppError(
      "Institution must be verified and active before issuing credentials",
      403
    );
  }

  const existingAllocation = await NFT.findOne({
    ipfsHash,
    studentWallet,
    $or: [
      { institutionId: institution._id },
      { institutionWallet: institution.walletAddress },
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

  const institutionWallet = await Wallet.findOne({
    chain: "solana",
    address: institution.walletAddress,
  });

  if (institutionWallet && !institution.walletId) {
    institution.walletId = institutionWallet._id;
    await institution.save();
  }

  const allocation = await NFT.create({
    name,
    symbol,
    uri,
    ipfsHash,
    institutionWallet: institution.walletAddress,
    studentWallet,
    institutionId: institution._id,
    studentId: student._id,
    institutionWalletId: institutionWallet?._id,
    studentWalletId: studentWalletDocument._id,
    sellerFeeBasisPoints,
    allocated: true,
    allocatedAt: new Date(),
    minted: false,
  });

  await StudentDetails.findOneAndUpdate(
    { institutionId: institution._id, studentId: student._id },
    {
      $setOnInsert: {
        studentName: student.name,
        studentWalletAddress: studentWallet,
        studentId: student._id,
        institutionId: institution._id,
        studentWalletId: studentWalletDocument._id,
        institutionWalletId: institutionWallet?._id,
        institutionWalletAddress: institution.walletAddress,
        institutionName: institution.name,
      },
      $inc: { totalAllocatedNFTs: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Institution.updateOne(
    { _id: institution._id },
    { $inc: { totalAllocated: 1 } }
  );
  await audit(req, { action: "credential.allocate", scope: "INSTITUTION", targetType: "Credential", targetId: allocation._id, summary: `Issued "${name}" to ${studentWallet}`, details: { ipfsHash } });

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
    .populate("institutionId", "name code walletAddress");

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
        institutionName: unmintedAllocation.institutionId?.name || null,
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
    // A plain id only: an object like {"$ne": null} would act as a query operator.
    if (!mongoose.isValidObjectId(nftId)) {
      throw new AppError("Invalid nftId", 400);
    }
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
  await audit(req, { action: "credential.confirm", scope: "INSTITUTION", institutionId: nft.institutionId, targetType: "Credential", targetId: nft._id, summary: `Student confirmed "${nft.name}"` });

  res.status(200).json({
    success: true,
    message: "NFT details are confirmed",
  });
});

// Pins credential metadata server-side so Pinata keys never reach the browser.
export const pinMetadata = asyncHandler(async (req, res) => {
  const metadata = req.body;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !metadata.name) {
    throw new AppError("Metadata JSON with a name is required", 400);
  }

  if (!process.env.PINATA_API_KEY || !process.env.PINATA_API_SECRET) {
    throw new AppError("IPFS pinning is not configured on the server", 503);
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      pinata_api_key: process.env.PINATA_API_KEY,
      pinata_secret_api_key: process.env.PINATA_API_SECRET,
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    console.error("Pinata pin failed:", response.status, await response.text());
    throw new AppError("Failed to upload metadata to IPFS", 502);
  }

  const { IpfsHash } = await response.json();
  await audit(req, { action: "credential.metadata.pin", scope: "INSTITUTION", targetType: "IPFS", targetId: IpfsHash, summary: `Pinned metadata for "${metadata.name}"` });
  res.status(200).json({ success: true, IpfsHash });
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
    // A plain id only: an object like {"$ne": null} would act as a query operator.
    if (!mongoose.isValidObjectId(nftId)) {
      throw new AppError("Invalid nftId", 400);
    }
    filter._id = nftId;
  }

  const allocation = await NFT.findOne(filter).sort({ allocatedAt: 1 });

  if (!allocation) {
    throw new AppError(
      "Wallet not authorized or NFT already minted/not allocated",
      403
    );
  }

  if (await NFT.exists({ nftAddress: nft_Mint_Address })) {
    throw new AppError("This mint address is already recorded", 409);
  }

  // Never trust the client's word that a mint happened: check the chain.
  try {
    await verifyCredentialMint({
      mintAddress: nft_Mint_Address,
      ownerAddress: wallet.address,
      expectedUri: allocation.uri,
    });
  } catch (error) {
    throw new AppError(`Mint could not be verified: ${error.message}`, 400);
  }

  if (!allocation.studentId && wallet.userId) {
    allocation.studentId = wallet.userId;
  }

  if (!allocation.studentWalletId && wallet._id) {
    allocation.studentWalletId = wallet._id;
  }

  const { institutionId, institutionWalletId } =
    await resolveInstitutionReferences(allocation);

  if (!allocation.institutionId && institutionId) {
    allocation.institutionId = institutionId;
  }

  if (!allocation.institutionWalletId && institutionWalletId) {
    allocation.institutionWalletId = institutionWalletId;
  }

  allocation.nftStatus = "MINTED";
  allocation.minted = true;
  allocation.mintedAt = new Date();
  allocation.nftAddress = nft_Mint_Address;

  await allocation.save();

  if (allocation.institutionId) {
    await Institution.updateOne(
      { _id: allocation.institutionId },
      { $inc: { totalMinted: 1 } }
    );
  }

  if (allocation.institutionId && allocation.studentId) {
    await StudentDetails.updateOne(
      {
        institutionId: allocation.institutionId,
        studentId: allocation.studentId,
      },
      { $inc: { studentTotalMintedNFT: 1 } }
    );
  }

  await audit(req, { action: "credential.mint", scope: "INSTITUTION", institutionId: allocation.institutionId, targetType: "Credential", targetId: allocation._id, summary: `Minted "${allocation.name}" as ${nft_Mint_Address}` });

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
    .populate("institutionId", "name code walletAddress");

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
    institutionName: nft.institutionId?.name || null,
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

  const { institutionId, institutionWalletId } =
    await resolveInstitutionReferences(nft);

  const report = await Reports.create({
    institutionWallet: nft.institutionWallet,
    studentWallet: wallet.address,
    institutionId: institutionId || undefined,
    studentId: nft.studentId || wallet.userId || req.user._id,
    institutionWalletId: institutionWalletId || undefined,
    studentWalletId: nft.studentWalletId || wallet._id || undefined,
    nftIpfsHash,
    reportType,
    reportDetails,
    reportedOn: new Date(),
  });
  await audit(req, { action: "report.create", scope: "INSTITUTION", institutionId: report.institutionId, targetType: "Report", targetId: report._id, summary: `Reported issue "${reportType}" on "${nft.name}"` });

  res.status(201).json({
    success: true,
    message: "Report created successfully",
    report,
  });
});
